import type {
  CanvasAspectRatio,
  ManualZoomSegment,
  TimelineCanvas,
  TimelineState,
  ZoomTarget,
} from "@recordforge/contracts"
import { canonicalizeZoomTarget } from "@recordforge/cursor-core"

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
  if (aspectRatio === "4:3") return 4 / 3
  if (aspectRatio === "21:9") return 21 / 9
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
  if (easing === "snappy") return 1 - (1 - value) ** 3
  if (easing === "cinematic") return value * value * (3 - 2 * value)
  if (easing === "spring") {
    // Damped harmonic oscillation with a bounded output so high zoom factors
    // cannot produce a negative crop during an overshoot.
    const p = 0.4
    const spring = Math.pow(2, -10 * value) * Math.sin(((value - p / 4) * (2 * Math.PI)) / p) + 1
    return Math.min(1, Math.max(0, spring))
  }
  if (easing === "smooth") {
    // Quintic smootherstep: 6t^5 - 15t^4 + 10t^3 (0 velocity and 0 acceleration at endpoints)
    return value * value * value * (value * (value * 6 - 15) + 10)
  }
  // Default ease-in-out: smooth cubic Hermite
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
 * Find the immediately preceding active zoom segment, if any, within a bridge threshold.
 */
export function findPreviousZoomSegment(
  state: TimelineState,
  currentSegment: ManualZoomSegment,
  maxBridgeGapMs = 500,
): ManualZoomSegment | null {
  const segments = getManualZoomSegments(state)
    .filter(
      (s) =>
        s.enabled &&
        s.id !== currentSegment.id &&
        s.startMs + s.durationMs <= currentSegment.startMs,
    )
    .sort((a, b) => b.startMs + b.durationMs - (a.startMs + a.durationMs))

  const prev = segments[0] ?? null
  if (!prev) return null
  const gap = currentSegment.startMs - (prev.startMs + prev.durationMs)
  return gap <= maxBridgeGapMs ? prev : null
}

/**
 * Resolve the visual crop at a timeline time.
 *
 * Implements a 3-phase lifecycle (Transition In -> Hold/Follow -> Transition Out)
 * with continuous velocity easing curves matching Screen Studio.
 * When a previous adjacent zoom exists, it seamlessly pans directly between focal points.
 */
export interface ZoomTransformOptions {
  target?: ZoomTarget
  /** Override transition in duration in milliseconds. */
  transitionInMs?: number
  /** Override transition out duration in milliseconds. */
  transitionOutMs?: number
  /** Optional previous zoom target to pan from seamlessly without returning to 1x. */
  fromTarget?: ZoomTarget | null
  /** Optional previous zoom scale. */
  fromScale?: number | null
}

export function resolveZoomTransform(
  segment: ManualZoomSegment,
  timeMs: number,
  canvas: Pick<TimelineCanvas, "width" | "height" | "padding">,
  options: ZoomTransformOptions = {},
): ZoomTransform {
  const target = canonicalizeZoomTarget(options.target ?? segment.target, canvas, segment.scale)
  const duration = Math.max(1, segment.durationMs)

  const declaredIn =
    options.transitionInMs ??
    segment.transitionInMs ??
    Math.min(450, Math.max(60, Math.round(duration * 0.3)))
  const declaredOut =
    options.transitionOutMs ??
    segment.transitionOutMs ??
    Math.min(450, Math.max(60, Math.round(duration * 0.3)))

  let transitionInMs = Math.min(duration, declaredIn)
  let transitionOutMs = Math.min(duration, declaredOut)
  if (transitionInMs + transitionOutMs > duration) {
    transitionInMs = Math.round(duration / 2)
    transitionOutMs = duration - transitionInMs
  }

  const elapsed = timeMs - segment.startMs
  let progress = 0
  let isPannedFromPrevious = false

  if (elapsed <= 0) {
    progress = transitionInMs === 0 ? 1 : 0
    if (options.fromTarget && progress < 1) {
      isPannedFromPrevious = true
    }
  } else if (elapsed < transitionInMs) {
    // Phase 1: Smooth ease in or continuous pan from previous segment
    const rawProgress = elapsed / Math.max(1, transitionInMs)
    progress = zoomEasedProgress(rawProgress, segment.easing)
    if (options.fromTarget) {
      isPannedFromPrevious = true
    }
  } else if (elapsed <= duration - transitionOutMs) {
    // Phase 2: Sustain / active cursor follow hold
    progress = 1
  } else if (elapsed <= duration) {
    // Phase 3: Smooth ease out back to full screen
    const remaining = duration - elapsed
    const rawProgress = Math.max(0, remaining / Math.max(1, transitionOutMs))
    progress = zoomEasedProgress(rawProgress, segment.easing)
  } else {
    progress = 0
  }

  const fullCenterX = canvas.width / 2
  const fullCenterY = canvas.height / 2
  const targetCenterX = target.x + target.width / 2
  const targetCenterY = target.y + target.height / 2

  let cropWidth: number
  let cropHeight: number
  let currentCenterX: number
  let currentCenterY: number

  if (isPannedFromPrevious && options.fromTarget) {
    const fromTarget = canonicalizeZoomTarget(options.fromTarget, canvas, options.fromScale ?? 1)
    const fromCenterX = fromTarget.x + fromTarget.width / 2
    const fromCenterY = fromTarget.y + fromTarget.height / 2

    cropWidth = fromTarget.width + (target.width - fromTarget.width) * progress
    cropHeight = fromTarget.height + (target.height - fromTarget.height) * progress
    currentCenterX = fromCenterX + (targetCenterX - fromCenterX) * progress
    currentCenterY = fromCenterY + (targetCenterY - fromCenterY) * progress
  } else {
    cropWidth = canvas.width + (target.width - canvas.width) * progress
    cropHeight = canvas.height + (target.height - canvas.height) * progress
    currentCenterX = fullCenterX + (targetCenterX - fullCenterX) * progress
    currentCenterY = fullCenterY + (targetCenterY - fullCenterY) * progress
  }

  const cropX = Math.min(Math.max(0, currentCenterX - cropWidth / 2), canvas.width - cropWidth)
  const cropY = Math.min(Math.max(0, currentCenterY - cropHeight / 2), canvas.height - cropHeight)

  const scale = canvas.width / Math.max(1, cropWidth)
  const effectiveCenterX = cropX + cropWidth / 2
  const effectiveCenterY = cropY + cropHeight / 2

  return {
    progress,
    scale,
    translateX: fullCenterX - effectiveCenterX,
    translateY: fullCenterY - effectiveCenterY,
    crop: {
      x: cropX,
      y: cropY,
      width: cropWidth,
      height: cropHeight,
    },
  }
}

export function canvasShadowStyle(
  canvas: Pick<
    TimelineCanvas,
    "shadow" | "shadowColor" | "shadowBlur" | "shadowOffsetX" | "shadowOffsetY"
  >,
  scale: number = 1,
): string | undefined {
  if (!canvas.shadow) return undefined
  const color = canvas.shadowColor ?? DEFAULT_SHADOW_COLOR
  const blur = Math.max(0, (canvas.shadowBlur ?? DEFAULT_SHADOW_BLUR) * scale)
  const offsetX = (canvas.shadowOffsetX ?? 0) * scale
  const offsetY = (canvas.shadowOffsetY ?? 8) * scale
  return `${offsetX}px ${offsetY}px ${blur}px ${color}`
}
