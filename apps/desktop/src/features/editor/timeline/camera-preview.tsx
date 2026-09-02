import { useEffect, useMemo, useRef, useState } from "react"
import type { CameraClip, ClipTransform, MediaVideoTrackOutput } from "@recordforge/contracts"
import { computePreviewMediaSync } from "@recordforge/editor-core"
import { cn } from "@recordforge/ui"
import { Circle, Square } from "lucide-react"
import { toAssetUrl } from "../media/derivative-resources"

interface CameraPreviewProps {
  clips: CameraClip[]
  outputs: MediaVideoTrackOutput[]
  workDir?: string | null
  playheadMs: number
  isPlaying: boolean
  playbackRate: number
  frameMs: number
  canvasWidth: number
  canvasHeight: number
  selectedClipId?: string | null
  onSelectClip?: (clipId: string) => void
  onUpdateTransform?: (
    clipId: string,
    transform: ClipTransform,
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
}

interface CameraGesture {
  clipId: string
  pointerId: number
  mode: "move" | "resize"
  handle?: "nw" | "ne" | "se" | "sw"
  startX: number
  startY: number
  transform: ClipTransform
  moved: boolean
}

function isClipActive(clip: CameraClip, playheadMs: number): boolean {
  return playheadMs >= clip.startMs && playheadMs < clip.startMs + clip.durationMs
}

function mixBorderColor(color: string | undefined, opacity: number | undefined): string {
  const source = color ?? "var(--color-foreground)"
  const alpha = Math.max(0, Math.min(1, opacity ?? 1))
  return `color-mix(in srgb, ${source} ${Math.round(alpha * 100)}%, transparent)`
}

function computeNextCameraTransform(
  gesture: CameraGesture,
  deltaX: number,
  deltaY: number,
  canvasWidth: number,
  _canvasHeight: number,
): ClipTransform {
  if (gesture.mode === "resize") {
    const handle = gesture.handle ?? "se"
    const aspect = gesture.transform.width / Math.max(1, gesture.transform.height)

    if (handle === "se") {
      const scaleDelta = Math.max(deltaX, deltaY * aspect)
      const nextW = Math.max(80, Math.min(canvasWidth, gesture.transform.width + scaleDelta))
      const nextH = Math.round(nextW / aspect)
      return {
        ...gesture.transform,
        width: Math.round(nextW),
        height: nextH,
        preset: undefined,
      }
    }
    if (handle === "nw") {
      const scaleDelta = Math.max(-deltaX, -deltaY * aspect)
      const nextW = Math.max(80, Math.min(canvasWidth, gesture.transform.width + scaleDelta))
      const nextH = Math.round(nextW / aspect)
      const nextX = gesture.transform.x + (gesture.transform.width - nextW)
      const nextY = gesture.transform.y + (gesture.transform.height - nextH)
      return {
        ...gesture.transform,
        x: Math.round(nextX),
        y: Math.round(nextY),
        width: Math.round(nextW),
        height: nextH,
        preset: undefined,
      }
    }
    if (handle === "ne") {
      const scaleDelta = Math.max(deltaX, -deltaY * aspect)
      const nextW = Math.max(80, Math.min(canvasWidth, gesture.transform.width + scaleDelta))
      const nextH = Math.round(nextW / aspect)
      const nextY = gesture.transform.y + (gesture.transform.height - nextH)
      return {
        ...gesture.transform,
        y: Math.round(nextY),
        width: Math.round(nextW),
        height: nextH,
        preset: undefined,
      }
    }
    // "sw"
    const scaleDelta = Math.max(-deltaX, deltaY * aspect)
    const nextW = Math.max(80, Math.min(canvasWidth, gesture.transform.width + scaleDelta))
    const nextH = Math.round(nextW / aspect)
    const nextX = gesture.transform.x + (gesture.transform.width - nextW)
    return {
      ...gesture.transform,
      x: Math.round(nextX),
      width: Math.round(nextW),
      height: nextH,
      preset: undefined,
    }
  }

  return {
    ...gesture.transform,
    x: Math.round(gesture.transform.x + deltaX),
    y: Math.round(gesture.transform.y + deltaY),
    preset: undefined,
    locked: false,
  }
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
  frameMs,
  canvasWidth,
  canvasHeight,
  selectedClipId,
  onSelectClip,
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
      const decision = computePreviewMediaSync({
        kind: "camera",
        clip,
        playheadMs,
        currentTimeMs: video.currentTime * 1000,
        playbackRate,
        isPlaying: isPlaying && clip.transform.visible !== false,
        frameMs,
      })

      if (!isPlaying && decision.shouldSeek) {
        // When paused or scrubbing, ensure frame-accurate sync
        video.currentTime = decision.targetSourceMs / 1000
      } else if (decision.shouldSeek) {
        // Hard desync: seek directly to playhead source position
        video.currentTime = decision.targetSourceMs / 1000
      } else if (decision.shouldPlay && video.paused) {
        video.currentTime = decision.targetSourceMs / 1000
      }
      if (Math.abs(video.playbackRate - decision.playbackRate) > 0.001) {
        // Mild drift (1-3 frames): dynamically nudge playback rate slightly to lock back in sync
        video.playbackRate = decision.playbackRate
      }
      if (decision.shouldPlay) {
        if (video.paused) void video.play().catch(() => undefined)
      } else if (decision.shouldPause) {
        video.pause()
      }
    }
  }, [clips, frameMs, isPlaying, outputsByStream, playheadMs, playbackRate])

  function beginDrag(
    event: React.PointerEvent<HTMLDivElement>,
    clip: CameraClip,
    mode: CameraGesture["mode"] = "move",
    handle?: CameraGesture["handle"],
  ) {
    onSelectClip?.(clip.id)
    if (!onUpdateTransform || event.button !== 0 || clip.transform.locked) return
    event.stopPropagation()
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureRef.current = {
      clipId: clip.id,
      pointerId: event.pointerId,
      mode,
      handle,
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
    const next = computeNextCameraTransform(gesture, dx, dy, canvasWidth, canvasHeight)
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
    const next = computeNextCameraTransform(gesture, dx, dy, canvasWidth, canvasHeight)
    onUpdateTransform(gesture.clipId, next, { phase: "commit" })
  }

  const handleSnapPreset = (clip: CameraClip, position: "TL" | "TR" | "BL" | "BR") => {
    if (!onUpdateTransform) return
    const margin = 32
    const w = clip.transform.width
    const h = clip.transform.height
    let x = margin
    let y = margin
    if (position === "TR") {
      x = canvasWidth - w - margin
    } else if (position === "BL") {
      y = canvasHeight - h - margin
    } else if (position === "BR") {
      x = canvasWidth - w - margin
      y = canvasHeight - h - margin
    }
    onUpdateTransform(
      clip.id,
      {
        ...clip.transform,
        x: Math.max(0, x),
        y: Math.max(0, y),
        preset: undefined,
      },
      { phase: "commit" },
    )
  }

  const handleSetShape = (clip: CameraClip, shape: "circle" | "rounded" | "rectangle") => {
    if (!onUpdateTransform) return
    onUpdateTransform(
      clip.id,
      {
        ...clip.transform,
        shape,
      },
      { phase: "commit" },
    )
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
        const isSelected = selectedClipId === clip.id
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
            tabIndex={isActive ? 0 : -1}
            aria-label={
              isLocked ? "Camera overlay, select to edit" : "Camera overlay, drag to move or resize"
            }
            aria-disabled={false}
            className={cn(
              "group absolute z-30 overflow-visible",
              isActive && (isLocked ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"),
              "focus-visible:outline-none",
            )}
            style={{
              left: `${(transform.x / canvasWidth) * 100}%`,
              top: `${(transform.y / canvasHeight) * 100}%`,
              width: `${(transform.width / canvasWidth) * 100}%`,
              height: `${(transform.height / canvasHeight) * 100}%`,
              opacity: isActive ? transform.opacity : 0,
              pointerEvents: isActive ? "auto" : "none",
            }}
            onClick={() => onSelectClip?.(clip.id)}
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
            onPointerDown={(event) => beginDrag(event, clip, "move")}
            onPointerMove={moveDrag}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
          >
            {/* Camera Video Surface */}
            <div
              className="relative size-full overflow-hidden"
              style={{
                borderRadius: radius,
                border: transform.borderWidth
                  ? `${transform.borderWidth}px solid ${borderColor}`
                  : undefined,
                boxShadow: transform.shadowEnabled
                  ? `${transform.shadowOffsetX ?? 0}px ${transform.shadowOffsetY ?? 4}px ${transform.shadowBlur ?? 12}px ${transform.shadowColor ?? "var(--color-pip-shadow)"}`
                  : undefined,
              }}
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

            {/* Selection Ring & On-Canvas Direct Manipulation Handles */}
            {isSelected && (
              <div className="pointer-events-none absolute inset-0 rounded-[inherit] ring-2 ring-primary ring-offset-1 ring-offset-background/40" />
            )}

            {isSelected && !isLocked && onUpdateTransform ? (
              <>
                {/* 4 Corner Resize Handles */}
                <div
                  role="button"
                  tabIndex={0}
                  aria-label="Resize camera northwest"
                  className="absolute -top-1.5 -left-1.5 z-40 size-3 cursor-nwse-resize rounded-full border-2 border-primary bg-background shadow-e2"
                  onPointerDown={(e) => beginDrag(e, clip, "resize", "nw")}
                  onClick={(e) => e.stopPropagation()}
                />
                <div
                  role="button"
                  tabIndex={0}
                  aria-label="Resize camera northeast"
                  className="absolute -top-1.5 -right-1.5 z-40 size-3 cursor-nesw-resize rounded-full border-2 border-primary bg-background shadow-e2"
                  onPointerDown={(e) => beginDrag(e, clip, "resize", "ne")}
                  onClick={(e) => e.stopPropagation()}
                />
                <div
                  role="button"
                  tabIndex={0}
                  aria-label="Resize camera southwest"
                  className="absolute -bottom-1.5 -left-1.5 z-40 size-3 cursor-nesw-resize rounded-full border-2 border-primary bg-background shadow-e2"
                  onPointerDown={(e) => beginDrag(e, clip, "resize", "sw")}
                  onClick={(e) => e.stopPropagation()}
                />
                <div
                  role="button"
                  tabIndex={0}
                  aria-label="Resize camera southeast"
                  className="absolute -bottom-1.5 -right-1.5 z-40 size-3 cursor-nwse-resize rounded-full border-2 border-primary bg-background shadow-e2"
                  onPointerDown={(e) => beginDrag(e, clip, "resize", "se")}
                  onClick={(e) => e.stopPropagation()}
                />

                {/* Floating Direct Action Toolbar */}
                <div
                  className="absolute -top-8 left-1/2 -translate-x-1/2 z-40 flex items-center gap-1 rounded-full border border-border/80 bg-background/90 px-2 py-0.5 shadow-e3 backdrop-blur-md"
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {/* Shape Switchers */}
                  <button
                    type="button"
                    title="Circle Shape"
                    aria-label="Circle Shape"
                    onClick={() => handleSetShape(clip, "circle")}
                    className={cn(
                      "flex size-5 items-center justify-center rounded transition-colors",
                      transform.shape === "circle"
                        ? "bg-primary text-primary-foreground font-bold"
                        : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
                    )}
                  >
                    <Circle className="size-2.5" aria-hidden />
                  </button>
                  <button
                    type="button"
                    title="Rounded Shape"
                    aria-label="Rounded Shape"
                    onClick={() => handleSetShape(clip, "rounded")}
                    className={cn(
                      "flex size-5 items-center justify-center rounded transition-colors",
                      transform.shape === "rounded"
                        ? "bg-primary text-primary-foreground font-bold"
                        : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
                    )}
                  >
                    <Square className="size-2.5 rounded-xs" aria-hidden />
                  </button>
                  <button
                    type="button"
                    title="Rectangle Shape"
                    aria-label="Rectangle Shape"
                    onClick={() => handleSetShape(clip, "rectangle")}
                    className={cn(
                      "flex size-5 items-center justify-center rounded transition-colors",
                      transform.shape === "rectangle"
                        ? "bg-primary text-primary-foreground font-bold"
                        : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
                    )}
                  >
                    <Square className="size-2.5" aria-hidden />
                  </button>

                  <div className="h-3 w-px bg-border/80 mx-0.5" aria-hidden />

                  {/* Corner Snap Buttons */}
                  <button
                    type="button"
                    title="Snap Top-Left"
                    onClick={() => handleSnapPreset(clip, "TL")}
                    className="px-1 py-0.5 font-mono text-[9px] font-semibold text-muted-foreground hover:bg-surface-hover hover:text-foreground rounded"
                  >
                    TL
                  </button>
                  <button
                    type="button"
                    title="Snap Top-Right"
                    onClick={() => handleSnapPreset(clip, "TR")}
                    className="px-1 py-0.5 font-mono text-[9px] font-semibold text-muted-foreground hover:bg-surface-hover hover:text-foreground rounded"
                  >
                    TR
                  </button>
                  <button
                    type="button"
                    title="Snap Bottom-Left"
                    onClick={() => handleSnapPreset(clip, "BL")}
                    className="px-1 py-0.5 font-mono text-[9px] font-semibold text-muted-foreground hover:bg-surface-hover hover:text-foreground rounded"
                  >
                    BL
                  </button>
                  <button
                    type="button"
                    title="Snap Bottom-Right"
                    onClick={() => handleSnapPreset(clip, "BR")}
                    className="px-1 py-0.5 font-mono text-[9px] font-semibold text-muted-foreground hover:bg-surface-hover hover:text-foreground rounded"
                  >
                    BR
                  </button>
                </div>
              </>
            ) : null}
          </div>
        )
      })}
    </>
  )
}
