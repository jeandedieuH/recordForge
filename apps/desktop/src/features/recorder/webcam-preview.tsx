import { useCallback, useEffect, useRef, useState } from "react"
import { Video } from "lucide-react"

interface WebcamPreviewProps {
  deviceName: string
}

export function WebcamPreview({ deviceName }: WebcamPreviewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [state, setState] = useState<"loading" | "active" | "error">("loading")

  const setVideoNode = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node
    if (node && streamRef.current) {
      node.srcObject = streamRef.current
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function startPreview() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setState("error")
        return
      }

      try {
        // Enumerate first; if labels are already available the user has
        // granted camera access to this origin before.
        const devices = await navigator.mediaDevices.enumerateDevices()
        const videoDevices = devices.filter((d) => d.kind === "videoinput")
        let matched = videoDevices.find(
          (d) => d.label && matchDeviceName(d.label, deviceName),
        )

        if (!matched) {
          // No labels yet, so request one-time permission to reveal them.
          const permissionStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          })
          permissionStream.getTracks().forEach((t) => t.stop())

          const labeledDevices = await navigator.mediaDevices.enumerateDevices()
          const labeledVideoDevices = labeledDevices.filter(
            (d) => d.kind === "videoinput",
          )
          matched = labeledVideoDevices.find(
            (d) => d.label && matchDeviceName(d.label, deviceName),
          )
        }

        if (!matched) {
          // The selected camera is not exposed to the browser (or its label
          // does not match). Do not fall back to the default camera to avoid
          // showing the wrong preview.
          setState("error")
          return
        }

        const constraints: MediaStreamConstraints = {
          video: { deviceId: { exact: matched.deviceId } },
          audio: false,
        }

        const nextStream = await navigator.mediaDevices.getUserMedia(constraints)
        if (cancelled) {
          nextStream.getTracks().forEach((t) => t.stop())
          return
        }

        streamRef.current = nextStream
        if (videoRef.current) {
          videoRef.current.srcObject = nextStream
        }
        setState("active")
      } catch {
        setState("error")
      }
    }

    void startPreview()

    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      if (videoRef.current) {
        videoRef.current.srcObject = null
      }
    }
  }, [deviceName])

  return (
    <div className="relative h-full w-full">
      {state === "active" ? (
        <video
          ref={setVideoNode}
          autoPlay
          playsInline
          muted
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <Video className="size-8 text-subtle-foreground" />
        </div>
      )}
    </div>
  )
}

function matchDeviceName(label: string, requestedName: string): boolean {
  if (!label || !requestedName) return false

  const a = label.trim().toLowerCase()
  const b = requestedName.trim().toLowerCase()

  if (a === b) return true
  if (a.includes(b) || b.includes(a)) return true

  // DirectShow devices sometimes expose a trailing USB id in parentheses.
  // Web browser labels may contain an extra "(046d:0825)" style suffix.
  const aBase = a.replace(/\s*\([^)]*\)\s*$/, "").trim()
  const bBase = b.replace(/\s*\([^)]*\)\s*$/, "").trim()

  return (
    aBase === bBase || aBase.includes(bBase) || bBase.includes(aBase)
  )
}
