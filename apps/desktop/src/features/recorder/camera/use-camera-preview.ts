import { useCallback, useEffect, useRef, useState } from "react"
import { matchDeviceLabel } from "./device-match"

export type CameraPreviewState =
  | "idle"
  | "loading"
  | "active"
  | "empty"
  // The store lists a camera but the browser can't open/match it — the
  // FFmpeg capture may still work, so this is NOT "no camera".
  | "unavailable"
  | "blocked"
  | "in-use"
  | "error"

export interface CameraPreviewSettings {
  width: number
  height: number
  fps: number
}

export interface UseCameraPreviewOptions {
  deviceName: string
  enabled: boolean
}

export interface UseCameraPreview {
  state: CameraPreviewState
  settings: CameraPreviewSettings | null
  // Attach to the <video> node — the latest stream is (re)bound on attach.
  attachVideo: (node: HTMLVideoElement | null) => void
  retry: () => void
  // Stops every track and settles so DirectShow can reopen the device for
  // the real capture — callers must `await` it before starting recording.
  release: () => Promise<void>
}

export function classifyCameraError(error: unknown): CameraPreviewState {
  const name = error instanceof DOMException ? error.name : (error as { name?: string })?.name
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "blocked"
    case "NotReadableError":
    case "TrackStartError":
      return "in-use"
    case "NotFoundError":
    case "OverconstrainedError":
      return "unavailable"
    default:
      return "error"
  }
}

// The preview only needs enough resolution for a ~440 px stage — 720p keeps
// decode cost low; the plan chip (not the feed) communicates recording size.
const PREVIEW_CONSTRAINTS = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 },
}

// Let the OS/driver release the DirectShow device before FFmpeg reopens it.
const RELEASE_SETTLE_MS = 350

export function useCameraPreview({
  deviceName,
  enabled,
}: UseCameraPreviewOptions): UseCameraPreview {
  const [state, setState] = useState<CameraPreviewState>(enabled ? "loading" : "idle")
  const [settings, setSettings] = useState<CameraPreviewSettings | null>(null)
  const [attempt, setAttempt] = useState(0)
  const streamRef = useRef<MediaStream | null>(null)
  const videoNodeRef = useRef<HTMLVideoElement | null>(null)

  const attachVideo = useCallback((node: HTMLVideoElement | null) => {
    videoNodeRef.current = node
    if (node && streamRef.current) {
      node.srcObject = streamRef.current
    }
  }, [])

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (videoNodeRef.current) {
      videoNodeRef.current.srcObject = null
    }
    setSettings(null)
  }, [])

  const release = useCallback(async () => {
    stopStream()
    await new Promise((resolve) => setTimeout(resolve, RELEASE_SETTLE_MS))
  }, [stopStream])

  const retry = useCallback(() => setAttempt((value) => value + 1), [])

  useEffect(() => {
    if (!enabled) {
      setState("idle")
      return
    }
    if (!deviceName.trim()) {
      setState("empty")
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setState("error")
      return
    }

    // StrictMode-safe: every effect run owns and stops its own tracks, and a
    // stale async result is dropped instead of attaching.
    let cancelled = false

    async function start() {
      setState("loading")
      try {
        // Same permission-label bootstrap as the overlay preview: enumerate
        // first, grant once if labels are still hidden, then match by label.
        let devices = await navigator.mediaDevices.enumerateDevices()
        let matched = devices
          .filter((d) => d.kind === "videoinput")
          .find((d) => d.label && matchDeviceLabel(d.label, deviceName))

        if (!matched) {
          const permissionStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          })
          permissionStream.getTracks().forEach((track) => track.stop())

          devices = await navigator.mediaDevices.enumerateDevices()
          matched = devices
            .filter((d) => d.kind === "videoinput")
            .find((d) => d.label && matchDeviceLabel(d.label, deviceName))
        }

        if (!matched) {
          // Never fall back to the default camera — showing the wrong
          // device is worse than showing none. The device exists in the
          // store, so this is "preview can't open it", not "no camera".
          if (!cancelled) setState("unavailable")
          return
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: matched.deviceId }, ...PREVIEW_CONSTRAINTS },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }

        streamRef.current = stream
        if (videoNodeRef.current) {
          videoNodeRef.current.srcObject = stream
        }
        const track = stream.getVideoTracks()[0]
        const actual = track?.getSettings()
        setSettings(
          actual
            ? {
                width: actual.width ?? 0,
                height: actual.height ?? 0,
                fps: Math.round(actual.frameRate ?? 0),
              }
            : null,
        )
        setState("active")
      } catch (error) {
        if (!cancelled) setState(classifyCameraError(error))
      }
    }

    void start()

    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      if (videoNodeRef.current) {
        videoNodeRef.current.srcObject = null
      }
    }
  }, [deviceName, enabled, attempt])

  // A device disappearing mid-session leaves the stream dead — restart.
  useEffect(() => {
    if (!enabled || !navigator.mediaDevices?.addEventListener) return
    const onDeviceChange = () => {
      if (streamRef.current?.getVideoTracks().every((track) => track.readyState === "ended")) {
        setAttempt((value) => value + 1)
      }
    }
    navigator.mediaDevices.addEventListener("devicechange", onDeviceChange)
    return () => navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange)
  }, [enabled])

  return { state, settings, attachVideo, retry, release }
}
