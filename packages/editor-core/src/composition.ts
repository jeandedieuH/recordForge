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

function springRaw(progress: number): number {
  return 1 - Math.exp(-7 * progress) * (Math.cos(6 * progress) + (7 / 6) * Math.sin(6 * progress))
}

const springRawOne = springRaw(1)

/**
 * Per-axis crop center under log-space zoom interpolation. The fixed point `f`
 * is the content position that stays put on screen while the crop zooms; the
 * center converges on it as `f - (f - cA) * (w/wA)`. Equal zoom levels have no
 * usable fixed point, so near-equal scales fall back to a pure pan.
 */
function interpolateCropCenter(
  centerA: number,
  centerB: number,
  sizeA: number,
  sizeB: number,
  size: number,
  canvasSize: number,
  progress: number,
): number {
  const safeSizeA = Math.max(1e-6, sizeA)
  const safeSizeB = Math.max(1e-6, sizeB)
  const scaleA = canvasSize / safeSizeA
  const scaleB = canvasSize / safeSizeB
  if (Math.abs(scaleB - scaleA) < 1e-3 * scaleA) {
    return centerA + (centerB - centerA) * progress
  }
  const fixed = (centerB * scaleB - centerA * scaleA) / (scaleB - scaleA)
  return fixed - (fixed - centerA) * (size / safeSizeA)
}

/**
 * Zoom-space crop interpolation shared by preview, export, and the zoompan
 * expressions: the crop width travels in log space (`wA * (wB/wA)^p`) so the
 * zoom rate stays constant, and the center glides around the screen-fixed
 * point instead of linearly. Valid for p outside [0, 1] (spring overshoot)
 * and for a `to` crop that is recomputed per frame (follow camera).
 */
export function interpolateCrop(
  from: ZoomTarget,
  to: ZoomTarget,
  progress: number,
  canvas: Pick<TimelineCanvas, "width" | "height">,
): ZoomTarget {
  const canvasWidth = Math.max(1, canvas.width)
  const canvasHeight = Math.max(1, canvas.height)
  const fromWidth = Math.max(1e-6, from.width)
  const toWidth = Math.max(1e-6, to.width)
  const width = Math.min(fromWidth * Math.pow(toWidth / fromWidth, progress), canvasWidth)
  const height = (width / canvasWidth) * canvasHeight

  const centerX = interpolateCropCenter(
    from.x + from.width / 2,
    to.x + to.width / 2,
    from.width,
    to.width,
    width,
    canvasWidth,
    progress,
  )
  const centerY = interpolateCropCenter(
    from.y + from.height / 2,
    to.y + to.height / 2,
    from.height,
    to.height,
    height,
    canvasHeight,
    progress,
  )

  return {
    x: Math.min(Math.max(0, centerX - width / 2), Math.max(0, canvasWidth - width)),
    y: Math.min(Math.max(0, centerY - height / 2), Math.max(0, canvasHeight - height)),
    width,
    height,
  }
}

/** Return a stable numeric aspect ratio for a framing preset. */
export function aspectRatioValue(aspectRatio: CanvasAspectRatio | undefined): number | null {
  if (aspectRatio === "16:9") return 16 / 9
  if (aspectRatio === "9:16") return 9 / 16
  if (aspectRatio === "1:1") return 1
  if (aspectRatio === "5:4") return 5 / 4
  if (aspectRatio === "4:5") return 4 / 5
  return null
}

/**
 * Output resolution tiers, keyed by the canvas short edge so orientation is
 * irrelevant: a 2560×1440 widescreen is "1440p", a 1440×2560 vertical is the
 * same tier. (The previous max-edge rule mistook a 2560×1440 canvas for 4K.)
 */
export const CANVAS_RESOLUTION_TIERS = ["1080p", "1440p", "2160p"] as const
export type CanvasResolutionTier = (typeof CANVAS_RESOLUTION_TIERS)[number]

export const CANVAS_TIER_SHORT_EDGE: Record<CanvasResolutionTier, number> = {
  "1080p": 1080,
  "1440p": 1440,
  "2160p": 2160,
}

export function canvasResolutionTier(current?: CanvasSize): CanvasResolutionTier {
  if (!current) return "1080p"
  const shortEdge = Math.min(current.width, current.height)
  if (shortEdge >= CANVAS_TIER_SHORT_EDGE["2160p"]) return "2160p"
  if (shortEdge >= CANVAS_TIER_SHORT_EDGE["1440p"]) return "1440p"
  return "1080p"
}

const SIXTEEN_NINE = 16 / 9
const ASPECT_TOLERANCE = 0.005

/**
 * Free-tier canvases must measure 16:9 on their actual pixel dimensions,
 * allowing ±0.5% for rounding on odd source sizes (mirrors the Rust
 * entitlement check in `licensing/entitlements.rs`).
 */
export function canvasIsSixteenNine(canvas: CanvasSize): boolean {
  if (canvas.height <= 0) return false
  return Math.abs(canvas.width / canvas.height / SIXTEEN_NINE - 1) <= ASPECT_TOLERANCE
}

/**
 * Fit a requested framing preset. The base dimension is the canvas's
 * resolution-tier short edge, so relayouts keep the current tier (2160p
 * canvases stay 2160-base, 1440p stays 1440-base, everything else 1080).
 */
export function canvasSizeForAspectRatio(
  aspectRatio: CanvasAspectRatio,
  current?: CanvasSize,
  tier?: CanvasResolutionTier,
): CanvasSize {
  const baseDimension = CANVAS_TIER_SHORT_EDGE[tier ?? canvasResolutionTier(current)]

  switch (aspectRatio) {
    case "16:9":
      return { width: Math.round((baseDimension * 16) / 9), height: baseDimension }
    case "9:16":
      return { width: baseDimension, height: Math.round((baseDimension * 16) / 9) }
    case "1:1":
      return { width: baseDimension, height: baseDimension }
    case "5:4":
      return { width: Math.round((baseDimension * 5) / 4), height: baseDimension }
    case "4:5":
      return { width: baseDimension, height: Math.round((baseDimension * 5) / 4) }
  }
}

export function zoomEasedProgress(progress: number, easing: ManualZoomSegment["easing"]): number {
  const value = Math.min(1, Math.max(0, progress))
  if (easing === "linear") return value
  if (easing === "ease-in") return value * value
  if (easing === "ease-out") return 1 - (1 - value) ** 2
  if (easing === "snappy") return 1 - (1 - value) ** 3
  if (easing === "cinematic") return value * value * (3 - 2 * value)
  if (easing === "spring") {
    // Normalized damped spring: 1 - e^(-7p)(cos(6p) + (7/6)sin(6p)), divided by
    // its value at p=1 so endpoints land exactly on 0 and 1 while keeping a
    // ~2.6% overshoot. The decay term vanishes so fast that a single cos/sin
    // pair is enough — no clamping needed.
    return springRaw(value) / springRawOne
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
  let progress: number
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
    // Phase 3: Ease the crop back out with the easing's own out-phase shape.
    // 1 - ease(elapsed/out) preserves symmetric easings exactly and gives
    // asymmetric ones (snappy, spring) a real decelerating tail instead of a
    // mirrored acceleration into full screen.
    const elapsedOut = elapsed - (duration - transitionOutMs)
    const rawProgress = Math.max(0, elapsedOut / Math.max(1, transitionOutMs))
    progress = 1 - zoomEasedProgress(rawProgress, segment.easing)
  } else {
    progress = 0
  }

  const fullCenterX = canvas.width / 2
  const fullCenterY = canvas.height / 2

  const crop =
    isPannedFromPrevious && options.fromTarget
      ? interpolateCrop(
          canonicalizeZoomTarget(options.fromTarget, canvas, options.fromScale ?? 1),
          target,
          progress,
          canvas,
        )
      : interpolateCrop(
          { x: 0, y: 0, width: canvas.width, height: canvas.height },
          target,
          progress,
          canvas,
        )

  const cropX = crop.x
  const cropY = crop.y
  const cropWidth = crop.width
  const cropHeight = crop.height

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
