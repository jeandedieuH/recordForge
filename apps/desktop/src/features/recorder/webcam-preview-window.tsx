import { useCallback, useEffect, useRef, useState } from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { listen } from "@tauri-apps/api/event"
import {
  AlertTriangle,
  Camera,
  Check,
  FlipHorizontal2,
  GripVertical,
  Loader2,
  RefreshCw,
  VideoOff,
  X,
} from "lucide-react"
import { Button } from "@recordforge/ui"
import { isTauri } from "../../lib/settings"
import {
  useRecorderPolling,
  useRecorderStatusEvents,
  useRecorderStore,
} from "../../hooks/use-recorder"

interface InjectedWebcamParams {
  deviceId?: string
  deviceName?: string
  previewUrl?: string
}

declare global {
  interface Window {
    __RECORD_FORGE_WEBCAM_PARAMS?: InjectedWebcamParams
  }
}

// Clean camera labels for robust fuzzy comparison against DirectShow names
function cleanDeviceName(name: string): string {
  return name
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s*\[[^\]]*\]\s*/g, " ")
    .replace(/@device[^\s]+/g, "")
    .trim()
    .toLowerCase()
}

// Match DirectShow / FFmpeg device names with browser MediaDeviceInfo labels
function findMatchingCamera(
  devices: MediaDeviceInfo[],
  requestedName: string,
): MediaDeviceInfo | null {
  if (!devices.length) return null
  if (!requestedName || !requestedName.trim()) return devices[0]

  const trimmed = requestedName.trim()
  const lowerReq = trimmed.toLowerCase()

  // 1. Exact deviceId match
  const byId = devices.find((d) => d.deviceId === trimmed)
  if (byId) return byId

  // 2. Exact label match
  const byExactLabel = devices.find((d) => d.label.trim().toLowerCase() === lowerReq)
  if (byExactLabel) return byExactLabel

  // 3. Substring match
  const bySubstring = devices.find((d) => {
    const label = d.label.trim().toLowerCase()
    return label.includes(lowerReq) || lowerReq.includes(label)
  })
  if (bySubstring) return bySubstring

  // 4. Clean base name match (removes trailing USB IDs like "(0c45:6a09)")
  const cleanReq = cleanDeviceName(trimmed)
  if (cleanReq) {
    const byClean = devices.find((d) => {
      const cleanLabel = cleanDeviceName(d.label)
      return (
        cleanLabel === cleanReq || cleanLabel.includes(cleanReq) || cleanReq.includes(cleanLabel)
      )
    })
    if (byClean) return byClean
  }

  return null
}

function getStoredWebcamPreference(): { webcamId?: string; webcamName?: string } {
  try {
    if (typeof localStorage === "undefined") return {}
    const raw = localStorage.getItem("recordforge:recordingPreferences")
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return {
      webcamId: parsed.webcamId || undefined,
      webcamName: parsed.webcamName || undefined,
    }
  } catch {
    return {}
  }
}

// Dedicated floating square rounded camera card shown during screen recording.
// Provides native drag handle, active video playback, direct camera switching,
// disconnection detection, and frame delivery monitoring to detect freezing.
export function WebcamPreviewWindow() {
  useRecorderPolling()
  useRecorderStatusEvents()

  const { status, preferences } = useRecorderStore()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const retryCountRef = useRef(0)

  const [availableCameras, setAvailableCameras] = useState<MediaDeviceInfo[]>([])
  const [userSelectedDeviceId, setUserSelectedDeviceId] = useState<string>("")
  const [activeDeviceId, setActiveDeviceId] = useState<string>("")
  const [activeCameraLabel, setActiveCameraLabel] = useState<string>("")
  const [streamState, setStreamState] = useState<"connecting" | "active" | "disconnected">(
    "connecting",
  )
  const [isLagging, setIsLagging] = useState(false)
  const [isMirrored, setIsMirrored] = useState(true)
  const [retryNonce, setRetryNonce] = useState(0)
  const [cameraPickerOpen, setCameraPickerOpen] = useState(false)

  const [injectedParams, setInjectedParams] = useState<InjectedWebcamParams | null>(
    typeof window !== "undefined" ? window.__RECORD_FORGE_WEBCAM_PARAMS || null : null,
  )

  // Listen for dynamic device change events dispatched by Rust when window is reused
  useEffect(() => {
    const handleDeviceChange = (e: Event) => {
      const customEvent = e as CustomEvent<InjectedWebcamParams>
      if (customEvent.detail) {
        setInjectedParams(customEvent.detail)
        setUserSelectedDeviceId("") // Reset manual switch so new recording's device takes effect
        retryCountRef.current = 0
        setStreamState("connecting")
        setRetryNonce((n) => n + 1)
      }
    }
    window.addEventListener("recordforge-webcam-device-changed", handleDeviceChange)
    return () => {
      window.removeEventListener("recordforge-webcam-device-changed", handleDeviceChange)
    }
  }, [])

  // Close the window completely and release all camera hardware locks
  const handleClose = useCallback(async () => {
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop())
        streamRef.current = null
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null
      }
      if (isTauri()) {
        await getCurrentWindow().close()
      }
    } catch (err) {
      console.error("Failed to close preview window", err)
      try {
        await getCurrentWindow().hide()
      } catch {
        // Suppress secondary error
      }
    }
  }, [])

  // Auto-close preview window when recording concludes or fails
  useEffect(() => {
    if (
      status &&
      status.state !== "recording" &&
      status.state !== "paused" &&
      status.state !== "countdown"
    ) {
      void handleClose()
    }
  }, [status, handleClose])

  // Also listen for recording-completed event to close immediately
  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | undefined
    listen("recording-completed", () => {
      void handleClose()
    }).then((fn) => {
      unlisten = fn
    })
    return () => {
      unlisten?.()
    }
  }, [handleClose])

  // Native window drag handler (restricted to grip handle)
  function handleDragStart(e: React.MouseEvent) {
    if (e.button === 0 && isTauri()) {
      void getCurrentWindow().startDragging()
    }
  }

  // Bind video element to the acquired stream
  const setVideoNode = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node
    if (node && streamRef.current) {
      node.srcObject = streamRef.current
    }
  }, [])

  // Determine requested camera identifier
  const storedPrefs = getStoredWebcamPreference()
  const activePreviewUrl = injectedParams?.previewUrl || status?.webcamPreviewUrl || ""
  const imageSrc = activePreviewUrl
    ? `${activePreviewUrl}${activePreviewUrl.includes("?") ? "&" : "?"}_t=${retryNonce}`
    : ""

  const targetCameraIdentifier =
    userSelectedDeviceId ||
    injectedParams?.deviceName ||
    injectedParams?.deviceId ||
    storedPrefs.webcamName ||
    storedPrefs.webcamId ||
    status?.webcamDeviceName ||
    status?.webcamDeviceId ||
    preferences.webcamName ||
    preferences.webcamId ||
    ""

  // Fallback timer: ensure streamState transitions to "active" once frames are flowing,
  // in case the browser doesn't dispatch standard onLoad for multipart streams.
  useEffect(() => {
    if (!activePreviewUrl) return
    const timer = setTimeout(() => {
      setStreamState((prev) => (prev === "connecting" ? "active" : prev))
    }, 1500)
    return () => clearTimeout(timer)
  }, [activePreviewUrl, retryNonce])

  // Acquire camera stream with permission handshake, retry logic, and NO silent fallback
  useEffect(() => {
    if (activePreviewUrl) {
      const label =
        injectedParams?.deviceName ||
        status?.webcamDeviceName ||
        injectedParams?.deviceId ||
        status?.webcamDeviceId ||
        "Recording Camera"
      setActiveCameraLabel(label)
      return
    }

    // Safety guard: if recording is active or starting with webcam enabled,
    // do NOT call getUserMedia. Windows DirectShow lock prevents dual opening.
    if (
      status?.webcamActive ||
      status?.state === "recording" ||
      status?.state === "countdown" ||
      status?.state === "paused"
    ) {
      setStreamState("connecting")
      const label =
        injectedParams?.deviceName ||
        status?.webcamDeviceName ||
        injectedParams?.deviceId ||
        status?.webcamDeviceId ||
        "Recording Camera"
      setActiveCameraLabel(label)
      return
    }

    let cancelled = false

    async function initializeCamera() {
      if (
        activePreviewUrl ||
        status?.webcamActive ||
        status?.state === "recording" ||
        status?.state === "countdown" ||
        status?.state === "paused"
      ) {
        return
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        setStreamState("disconnected")
        return
      }

      setStreamState("connecting")
      setIsLagging(false)

      try {
        // Enumerate devices to check if permission/labels already exist
        let devices = await navigator.mediaDevices.enumerateDevices()
        let videoInputs = devices.filter((d) => d.kind === "videoinput")

        // If labels are blank, request permission to expose hardware device labels
        if (videoInputs.length > 0 && !videoInputs[0].label) {
          try {
            const tempStream = await navigator.mediaDevices.getUserMedia({
              video: true,
              audio: false,
            })
            tempStream.getTracks().forEach((t) => t.stop())
            // Give driver brief moment to release before re-enumerating
            await new Promise((resolve) => setTimeout(resolve, 150))
            devices = await navigator.mediaDevices.enumerateDevices()
            videoInputs = devices.filter((d) => d.kind === "videoinput")
          } catch {
            // Permission request failed or camera in use
          }
        }

        if (cancelled) return

        setAvailableCameras(videoInputs)

        // Resolve target camera
        let targetDevice: MediaDeviceInfo | null = null
        if (userSelectedDeviceId) {
          targetDevice = videoInputs.find((d) => d.deviceId === userSelectedDeviceId) || null
        }
        if (!targetDevice && targetCameraIdentifier) {
          targetDevice = findMatchingCamera(videoInputs, targetCameraIdentifier)
        }
        if (!targetDevice && videoInputs.length > 0) {
          targetDevice = videoInputs[0]
        }

        if (!targetDevice) {
          setStreamState("disconnected")
          setActiveCameraLabel(targetCameraIdentifier || "No camera detected")
          return
        }

        // Attempt to open the specific target device.
        // Retry up to 3 times (with 300ms delay) to handle transient driver busy states
        // when FFmpeg is starting or after stopping a temporary permission stream.
        let acquiredStream: MediaStream | null = null
        let lastError: unknown = null

        for (let attempt = 1; attempt <= 3; attempt++) {
          if (cancelled) return
          try {
            const constraints: MediaStreamConstraints = {
              video: targetDevice.deviceId ? { deviceId: { exact: targetDevice.deviceId } } : true,
              audio: false,
            }
            acquiredStream = await navigator.mediaDevices.getUserMedia(constraints)
            break
          } catch (err) {
            lastError = err
            console.warn(
              `Camera "${targetDevice.label || targetDevice.deviceId}" attempt ${attempt} failed:`,
              err,
            )
            if (attempt < 3) {
              await new Promise((resolve) => setTimeout(resolve, 300))
            }
          }
        }

        if (cancelled) {
          acquiredStream?.getTracks().forEach((t) => t.stop())
          return
        }

        if (!acquiredStream) {
          console.error("Could not acquire target camera stream:", lastError)
          setStreamState("disconnected")
          setActiveCameraLabel(targetDevice.label || targetCameraIdentifier || "Camera in use")
          return
        }

        // Clean up any existing stream
        streamRef.current?.getTracks().forEach((t) => t.stop())
        streamRef.current = acquiredStream

        if (videoRef.current) {
          videoRef.current.srcObject = acquiredStream
        }

        setActiveCameraLabel(targetDevice.label || "Camera Active")
        setActiveDeviceId(targetDevice.deviceId)

        // Track stream hardware lifecycle
        const videoTrack = acquiredStream.getVideoTracks()[0]
        if (videoTrack) {
          videoTrack.onended = () => {
            if (!cancelled) setStreamState("disconnected")
          }
          videoTrack.onmute = () => {
            if (!cancelled) setIsLagging(true)
          }
          videoTrack.onunmute = () => {
            if (!cancelled) setIsLagging(false)
          }
        }

        setStreamState("active")
      } catch (err) {
        console.error("Failed to initialize camera stream", err)
        if (!cancelled) {
          setStreamState("disconnected")
        }
      }
    }

    void initializeCamera()

    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      if (videoRef.current) {
        videoRef.current.srcObject = null
      }
    }
  }, [
    activePreviewUrl,
    targetCameraIdentifier,
    userSelectedDeviceId,
    retryNonce,
    injectedParams?.deviceId,
    injectedParams?.deviceName,
    status?.webcamDeviceId,
    status?.webcamDeviceName,
    status?.webcamActive,
    status?.state,
  ])

  // Frame delivery monitor to detect frozen or severely lagging camera feeds
  useEffect(() => {
    if (streamState !== "active" || activePreviewUrl) return

    let frameCallbackId: number | null = null
    let lastFrameTime = performance.now()
    let checkInterval: ReturnType<typeof setInterval> | null = null
    const video = videoRef.current

    if (!video) return

    if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
      const onFrame = () => {
        lastFrameTime = performance.now()
        setIsLagging(false)
        frameCallbackId = video.requestVideoFrameCallback(onFrame)
      }
      frameCallbackId = video.requestVideoFrameCallback(onFrame)

      checkInterval = setInterval(() => {
        if (performance.now() - lastFrameTime > 1500) {
          setIsLagging(true)
        }
      }, 800)
    } else {
      let lastCurrentTime = video.currentTime
      checkInterval = setInterval(() => {
        if (video.currentTime === lastCurrentTime && !video.paused) {
          setIsLagging(true)
        } else {
          setIsLagging(false)
        }
        lastCurrentTime = video.currentTime
      }, 1000)
    }

    return () => {
      if (frameCallbackId !== null && "cancelVideoFrameCallback" in video) {
        video.cancelVideoFrameCallback(frameCallbackId)
      }
      if (checkInterval) clearInterval(checkInterval)
    }
  }, [streamState, activePreviewUrl])

  return (
    <div className="flex h-screen w-screen items-center justify-center p-2 select-none overflow-hidden bg-transparent">
      {/* Square Rounded Card */}
      <div
        className="group relative flex size-51 flex-col overflow-hidden rounded-2xl border border-border-strong/90 bg-surface/95 shadow-[0_8px_24px_rgba(0,0,0,0.5)] backdrop-blur-md"
        role="region"
        aria-label="Webcam Recording Preview"
      >
        {/* Video or Live Stream feed container */}
        <div className="relative h-full w-full overflow-hidden bg-black/40">
          {activePreviewUrl ? (
            <img
              key={imageSrc}
              src={imageSrc}
              alt="Live webcam feed"
              className={`h-full w-full object-cover transition-transform duration-200 ${
                isMirrored ? "-scale-x-100" : ""
              } ${streamState === "active" ? "opacity-100" : "opacity-0"}`}
              onLoad={() => {
                retryCountRef.current = 0
                setStreamState("active")
                setIsLagging(false)
              }}
              onError={() => {
                // If connection fails (e.g. FFmpeg is still initializing), retry automatically up to 4 times with backoff
                if (retryCountRef.current < 4) {
                  retryCountRef.current += 1
                  setTimeout(() => {
                    setRetryNonce((n) => n + 1)
                  }, 400)
                } else {
                  setStreamState("disconnected")
                }
              }}
            />
          ) : (
            <video
              ref={setVideoNode}
              autoPlay
              playsInline
              muted
              className={`h-full w-full object-cover transition-transform duration-200 ${
                isMirrored ? "-scale-x-100" : ""
              } ${streamState === "active" ? "opacity-100" : "opacity-0"}`}
            />
          )}

          {/* Connecting / Loading state */}
          {streamState === "connecting" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface/90 text-muted-foreground">
              <Loader2 className="size-6 animate-spin text-primary" />
              <span className="text-[11px] font-medium">Connecting camera…</span>
            </div>
          )}

          {/* Disconnected / In-Use State */}
          {streamState === "disconnected" && (
            <div
              className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-surface/95 p-2.5 text-center"
              data-tauri-drag-region="false"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="flex size-8 items-center justify-center rounded-xl border border-destructive/30 bg-destructive/10 text-destructive">
                <VideoOff className="size-4" />
              </div>
              <span className="text-xs font-semibold text-foreground">
                {activePreviewUrl ? "Connecting Feed…" : "Camera Unavailable"}
              </span>
              <span
                className="text-[10px] text-muted-foreground leading-tight px-1 truncate max-w-45"
                title={activeCameraLabel}
              >
                {activeCameraLabel ||
                  (activePreviewUrl
                    ? "Awaiting live recording feed"
                    : "Feed unavailable or in use")}
              </span>

              <div className="flex items-center gap-1.5 mt-1">
                {!activePreviewUrl && availableCameras.length > 1 && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-6 text-[11px] px-2 cursor-pointer"
                    onClick={() => setCameraPickerOpen(true)}
                  >
                    <Camera className="mr-1 size-3" />
                    Switch
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-6 text-[11px] px-2.5 cursor-pointer"
                  onClick={() => {
                    retryCountRef.current = 0
                    setStreamState("connecting")
                    setRetryNonce((n) => n + 1)
                  }}
                >
                  <RefreshCw className="mr-1 size-3" />
                  Retry
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Top Header Overlay with Drag Handle & Controls */}
        <div className="absolute inset-x-0 top-0 flex h-9 items-center justify-between bg-linear-to-b from-black/75 via-black/40 to-transparent px-2 transition-opacity duration-200">
          {/* Drag grip handle + status indicator — ONLY this area is the drag region */}
          <div
            data-tauri-drag-region
            onMouseDown={handleDragStart}
            className="flex cursor-grab active:cursor-grabbing items-center gap-1.5 py-1 pr-2"
            title="Drag to reposition camera preview"
          >
            <div
              data-tauri-drag-region
              className="text-white/70 hover:text-white pointer-events-none"
              aria-hidden
            >
              <GripVertical className="size-3.5" />
            </div>

            {streamState === "active" && (
              <div
                data-tauri-drag-region
                className="flex items-center gap-1 rounded-full bg-black/50 px-1.5 py-0.5 backdrop-blur-sm pointer-events-none"
              >
                <span
                  className={`size-1.5 rounded-full ${
                    isLagging
                      ? "bg-warning animate-pulse"
                      : activePreviewUrl
                        ? "bg-rose-500 animate-pulse"
                        : "bg-emerald-400 animate-pulse"
                  }`}
                />
                <span className="text-[9px] font-semibold tracking-wider uppercase text-white/90">
                  {isLagging ? "Lag" : activePreviewUrl ? "Rec" : "Live"}
                </span>
              </div>
            )}
          </div>

          {/* Action buttons: Camera selector + Mirror toggle + Close button */}
          {/* data-tauri-drag-region="false" and onMouseDown stopPropagation prevent startDragging() interception */}
          <div
            data-tauri-drag-region="false"
            onMouseDown={(e) => e.stopPropagation()}
            className="flex items-center gap-1"
          >
            {/* Camera switch menu button (when multiple cameras available and NOT recording) */}
            {!activePreviewUrl && availableCameras.length > 1 && (
              <button
                type="button"
                className={`flex size-6 cursor-pointer items-center justify-center rounded-md text-white/80 backdrop-blur-sm transition-colors ${
                  cameraPickerOpen
                    ? "bg-primary text-white"
                    : "bg-black/40 hover:bg-black/70 hover:text-white"
                }`}
                title="Switch camera device"
                aria-label="Switch camera device"
                onClick={(e) => {
                  e.stopPropagation()
                  setCameraPickerOpen((o) => !o)
                }}
              >
                <Camera className="size-3" />
              </button>
            )}

            {/* Mirror View Toggle */}
            <button
              type="button"
              className="flex size-6 cursor-pointer items-center justify-center rounded-md bg-black/40 text-white/80 backdrop-blur-sm transition-colors hover:bg-black/70 hover:text-white"
              title={isMirrored ? "Disable mirror view" : "Enable mirror view"}
              aria-label="Toggle camera mirroring"
              onClick={(e) => {
                e.stopPropagation()
                setIsMirrored((m) => !m)
              }}
            >
              <FlipHorizontal2 className="size-3" />
            </button>

            {/* Direct Close Window Button */}
            <button
              type="button"
              className="flex size-6 cursor-pointer items-center justify-center rounded-md bg-black/40 text-white/80 backdrop-blur-sm transition-colors hover:bg-destructive hover:text-white"
              title="Close camera preview"
              aria-label="Close camera preview"
              onClick={(e) => {
                e.stopPropagation()
                void handleClose()
              }}
            >
              <X className="size-3" />
            </button>
          </div>
        </div>

        {/* Camera Switcher Modal Overlay inside the card */}
        {cameraPickerOpen && (
          <div
            className="absolute inset-0 z-50 flex flex-col rounded-2xl bg-surface/95 p-2.5 backdrop-blur-md animate-in fade-in-0 duration-150 border border-border-strong"
            data-tauri-drag-region="false"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-1.5 border-b border-border/50">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
                <Camera className="size-3.5 text-primary" />
                <span>Switch Camera</span>
              </div>
              <button
                type="button"
                className="flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:text-foreground"
                onClick={() => setCameraPickerOpen(false)}
                aria-label="Close camera switcher"
              >
                <X className="size-3" />
              </button>
            </div>

            <div className="mt-1.5 flex-1 overflow-y-auto flex flex-col gap-1 pr-0.5">
              {availableCameras.map((cam, idx) => {
                const isCurrent = cam.deviceId === activeDeviceId
                return (
                  <button
                    key={cam.deviceId || idx}
                    type="button"
                    className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[11px] transition-colors cursor-pointer ${
                      isCurrent
                        ? "bg-primary/20 text-primary font-medium border border-primary/30"
                        : "text-foreground hover:bg-overlay"
                    }`}
                    onClick={() => {
                      setUserSelectedDeviceId(cam.deviceId)
                      setCameraPickerOpen(false)
                      setRetryNonce((n) => n + 1)
                    }}
                  >
                    <span className="truncate pr-1">{cam.label || `Camera ${idx + 1}`}</span>
                    {isCurrent && <Check className="size-3 shrink-0 text-primary" />}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Freezing / Lagging Warning Banner */}
        {isLagging && streamState === "active" && (
          <div className="absolute inset-x-2 bottom-2 z-10 flex items-center gap-1.5 rounded-lg border border-warning/40 bg-warning/20 px-2 py-1 text-warning backdrop-blur-md">
            <AlertTriangle className="size-3 shrink-0" />
            <span className="text-[10px] font-medium leading-none truncate">
              Camera feed lagging
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
