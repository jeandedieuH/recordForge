// Face-tracked camera framing (#4c).
//
// The offline face job writes YuNet detections at ~8 Hz (source time). This
// module turns them into a fixed-size source crop whose centre moves smoothly:
// a One-Euro filter removes detector jitter without adding visible lag, and the
// result is resampled at ≤10 Hz because the export crop is driven by a
// `sendcmd` script, not per-frame expressions.
//
// Both the preview and `render-plan.ts` call this same resolver, so the CSS
// crop and the exported `crop` filter agree by construction.

import type {
  CameraFaceFraming,
  CameraFaceTracking,
  FaceTrack,
  FaceTrackSample,
  RenderPlanCropKeyframe,
} from "@recordforge/contracts"

/** Face height as a fraction of the crop height, per framing. */
const FRAMING_FACE_FRACTION: Record<CameraFaceFraming, number> = {
  tight: 0.55,
  medium: 0.4,
  wide: 0.28,
}

/** Maximum keyframe rate — the renderers rebuild crop state from a sendcmd file. */
export const FACE_CROP_MAX_HZ = 10

export interface FaceCropInput {
  track: FaceTrack
  /** Clip source window, in container ms. */
  sourceInMs: number
  sourceOutMs: number
  /** Output window that maps onto the source window. */
  outputStartMs: number
  outputEndMs: number
  settings: Pick<CameraFaceTracking, "framing" | "smoothness" | "headroom">
  /** Source pixels (camera stream size). */
  sourceWidth: number
  sourceHeight: number
  /** Output frame rate; zero/undefined falls back to the 10 Hz cap. */
  fps?: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function sampleAt(samples: FaceTrackSample[], timeMs: number): FaceTrackSample | null {
  if (samples.length === 0) return null
  // Samples are sorted by the writer; binary search keeps long tracks cheap.
  let lo = 0
  let hi = samples.length - 1
  if (timeMs <= samples[0]!.timeMs) return samples[0]!
  if (timeMs >= samples[hi]!.timeMs) return samples[hi]!
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (samples[mid]!.timeMs <= timeMs) lo = mid
    else hi = mid
  }
  const left = samples[lo]!
  const right = samples[hi]!
  const span = right.timeMs - left.timeMs
  if (span <= 0) return left
  const t = (timeMs - left.timeMs) / span
  return {
    timeMs,
    x: left.x + (right.x - left.x) * t,
    y: left.y + (right.y - left.y) * t,
    width: left.width + (right.width - left.width) * t,
    height: left.height + (right.height - left.height) * t,
    score: Math.min(left.score, right.score),
  }
}

/** One-Euro filter for one axis; dt in seconds. */
class OneEuro {
  private value: number | null = null
  private derivative = 0

  constructor(
    private readonly minCutoff: number,
    private readonly beta: number,
    private readonly derivativeCutoff = 1,
  ) {}

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff)
    return 1 / (1 + tau / Math.max(dt, 1e-6))
  }

  filter(next: number, dt: number): number {
    if (this.value === null) {
      this.value = next
      return next
    }
    const rawDerivative = (next - this.value) / Math.max(dt, 1e-6)
    const dAlpha = OneEuro.alpha(this.derivativeCutoff, dt)
    this.derivative += dAlpha * (rawDerivative - this.derivative)
    const cutoff = this.minCutoff + this.beta * Math.abs(this.derivative)
    const alpha = OneEuro.alpha(cutoff, dt)
    this.value += alpha * (next - this.value)
    return this.value
  }
}

/**
 * Resolve a face-tracked crop for one camera clip. Returns `null` when the
 * track has no samples inside (or near) the clip window, so callers keep the
 * manual transform crop.
 */
export function resolveFaceCropKeyframes(input: FaceCropInput): RenderPlanCropKeyframe[] | null {
  const { track, settings } = input
  const sourceWidth = Math.max(2, Math.round(input.sourceWidth || track.width))
  const sourceHeight = Math.max(2, Math.round(input.sourceHeight || track.height))
  const outputSpan = input.outputEndMs - input.outputStartMs
  const sourceSpan = input.sourceOutMs - input.sourceInMs
  if (outputSpan <= 0 || sourceSpan <= 0 || track.samples.length === 0) return null

  const faceFraction = FRAMING_FACE_FRACTION[settings.framing] ?? FRAMING_FACE_FRACTION.medium
  const headroom = clamp(settings.headroom, 0, 1)
  const aspect = sourceWidth / sourceHeight
  // Face samples are in the face-track's own coordinate space.
  const scaleX = sourceWidth / Math.max(1, track.width)
  const scaleY = sourceHeight / Math.max(1, track.height)

  const samples = track.samples
    .filter(
      (sample) =>
        sample.timeMs >= input.sourceInMs - 1000 && sample.timeMs <= input.sourceOutMs + 1000,
    )
    .map((sample) => ({
      ...sample,
      x: sample.x * scaleX,
      y: sample.y * scaleY,
      width: sample.width * scaleX,
      height: sample.height * scaleY,
    }))
  if (samples.length === 0) return null

  const cropHeight = clamp(
    samples.reduce((sum, sample) => sum + sample.height, 0) / samples.length / faceFraction,
    Math.min(64, sourceHeight),
    sourceHeight,
  )
  const cropWidth = clamp(cropHeight * aspect, Math.min(64, sourceWidth), sourceWidth)
  const settledHeight = cropHeight
  const settledWidth = cropWidth

  const smoothness = clamp(settings.smoothness, 0, 1)
  // Higher smoothness → lower cutoff → calmer motion.
  const minCutoff = 0.35 + (1 - smoothness) * 2.2
  const filterX = new OneEuro(minCutoff, 0.08)
  const filterY = new OneEuro(minCutoff, 0.08)

  const fps = input.fps && input.fps > 0 ? input.fps : FACE_CROP_MAX_HZ
  const stepMs = Math.max(1000 / FACE_CROP_MAX_HZ, 1000 / Math.max(1, fps))
  const keyframes: RenderPlanCropKeyframe[] = []

  const centreFor = (sample: FaceTrackSample) => {
    const cx = sample.x + sample.width / 2
    const cy = sample.y + sample.height / 2 - settledHeight * (0.5 - headroom)
    return { cx, cy }
  }

  let lastOutputMs = Number.NEGATIVE_INFINITY
  for (let outputMs = input.outputStartMs; outputMs <= input.outputEndMs; outputMs += stepMs) {
    const progress = (outputMs - input.outputStartMs) / outputSpan
    const sourceMs = input.sourceInMs + progress * sourceSpan
    const sample = sampleAt(samples, sourceMs)
    if (!sample) continue
    const raw = centreFor(sample)
    const dt = lastOutputMs === Number.NEGATIVE_INFINITY ? 1 / 24 : (outputMs - lastOutputMs) / 1000
    lastOutputMs = outputMs
    const cx = filterX.filter(raw.cx, dt)
    const cy = filterY.filter(raw.cy, dt)
    const width = Math.max(2, Math.round(settledWidth / 2) * 2)
    const height = Math.max(2, Math.round(settledHeight / 2) * 2)
    const x = Math.round(clamp(cx - width / 2, 0, Math.max(0, sourceWidth - width)) / 2) * 2
    const y = Math.round(clamp(cy - height / 2, 0, Math.max(0, sourceHeight - height)) / 2) * 2
    const previous = keyframes[keyframes.length - 1]
    if (previous && previous.x === x && previous.y === y) continue
    keyframes.push({
      timeMs: Math.round(outputMs),
      x,
      y,
      width,
      height,
    })
  }

  if (keyframes.length === 0) return null
  // The renderer holds the first pose until the first keyframe; duplicating the
  // first pose at the window start makes that explicit.
  if (keyframes[0]!.timeMs > input.outputStartMs) {
    keyframes.unshift({ ...keyframes[0]!, timeMs: Math.round(input.outputStartMs) })
  }
  return keyframes
}

/** The static crop a face-tracked clip falls back to before its first keyframe. */
export function faceCropAt(
  keyframes: RenderPlanCropKeyframe[],
  outputMs: number,
): RenderPlanCropKeyframe | null {
  if (keyframes.length === 0) return null
  let current = keyframes[0]!
  for (const keyframe of keyframes) {
    if (keyframe.timeMs > outputMs) break
    current = keyframe
  }
  return current
}
