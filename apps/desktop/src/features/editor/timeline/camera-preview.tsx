import { useEffect, useMemo, useRef, useState } from "react"
import type { CameraClip, ClipTransform, MediaVideoTrackOutput } from "@recordforge/contracts"
import { cn } from "@recordforge/ui"
import { toAssetUrl } from "../media/derivative-resources"

interface CameraPreviewProps {
  clips: CameraClip[]
  outputs: MediaVideoTrackOutput[]
  workDir?: string | null
  playheadMs: number
  isPlaying: boolean
  playbackRate: number
  canvasWidth: number
  canvasHeight: number
  onUpdateTransform?: (
    clipId: string,
    transform: ClipTransform,
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
}

interface CameraGesture {
  clipId: string
  pointerId: number
  startX: number
  startY: number
  transform: ClipTransform
  moved: boolean
}

function isClipActive(clip: CameraClip, playheadMs: number): boolean {
  return playheadMs >= clip.startMs && playheadMs < clip.startMs + clip.durationMs
}

// Apply the user-controlled border opacity to a solid color. This keeps the
// color picker showing an opaque swatch while the preview respects opacity.
function mixBorderColor(color: string | undefined, opacity: number | undefined): string {
  const source = color ?? "var(--color-foreground)"
  const alpha = Math.max(0, Math.min(1, opacity ?? 1))
  return `color-mix(in srgb, ${source} ${Math.round(alpha * 100)}%, transparent)`
}

/**
 * Camera preview uses prepared per-stream derivatives. The same timeline clock
 * drives each element, so camera visibility, trim, and speed match export.
 */
export function CameraPreview({
  clips,
  outputs,
  workDir,
  playheadMs,
  isPlaying,
  playbackRate,
  canvasWidth,
  canvasHeight,
  onUpdateTransform,
}: CameraPreviewProps) {
  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({})
  const gestureRef = useRef<CameraGesture | null>(null)
  const [loadedDimensions, setLoadedDimensions] = useState<
    Record<string, { width: number; height: number }>
  >({})
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
    if (!onUpdateTransform || event.button !== 0 || clip.transform.locked) return
    event.stopPropagation()
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureRef.current = {
      clipId: clip.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      transform: clip.transform,
      moved: false,
    }
  }

  function moveDrag(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId || !onUpdateTransform) return
    const canvasElement = event.currentTarget.parentElement
    const dx =
      ((event.clientX - gesture.startX) / Math.max(1, canvasElement?.clientWidth ?? 1)) *
      canvasWidth
    const dy =
      ((event.clientY - gesture.startY) / Math.max(1, canvasElement?.clientHeight ?? 1)) *
      canvasHeight
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && !gesture.moved) return
    gesture.moved = true
    event.preventDefault()
    const next: ClipTransform = {
      ...gesture.transform,
      x: gesture.transform.x + dx,
      y: gesture.transform.y + dy,
      preset: undefined,
      locked: false,
    }
    onUpdateTransform(gesture.clipId, next, { phase: "draft" })
  }

  function finishDrag(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const wasCancelled = event.type === "pointercancel"
    const didMove = gesture.moved
    gestureRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!onUpdateTransform) return

    if (wasCancelled || !didMove) {
      onUpdateTransform(gesture.clipId, gesture.transform, { phase: "cancel" })
      return
    }

    const canvasElement = event.currentTarget.parentElement
    const dx =
      ((event.clientX - gesture.startX) / Math.max(1, canvasElement?.clientWidth ?? 1)) *
      canvasWidth
    const dy =
      ((event.clientY - gesture.startY) / Math.max(1, canvasElement?.clientHeight ?? 1)) *
      canvasHeight
    const next: ClipTransform = {
      ...gesture.transform,
      x: gesture.transform.x + dx,
      y: gesture.transform.y + dy,
      preset: undefined,
      locked: false,
    }
    onUpdateTransform(gesture.clipId, next, { phase: "commit" })
  }

  return (
    <>
      {clips.map((clip) => {
        const output = outputsByStream.get(clip.streamIndex ?? -1)
        const source = output ? toAssetUrl(output.videoPath, workDir) : null
        const transform = clip.transform
        if (!source || transform.visible === false) return null
        const isActive = isClipActive(clip, playheadMs)
        const isLocked = transform.locked === true
        const radius =
          transform.shape === "circle" ? "50%" : transform.shape === "rounded" ? "12%" : 0
        const crop = transform.crop
        const natural = loadedDimensions[clip.id]
        const sourceWidth = output?.width ?? natural?.width ?? crop?.width ?? canvasWidth
        const sourceHeight = output?.height ?? natural?.height ?? crop?.height ?? canvasHeight
        const cropWidth = crop?.width ?? sourceWidth
        const cropHeight = crop?.height ?? sourceHeight
        const cropLeft = crop ? -(crop.x / cropWidth) * 100 : 0
        const cropTop = crop ? -(crop.y / cropHeight) * 100 : 0
        const cropVideoWidth = crop ? (sourceWidth / cropWidth) * 100 : 100
        const cropVideoHeight = crop ? (sourceHeight / cropHeight) * 100 : 100
        const borderColor = mixBorderColor(transform.borderColor, transform.borderOpacity)
        return (
          <div
            key={clip.id}
            role="button"
            tabIndex={isActive && !isLocked ? 0 : -1}
            aria-label={isLocked ? "Camera overlay, locked" : "Camera overlay, drag to move"}
            aria-disabled={isLocked}
            className={cn(
              "absolute z-10 overflow-hidden",
              !isLocked && onUpdateTransform && isActive && "cursor-grab active:cursor-grabbing",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
            )}
            style={{
              left: `${(transform.x / canvasWidth) * 100}%`,
              top: `${(transform.y / canvasHeight) * 100}%`,
              width: `${(transform.width / canvasWidth) * 100}%`,
              height: `${(transform.height / canvasHeight) * 100}%`,
              opacity: isActive ? transform.opacity : 0,
              borderRadius: radius,
              border: transform.borderWidth
                ? `${transform.borderWidth}px solid ${borderColor}`
                : undefined,
              boxShadow: transform.shadowEnabled
                ? `${transform.shadowOffsetX ?? 0}px ${transform.shadowOffsetY ?? 4}px ${transform.shadowBlur ?? 12}px ${transform.shadowColor ?? "var(--color-pip-shadow)"}`
                : undefined,
              pointerEvents: onUpdateTransform && isActive && !isLocked ? "auto" : "none",
            }}
            onKeyDown={(event) => {
              if (!onUpdateTransform || isLocked || gestureRef.current) return
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
              onUpdateTransform(
                clip.id,
                {
                  ...transform,
                  x: transform.x + delta.x,
                  y: transform.y + delta.y,
                  preset: undefined,
                  locked: false,
                },
                { phase: "commit" },
              )
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
              className={cn(
                "pointer-events-none absolute max-h-none max-w-none",
                crop ? "object-fill" : "object-cover",
              )}
              style={{
                left: `${cropLeft}%`,
                top: `${cropTop}%`,
                width: `${cropVideoWidth}%`,
                height: `${cropVideoHeight}%`,
              }}
              onLoadedMetadata={(event) => {
                const target = event.currentTarget
                if (target.videoWidth > 0 && target.videoHeight > 0) {
                  setLoadedDimensions((previous) => {
                    const current = previous[clip.id]
                    if (
                      current &&
                      current.width === target.videoWidth &&
                      current.height === target.videoHeight
                    ) {
                      return previous
                    }
                    return {
                      ...previous,
                      [clip.id]: {
                        width: target.videoWidth,
                        height: target.videoHeight,
                      },
                    }
                  })
                }
              }}
            />
          </div>
        )
      })}
    </>
  )
}
