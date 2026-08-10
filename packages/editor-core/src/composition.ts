import type {
  CanvasAspectRatio,
  ManualZoomSegment,
  TimelineCanvas,
  TimelineState,
  ZoomTarget,
} from "@recordforge/contracts"
import { clampZoomTarget } from "@recordforge/cursor-core"

/**
 * Keep an effect target inside the usable canvas. This is shared by the
 * command engine, preview, and export plan so an off-canvas drag cannot create
 * a transform that only one renderer understands.
 */
export { clampZoomTarget } from "@recordforge/cursor-core"

export interface CanvasSize {
  width: number
  height: number
}

export interface CanvasRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ZoomTransform {
  progress: number
  scale: number
  translateX: number
  translateY: number
  crop: CanvasRect
}

const DEFAULT_SHADOW_COLOR = "#000000"
const DEFAULT_SHADOW_BLUR = 24

/** Return a stable numeric aspect ratio for a framing preset. */
export function aspectRatioValue(aspectRatio: CanvasAspectRatio | undefined): number | null {
  if (aspectRatio === "16:9") return 16 / 9
  if (aspectRatio === "1:1") return 1
  if (aspectRatio === "9:16") return 9 / 16
  return null
}

/** Fit a requested framing preset while preserving the supplied output area. */
export function canvasSizeForAspectRatio(
  aspectRatio: CanvasAspectRatio,
  current: CanvasSize,
): CanvasSize {
  const ratio = aspectRatioValue(aspectRatio)
  if (!ratio || current.width <= 0 || current.height <= 0) return current

  if (current.width / current.height >= ratio) {
    return { width: Math.max(1, Math.round(current.height * ratio)), height: current.height }
  }
  return { width: current.width, height: Math.max(1, Math.round(current.width / ratio)) }
}

export function zoomEasedProgress(progress: number, easing: ManualZoomSegment["easing"]): number {
  const value = Math.min(1, Math.max(0, progress))
  if (easing === "linear") return value
  if (easing === "ease-in") return value * value
  if (easing === "ease-out") return 1 - (1 - value) ** 2
  if (easing === "snappy") return value < 0.5 ? 4 * value ** 3 : 1 - (-2 * value + 2) ** 3 / 2
  if (easing === "cinematic") return value * value * (3 - 2 * value)
  return value < 0.5 ? 2 * value * value : 1 - (-2 * value + 2) ** 2 / 2
}

export function getManualZoomSegments(state: TimelineState): ManualZoomSegment[] {
  return state.zoomSegments ?? []
}

export function findManualZoomAtTime(
  state: TimelineState,
  timeMs: number,
): ManualZoomSegment | null {
  return (
    getManualZoomSegments(state)
      .filter(
        (segment) =>
          segment.enabled &&
          timeMs >= segment.startMs &&
          timeMs < segment.startMs + segment.durationMs,
      )
      .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))
      .slice(-1)[0] ?? null
  )
}

/**
 * Resolve the visual crop at a timeline time. The returned crop is a source
 * rectangle in canvas coordinates, while translation/scale are convenient for
 * a DOM compositor using a canvas-centered transform origin.
 */
export interface ZoomTransformOptions {
  target?: ZoomTarget
}

export function resolveZoomTransform(
  segment: ManualZoomSegment,
  timeMs: number,
  canvas: Pick<TimelineCanvas, "width" | "height" | "padding">,
  options: ZoomTransformOptions = {},
): ZoomTransform {
  const target = clampZoomTarget(options.target ?? segment.target, canvas)
  const duration = Math.max(1, segment.durationMs)
  const progress = zoomEasedProgress((timeMs - segment.startMs) / duration, segment.easing)
  const full: CanvasRect = { x: 0, y: 0, width: canvas.width, height: canvas.height }
  const crop = {
    x: full.x + (target.x - full.x) * progress,
    y: full.y + (target.y - full.y) * progress,
    width: full.width + (target.width - full.width) * progress,
    height: full.height + (target.height - full.height) * progress,
  }
  const scaleAtTarget = Math.max(canvas.width / target.width, canvas.height / target.height)
  const scale = 1 + (Math.max(1, scaleAtTarget * segment.scale) - 1) * progress
  const targetCenterX = target.x + target.width / 2
  const targetCenterY = target.y + target.height / 2
  return {
    progress,
    scale,
    translateX: (canvas.width / 2 - targetCenterX) * (scale - 1),
    translateY: (canvas.height / 2 - targetCenterY) * (scale - 1),
    crop,
  }
}

export function canvasShadowStyle(
  canvas: Pick<
    TimelineCanvas,
    "shadow" | "shadowColor" | "shadowBlur" | "shadowOffsetX" | "shadowOffsetY"
  >,
): string | undefined {
  if (!canvas.shadow) return undefined
  const color = canvas.shadowColor ?? DEFAULT_SHADOW_COLOR
  const blur = Math.max(0, canvas.shadowBlur ?? DEFAULT_SHADOW_BLUR)
  const offsetX = canvas.shadowOffsetX ?? 0
  const offsetY = canvas.shadowOffsetY ?? 8
  return `${offsetX}px ${offsetY}px ${blur}px ${color}`
}
