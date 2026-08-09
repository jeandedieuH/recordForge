import { useEffect, useMemo, useRef } from "react"
import type { CameraClip, ClipTransform, MediaVideoTrackOutput } from "@recordforge/contracts"
import { toAssetUrl } from "../media/derivative-resources"

interface CameraPreviewProps {
  clips: CameraClip[]
  outputs: MediaVideoTrackOutput[]
  playheadMs: number
  isPlaying: boolean
  playbackRate: number
  canvasWidth: number
  canvasHeight: number
  onUpdateTransform?: (clipId: string, transform: ClipTransform) => void
}

interface CameraGesture {
  clipId: string
  pointerId: number
  startX: number
  startY: number
  transform: ClipTransform
}

function isClipActive(clip: CameraClip, playheadMs: number): boolean {
  return playheadMs >= clip.startMs && playheadMs < clip.startMs + clip.durationMs
}

/**
 * Camera preview uses prepared per-stream derivatives. The same timeline clock
 * drives each element, so camera visibility, trim, and speed match export.
 */
export function CameraPreview({
  clips,
  outputs,
  playheadMs,
  isPlaying,
  playbackRate,
  canvasWidth,
  canvasHeight,
  onUpdateTransform,
}: CameraPreviewProps) {
  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({})
  const gestureRef = useRef<CameraGesture | null>(null)
  const outputsByStream = useMemo(
    () => new Map(outputs.map((output) => [output.streamIndex, output])),
    [outputs],
  )

  useEffect(() => {
    for (const clip of clips) {
      const video = videoRefs.current[clip.id]
      const output = outputsByStream.get(clip.streamIndex ?? -1)
      if (!video || !output) continue
      const sourceMs = clip.sourceInMs + (playheadMs - clip.startMs) * clip.speed
      if (Math.abs(video.currentTime * 1000 - sourceMs) > 80) video.currentTime = sourceMs / 1000
      video.playbackRate = Math.max(0.25, Math.min(4, playbackRate * clip.speed))
      const isActive = isClipActive(clip, playheadMs) && clip.transform.visible !== false
      if (isPlaying && isActive) void video.play().catch(() => undefined)
      else video.pause()
    }
  }, [clips, isPlaying, outputsByStream, playheadMs, playbackRate])

  function beginDrag(event: React.PointerEvent<HTMLDivElement>, clip: CameraClip) {
    if (!onUpdateTransform || event.button !== 0) return
    event.stopPropagation()
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureRef.current = {
      clipId: clip.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      transform: clip.transform,
    }
  }

  function moveDrag(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId || !onUpdateTransform) return
    const canvasElement = event.currentTarget.parentElement
    const next = {
      ...gesture.transform,
      x:
        gesture.transform.x +
        ((event.clientX - gesture.startX) / Math.max(1, canvasElement?.clientWidth ?? 1)) *
          canvasWidth,
      y:
        gesture.transform.y +
        ((event.clientY - gesture.startY) / Math.max(1, canvasElement?.clientHeight ?? 1)) *
          canvasHeight,
    }
    onUpdateTransform(gesture.clipId, next)
  }

  function finishDrag(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    gestureRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <>
      {clips.map((clip) => {
        const output = outputsByStream.get(clip.streamIndex ?? -1)
        const source = output ? toAssetUrl(output.videoPath) : null
        const transform = clip.transform
        if (!source || transform.visible === false) return null
        const isActive = isClipActive(clip, playheadMs)
        const radius =
          transform.shape === "circle" ? "50%" : transform.shape === "rounded" ? "12%" : 0
        const crop = transform.crop
        const sourceWidth = output?.width ?? canvasWidth
        const sourceHeight = output?.height ?? canvasHeight
        const cropWidth = crop?.width ?? sourceWidth
        const cropHeight = crop?.height ?? sourceHeight
        const cropLeft = crop ? -(crop.x / cropWidth) * 100 : 0
        const cropTop = crop ? -(crop.y / cropHeight) * 100 : 0
        const cropVideoWidth = crop ? (sourceWidth / cropWidth) * 100 : 100
        const cropVideoHeight = crop ? (sourceHeight / cropHeight) * 100 : 100
        return (
          <div
            key={clip.id}
            role="button"
            tabIndex={isActive ? 0 : -1}
            aria-label="Camera preview"
            className="absolute z-10 overflow-hidden"
            style={{
              left: `${(transform.x / canvasWidth) * 100}%`,
              top: `${(transform.y / canvasHeight) * 100}%`,
              width: `${(transform.width / canvasWidth) * 100}%`,
              height: `${(transform.height / canvasHeight) * 100}%`,
              opacity: isActive ? transform.opacity : 0,
              borderRadius: radius,
              border: transform.borderWidth
                ? `${transform.borderWidth}px solid ${transform.borderColor ?? "currentColor"}`
                : undefined,
              borderColor: transform.borderColor,
              boxShadow: transform.shadowEnabled
                ? `${transform.shadowOffsetX ?? 0}px ${transform.shadowOffsetY ?? 4}px ${transform.shadowBlur ?? 12}px ${transform.shadowColor ?? "black"}`
                : undefined,
              pointerEvents: onUpdateTransform && isActive ? "auto" : "none",
            }}
            onKeyDown={(event) => {
              if (!onUpdateTransform) return
              const step = event.shiftKey ? 10 : 1
              const delta =
                event.key === "ArrowLeft"
                  ? { x: -step, y: 0 }
                  : event.key === "ArrowRight"
                    ? { x: step, y: 0 }
                    : event.key === "ArrowUp"
                      ? { x: 0, y: -step }
                      : event.key === "ArrowDown"
                        ? { x: 0, y: step }
                        : null
              if (!delta) return
              event.preventDefault()
              onUpdateTransform(clip.id, {
                ...transform,
                x: transform.x + delta.x,
                y: transform.y + delta.y,
              })
            }}
            onPointerDown={(event) => beginDrag(event, clip)}
            onPointerMove={moveDrag}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
          >
            <video
              ref={(element) => {
                videoRefs.current[clip.id] = element
              }}
              src={source}
              muted
              playsInline
              preload="auto"
              className="absolute object-fill"
              style={{
                left: `${cropLeft}%`,
                top: `${cropTop}%`,
                width: `${cropVideoWidth}%`,
                height: `${cropVideoHeight}%`,
              }}
            />
          </div>
        )
      })}
    </>
  )
}
