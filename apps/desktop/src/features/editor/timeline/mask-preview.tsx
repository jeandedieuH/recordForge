import { useCallback, useEffect, useRef, type MutableRefObject } from "react"
import type { MaskClip, MaskRect } from "@recordforge/contracts"
import { renderMasksToCanvas } from "../canvas/mask-shader-renderer"

type WebGLBundle = NonNullable<Parameters<typeof renderMasksToCanvas>[4]["current"]>

export interface MaskVideoBounds {
  left: number
  top: number
  width: number
  height: number
  scale: number
}

interface MaskPreviewProps {
  clips: MaskClip[]
  playheadMs: number
  canvasWidth: number
  canvasHeight: number
  videoElement?: HTMLVideoElement | null
  videoBounds?: MaskVideoBounds | null
  selectedClipId?: string | null
  useShaderOptimization?: boolean
  onSelectMask?: (clip: MaskClip) => void
  onUpdateMask?: (
    clipId: string,
    rect: MaskRect,
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
}

interface MaskGesture {
  clipId: string
  pointerId: number
  mode: "move" | "resize"
  handle?: "nw" | "ne" | "se" | "sw"
  startX: number
  startY: number
  rect: MaskRect
  moved: boolean
}

export function isActive(clip: MaskClip, playheadMs: number): boolean {
  return clip.enabled && playheadMs >= clip.startMs && playheadMs < clip.startMs + clip.durationMs
}

export function clampRect(rect: MaskRect, canvasWidth: number, canvasHeight: number): MaskRect {
  const width = Math.round(Math.min(Math.max(1, rect.width), canvasWidth))
  const height = Math.round(Math.min(Math.max(1, rect.height), canvasHeight))
  return {
    x: Math.round(Math.min(Math.max(0, rect.x), Math.max(0, canvasWidth - width))),
    y: Math.round(Math.min(Math.max(0, rect.y), Math.max(0, canvasHeight - height))),
    width,
    height,
  }
}

export function computeNextMaskRect(
  gesture: MaskGesture,
  deltaX: number,
  deltaY: number,
): MaskRect {
  const dx = Math.round(deltaX)
  const dy = Math.round(deltaY)

  if (gesture.mode === "resize") {
    const handle = gesture.handle ?? "se"
    if (handle === "se") {
      return {
        ...gesture.rect,
        width: Math.max(20, gesture.rect.width + dx),
        height: Math.max(20, gesture.rect.height + dy),
      }
    }
    if (handle === "nw") {
      const nextW = Math.max(20, gesture.rect.width - dx)
      const nextH = Math.max(20, gesture.rect.height - dy)
      return {
        x: gesture.rect.x + (gesture.rect.width - nextW),
        y: gesture.rect.y + (gesture.rect.height - nextH),
        width: nextW,
        height: nextH,
      }
    }
    if (handle === "ne") {
      const nextW = Math.max(20, gesture.rect.width + dx)
      const nextH = Math.max(20, gesture.rect.height - dy)
      return {
        x: gesture.rect.x,
        y: gesture.rect.y + (gesture.rect.height - nextH),
        width: nextW,
        height: nextH,
      }
    }
    // "sw"
    const nextW = Math.max(20, gesture.rect.width - dx)
    const nextH = Math.max(20, gesture.rect.height + dy)
    return {
      x: gesture.rect.x + (gesture.rect.width - nextW),
      y: gesture.rect.y,
      width: nextW,
      height: nextH,
    }
  }

  return {
    ...gesture.rect,
    x: gesture.rect.x + dx,
    y: gesture.rect.y + dy,
  }
}

export function resolveRedactColor(color: string | undefined): string {
  const lower = color?.trim().toLowerCase()
  if (!lower || lower === "black") return "#000000"
  if (lower === "white") return "#ffffff"
  if (lower === "red") return "#ef4444"
  if (lower === "blue") return "#3b82f6"
  if (lower === "green") return "#10b981"
  if (lower === "yellow") return "#f59e0b"
  if (lower === "gray" || lower === "grey") return "#6b7280"
  return color!
}

export function maskFallbackVisual(clip: MaskClip): React.CSSProperties {
  if (clip.mode === "redact") {
    return {
      backgroundColor: resolveRedactColor(clip.redactColor),
      opacity: 1,
    }
  }
  if (clip.mode === "pixelate") {
    // Canvas handles pixelation; fallback to backdrop blur if canvas is unsupported
    return {
      backdropFilter: `blur(${Math.max(4, (clip.pixelSize ?? 12) / 2)}px)`,
      WebkitBackdropFilter: `blur(${Math.max(4, (clip.pixelSize ?? 12) / 2)}px)`,
    }
  }
  // Blur: pure Gaussian blur without dark tint overlay to achieve parity with export gblur
  return {
    backdropFilter: `blur(${clip.blurRadius ?? 24}px)`,
    WebkitBackdropFilter: `blur(${clip.blurRadius ?? 24}px)`,
  }
}

interface PixelateMaskVisualProps {
  clip: MaskClip
  rect: MaskRect
  canvasWidth: number
  canvasHeight: number
  videoElement?: HTMLVideoElement | null
  videoBounds?: MaskVideoBounds | null
  playheadMs: number
}

/**
 * Renders a true nearest-neighbor downscaled & upscaled mosaic inside the mask rectangle,
 * reproducing the exact same scale=w/pixelSize:flags=neighbor pipeline as FFmpeg export.
 */
function PixelateMaskVisual({
  clip,
  rect,
  canvasWidth,
  canvasHeight,
  videoElement,
  videoBounds,
  playheadMs,
}: PixelateMaskVisualProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current
    const video = videoElement
    if (!canvas || !video || video.readyState < 2 || video.videoWidth === 0) return

    const pixelSize = Math.max(2, clip.pixelSize ?? 12)
    const smallW = Math.max(1, Math.floor(rect.width / pixelSize))
    const smallH = Math.max(1, Math.floor(rect.height / pixelSize))

    if (canvas.width !== smallW || canvas.height !== smallH) {
      canvas.width = smallW
      canvas.height = smallH
    }

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    // Position of video in canvas coordinate space
    let vLeft = 0
    let vTop = 0
    let vWidth = canvasWidth
    let vHeight = canvasHeight

    if (videoBounds && videoBounds.scale > 0 && video.parentElement) {
      const parentWidth = video.parentElement.clientWidth
      const scale = parentWidth / canvasWidth
      if (scale > 0) {
        vLeft = videoBounds.left / scale
        vTop = videoBounds.top / scale
        vWidth = videoBounds.width / scale
        vHeight = videoBounds.height / scale
      }
    }

    // Intersect mask rect with video rect
    const ix1 = Math.max(rect.x, vLeft)
    const iy1 = Math.max(rect.y, vTop)
    const ix2 = Math.min(rect.x + rect.width, vLeft + vWidth)
    const iy2 = Math.min(rect.y + rect.height, vTop + vHeight)

    if (ix2 <= ix1 || iy2 <= iy1) {
      ctx.clearRect(0, 0, smallW, smallH)
      return
    }

    // Coordinates in source video element
    const sx = ((ix1 - vLeft) / vWidth) * video.videoWidth
    const sy = ((iy1 - vTop) / vHeight) * video.videoHeight
    const sWidth = ((ix2 - ix1) / vWidth) * video.videoWidth
    const sHeight = ((iy2 - iy1) / vHeight) * video.videoHeight

    // Coordinates on downsampled canvas
    const dx = ((ix1 - rect.x) / rect.width) * smallW
    const dy = ((iy1 - rect.y) / rect.height) * smallH
    const dWidth = ((ix2 - ix1) / rect.width) * smallW
    const dHeight = ((iy2 - iy1) / rect.height) * smallH

    ctx.imageSmoothingEnabled = false
    ctx.drawImage(video, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight)
  }, [
    canvasHeight,
    canvasWidth,
    clip.pixelSize,
    rect.height,
    rect.width,
    rect.x,
    rect.y,
    videoBounds,
    videoElement,
  ])

  // Draw on playhead change or geometry update
  useEffect(() => {
    drawFrame()
  }, [drawFrame, playheadMs])

  // Also update continuously during video playback
  useEffect(() => {
    const video = videoElement
    if (!video) return

    const handleTimeUpdate = () => {
      drawFrame()
    }

    video.addEventListener("timeupdate", handleTimeUpdate)
    video.addEventListener("seeked", handleTimeUpdate)
    return () => {
      video.removeEventListener("timeupdate", handleTimeUpdate)
      video.removeEventListener("seeked", handleTimeUpdate)
    }
  }, [drawFrame, videoElement])

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 size-full"
      style={{
        imageRendering: "pixelated",
        width: "100%",
        height: "100%",
      }}
    />
  )
}

export function MaskPreview({
  clips,
  playheadMs,
  canvasWidth,
  canvasHeight,
  videoElement,
  videoBounds,
  selectedClipId,
  useShaderOptimization = false,
  onSelectMask,
  onUpdateMask,
}: MaskPreviewProps) {
  const gestureRef = useRef<MaskGesture | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const webglBundleRef = useRef<WebGLBundle | null>(null) as MutableRefObject<WebGLBundle | null>

  // Render hardware-accelerated WebGL / Canvas2D shaders onto the canvas layer if requested
  useEffect(() => {
    if (!useShaderOptimization || !canvasRef.current) return

    const canvas = canvasRef.current
    if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
      canvas.width = canvasWidth
      canvas.height = canvasHeight
    }

    renderMasksToCanvas(
      canvas,
      videoElement ?? null,
      clips,
      {
        canvasWidth,
        canvasHeight,
        playheadMs,
        preferWebGL: true,
      },
      webglBundleRef,
    )
  }, [clips, playheadMs, canvasWidth, canvasHeight, videoElement, useShaderOptimization])

  function beginGesture(
    event: React.PointerEvent<HTMLDivElement>,
    clip: MaskClip,
    mode: MaskGesture["mode"],
    handle?: MaskGesture["handle"],
  ) {
    onSelectMask?.(clip)
    if (!onUpdateMask || event.button !== 0 || !isActive(clip, playheadMs)) return
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
      rect: clip.rect,
      moved: false,
    }
  }

  function moveGesture(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId || !onUpdateMask) return
    const parent = event.currentTarget.parentElement
    if (!parent) return
    const deltaX =
      ((event.clientX - gesture.startX) / Math.max(1, parent.clientWidth)) * canvasWidth
    const deltaY =
      ((event.clientY - gesture.startY) / Math.max(1, parent.clientHeight)) * canvasHeight
    if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1 && !gesture.moved) return
    gesture.moved = true
    event.preventDefault()
    const next = computeNextMaskRect(gesture, deltaX, deltaY)
    onUpdateMask(gesture.clipId, clampRect(next, canvasWidth, canvasHeight), { phase: "draft" })
  }

  function finishGesture(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const wasCancelled = event.type === "pointercancel"
    const didMove = gesture.moved
    gestureRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!onUpdateMask) return

    if (wasCancelled || !didMove) {
      onUpdateMask(gesture.clipId, gesture.rect, { phase: "cancel" })
      return
    }

    const parent = event.currentTarget.parentElement
    if (!parent) return
    const deltaX =
      ((event.clientX - gesture.startX) / Math.max(1, parent.clientWidth)) * canvasWidth
    const deltaY =
      ((event.clientY - gesture.startY) / Math.max(1, parent.clientHeight)) * canvasHeight
    const next = computeNextMaskRect(gesture, deltaX, deltaY)
    onUpdateMask(gesture.clipId, clampRect(next, canvasWidth, canvasHeight), { phase: "commit" })
  }

  return (
    <>
      {useShaderOptimization ? (
        <canvas
          ref={canvasRef}
          className="pointer-events-none absolute inset-0 size-full z-28"
          style={{ width: "100%", height: "100%" }}
        />
      ) : null}

      {clips.map((clip) => {
        const active = isActive(clip, playheadMs)
        const rect = clampRect(clip.rect, canvasWidth, canvasHeight)
        const isSelected = selectedClipId === clip.id
        const visualStyle = useShaderOptimization
          ? {
              backgroundColor: "transparent",
              backdropFilter: "none",
            }
          : maskFallbackVisual(clip)

        return (
          <div
            key={clip.id}
            role="button"
            tabIndex={active ? 0 : -1}
            aria-label={`${clip.mode} privacy mask`}
            className={`group absolute z-30 overflow-visible rounded-sm outline-none transition-[border-color] ${
              isSelected
                ? "border border-warning ring-1 ring-warning/50 shadow-e2"
                : "border border-transparent hover:border-warning/50"
            }`}
            style={{
              left: `${(rect.x / canvasWidth) * 100}%`,
              top: `${(rect.y / canvasHeight) * 100}%`,
              width: `${(rect.width / canvasWidth) * 100}%`,
              height: `${(rect.height / canvasHeight) * 100}%`,
              ...visualStyle,
              opacity: active ? 1 : 0,
              pointerEvents: active && onUpdateMask ? "auto" : "none",
            }}
            onClick={(event) => {
              event.stopPropagation()
              onSelectMask?.(clip)
            }}
            onPointerDown={(event) => beginGesture(event, clip, "move")}
            onPointerMove={moveGesture}
            onPointerUp={finishGesture}
            onPointerCancel={finishGesture}
          >
            {/* Live pixelation canvas */}
            {clip.mode === "pixelate" && !useShaderOptimization && active ? (
              <PixelateMaskVisual
                clip={clip}
                rect={rect}
                canvasWidth={canvasWidth}
                canvasHeight={canvasHeight}
                videoElement={videoElement}
                videoBounds={videoBounds}
                playheadMs={playheadMs}
              />
            ) : null}

            {/* Selection chrome: only visible when the mask is selected */}
            {active && onUpdateMask && isSelected ? (
              <>
                {/* Mode badge */}
                <div className="pointer-events-none absolute -top-5 left-0 z-40 rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider bg-warning text-black shadow-e1">
                  {clip.mode}
                </div>

                {/* 4 Corner resize handles */}
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={`Resize ${clip.mode} mask northwest`}
                  className="absolute -top-1.5 -left-1.5 size-3 cursor-nwse-resize rounded-sm border border-warning bg-warning shadow-e2"
                  onPointerDown={(event) => beginGesture(event, clip, "resize", "nw")}
                  onClick={(event) => event.stopPropagation()}
                />
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={`Resize ${clip.mode} mask northeast`}
                  className="absolute -top-1.5 -right-1.5 size-3 cursor-nesw-resize rounded-sm border border-warning bg-warning shadow-e2"
                  onPointerDown={(event) => beginGesture(event, clip, "resize", "ne")}
                  onClick={(event) => event.stopPropagation()}
                />
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={`Resize ${clip.mode} mask southwest`}
                  className="absolute -bottom-1.5 -left-1.5 size-3 cursor-nesw-resize rounded-sm border border-warning bg-warning shadow-e2"
                  onPointerDown={(event) => beginGesture(event, clip, "resize", "sw")}
                  onClick={(event) => event.stopPropagation()}
                />
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={`Resize ${clip.mode} mask southeast`}
                  className="absolute -bottom-1.5 -right-1.5 size-3 cursor-nwse-resize rounded-sm border border-warning bg-warning shadow-e2"
                  onPointerDown={(event) => beginGesture(event, clip, "resize", "se")}
                  onClick={(event) => event.stopPropagation()}
                />
              </>
            ) : null}
          </div>
        )
      })}
    </>
  )
}
