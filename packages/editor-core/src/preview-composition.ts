import type {
  AnnotationClip,
  CameraClip,
  CaptionClip,
  CursorSettings,
  CursorTelemetryFile,
  ImageClip,
  ManualZoomSegment,
  MaskClip,
  MaskRect,
  TextClip,
  TimelineCanvas,
  TimelineClip,
  TimelineState,
  ZoomTarget,
  RenderPlanZoomMotionPlan,
  RenderPlanZoomMotionPoint,
  RenderPlanZoomMotionSegment,
} from "@recordforge/contracts"
import {
  canonicalizeZoomTarget,
  clampZoomTarget,
  createCursorEngine,
  cursorSettingsForEffect,
  findCursorEffectAtTime,
  fitCursorPoint,
  resolveInertialFollowCenter,
  timelineToCursorSourceTime,
  zoomTargetForCursorPoint,
  type CursorEngine,
  type CursorFrame,
} from "@recordforge/cursor-core"
import {
  findManualZoomAtTime,
  findPreviousZoomSegment,
  resolveZoomTransform,
  type ZoomTransform,
} from "./composition"
import { findTimelineClipAt, timelineToSource } from "./time-mapping"

export type { ZoomTransform }

export interface CanvasGeometry {
  width: number
  height: number
}

export interface ScreenLayer {
  active: boolean
  clip: TimelineClip | null
  sourceMs: number | null
  zoomTransform: ZoomTransform | null
  /** True when the current time falls in a gap with no screen clip. */
  isGap: boolean
}

export interface CameraLayer {
  clip: CameraClip
  active: boolean
  sourceMs: number | null
}

export interface MaskLayer {
  clip: MaskClip
  active: boolean
  rect: MaskRect
}

export interface CaptionLayer {
  clip: CaptionClip
  active: boolean
  text: string
  placement: "top" | "center" | "bottom"
  style: string
  safeAreaMargin: number
}

export interface AnnotationLayer {
  clip: AnnotationClip
  active: boolean
}

export interface TextLayer {
  clip: TextClip
  active: boolean
}

export interface ImageLayer {
  clip: ImageClip
  active: boolean
}

export interface CursorLayer {
  active: boolean
  sourceTimeMs: number | null
  settings: CursorSettings
  /** Cursor position in source canvas coordinates, before any zoom transform. */
  sourcePoint: { x: number; y: number } | null
  /** Canonical cursor frame produced by the engine, if available. */
  frame: CursorFrame | null
}

export interface PreviewComposition {
  timeMs: number
  canvas: CanvasGeometry
  screen: ScreenLayer
  cameras: CameraLayer[]
  masks: MaskLayer[]
  captions: CaptionLayer[]
  annotations: AnnotationLayer[]
  texts: TextLayer[]
  images: ImageLayer[]
  cursor: CursorLayer
}

export interface PreviewCompositionOptions {
  cursorTelemetry?: CursorTelemetryFile | null
  cursorEngine?: CursorEngine | null
}

function isActiveClip(clip: TimelineClip, timeMs: number): boolean {
  return timeMs >= clip.startMs && timeMs < clip.startMs + clip.durationMs
}

function clampRect(rect: MaskRect, canvas: TimelineCanvas): MaskRect {
  const width = Math.min(Math.max(1, rect.width), canvas.width)
  const height = Math.min(Math.max(1, rect.height), canvas.height)
  return {
    x: Math.min(Math.max(0, rect.x), Math.max(0, canvas.width - width)),
    y: Math.min(Math.max(0, rect.y), Math.max(0, canvas.height - height)),
    width,
    height,
  }
}

export const FOLLOW_CAMERA_SAMPLE_STEP_MS = 100
export const FOLLOW_CAMERA_MOTION_TOLERANCE_PX = 2

export interface FollowCursorKeyframe {
  timeMs: number
  target: ZoomTarget
}

export interface FollowCursorKeyframeOptions {
  sampleStepMs?: number
  windowStartMs?: number
  windowEndMs?: number
  timeOffsetMs?: number
  tolerancePx?: number
}

const followCursorPathCache = new WeakMap<
  TimelineState,
  WeakMap<CursorEngine, Map<string, FollowCursorKeyframe[]>>
>()

const followCursorMotionPlanCache = new WeakMap<
  TimelineState,
  WeakMap<CursorEngine, Map<string, RenderPlanZoomMotionPlan>>
>()

function zoomTargetCenter(target: ZoomTarget): { x: number; y: number } {
  return {
    x: target.x + target.width / 2,
    y: target.y + target.height / 2,
  }
}

function followCursorPathCacheKey(segment: ManualZoomSegment, sampleStepMs: number): string {
  return [
    segment.id,
    segment.startMs,
    segment.durationMs,
    segment.scale,
    segment.target.x,
    segment.target.y,
    segment.target.width,
    segment.target.height,
    segment.followDeadzonePercent,
    segment.followSmoothingAlpha,
    sampleStepMs,
  ].join(":")
}

function followCursorMotionPlanCacheKey(
  segment: ManualZoomSegment,
  sampleStepMs: number,
  tolerancePx: number,
): string {
  return `${followCursorPathCacheKey(segment, sampleStepMs)}:${tolerancePx}`
}

/** Resolve one follow-camera sample from a supplied previous camera center. */
export function resolveFollowCursorTarget(
  segment: ManualZoomSegment,
  state: TimelineState,
  timeMs: number,
  cursorEngine: CursorEngine | null | undefined,
  previousCenter?: { x: number; y: number },
): ZoomTarget | undefined {
  if (segment.mode !== "follow-cursor" || !cursorEngine) return undefined
  const sourceTimeMs = timelineToCursorSourceTime(state, timeMs)
  if (sourceTimeMs === null) return undefined
  const cursorSettings = cursorSettingsForEffect(
    state.canvas.cursorSettings,
    findCursorEffectAtTime(state, timeMs),
  )
  const frame = cursorEngine.evaluate(sourceTimeMs, cursorSettings)
  if (!frame.visible) return undefined
  const fitted = fitCursorPoint(
    { x: frame.sourceX, y: frame.sourceY },
    cursorEngine.telemetry,
    state.canvas.width,
    state.canvas.height,
  )
  if (!fitted.visible) return undefined

  const baseTarget = canonicalizeZoomTarget(segment.target, state.canvas, segment.scale)
  const desiredScale = Math.max(1.05, state.canvas.width / Math.max(1, baseTarget.width))
  const initialCenter = zoomTargetCenter(baseTarget)
  const followCenter = resolveInertialFollowCenter(
    { x: fitted.x, y: fitted.y },
    previousCenter ?? initialCenter,
    { width: state.canvas.width / desiredScale, height: state.canvas.height / desiredScale },
    {
      deadzoneRadiusPercent: segment.followDeadzonePercent,
      smoothingAlpha: segment.followSmoothingAlpha,
    },
  )
  return zoomTargetForCursorPoint(followCenter, state.canvas, desiredScale)
}

function buildRawFollowCursorKeyframes(
  segment: ManualZoomSegment,
  state: TimelineState,
  cursorEngine: CursorEngine,
  sampleStepMs: number,
): FollowCursorKeyframe[] {
  const segmentStartMs = segment.startMs
  const segmentEndMs = segment.startMs + Math.max(1, segment.durationMs)
  const baseTarget = canonicalizeZoomTarget(segment.target, state.canvas, segment.scale)
  let previousTarget = baseTarget
  let previousCenter = zoomTargetCenter(baseTarget)
  const keyframes: FollowCursorKeyframe[] = []

  for (let timeMs = segmentStartMs; timeMs < segmentEndMs; timeMs += sampleStepMs) {
    const target =
      resolveFollowCursorTarget(segment, state, timeMs, cursorEngine, previousCenter) ??
      previousTarget
    keyframes.push({ timeMs, target })
    previousTarget = target
    previousCenter = zoomTargetCenter(target)
  }

  keyframes.push({
    timeMs: segmentEndMs,
    target:
      resolveFollowCursorTarget(segment, state, segmentEndMs, cursorEngine, previousCenter) ??
      previousTarget,
  })
  return keyframes
}

function getRawFollowCursorKeyframes(
  segment: ManualZoomSegment,
  state: TimelineState,
  cursorEngine: CursorEngine,
  sampleStepMs: number,
): FollowCursorKeyframe[] {
  if (sampleStepMs !== FOLLOW_CAMERA_SAMPLE_STEP_MS) {
    return buildRawFollowCursorKeyframes(segment, state, cursorEngine, sampleStepMs)
  }

  let stateCache = followCursorPathCache.get(state)
  if (!stateCache) {
    stateCache = new WeakMap()
    followCursorPathCache.set(state, stateCache)
  }

  let engineCache = stateCache.get(cursorEngine)
  if (!engineCache) {
    engineCache = new Map()
    stateCache.set(cursorEngine, engineCache)
  }

  const key = followCursorPathCacheKey(segment, sampleStepMs)
  const cached = engineCache.get(key)
  if (cached) return cached

  const keyframes = buildRawFollowCursorKeyframes(segment, state, cursorEngine, sampleStepMs)
  engineCache.set(key, keyframes)
  return keyframes
}

function interpolateFollowCursorTarget(
  keyframes: FollowCursorKeyframe[],
  timeMs: number,
): ZoomTarget | undefined {
  if (keyframes.length === 0) return undefined
  const safeTimeMs = Number.isFinite(timeMs) ? timeMs : keyframes[0].timeMs
  if (safeTimeMs <= keyframes[0].timeMs) return keyframes[0].target

  for (let index = 1; index < keyframes.length; index++) {
    const right = keyframes[index]
    const left = keyframes[index - 1]
    if (safeTimeMs > right.timeMs) continue
    const span = Math.max(1, right.timeMs - left.timeMs)
    const alpha = Math.min(1, Math.max(0, (safeTimeMs - left.timeMs) / span))
    return {
      x: left.target.x + (right.target.x - left.target.x) * alpha,
      y: left.target.y + (right.target.y - left.target.y) * alpha,
      width: left.target.width + (right.target.width - left.target.width) * alpha,
      height: left.target.height + (right.target.height - left.target.height) * alpha,
    }
  }

  return keyframes[keyframes.length - 1].target
}

function deduplicateFollowCursorKeyframes(
  keyframes: FollowCursorKeyframe[],
): FollowCursorKeyframe[] {
  const result: FollowCursorKeyframe[] = []
  for (const keyframe of keyframes) {
    const previous = result[result.length - 1]
    if (previous?.timeMs === keyframe.timeMs) result[result.length - 1] = keyframe
    else result.push(keyframe)
  }
  return result
}

interface FollowCursorWindow {
  keyframes: FollowCursorKeyframe[]
}

function getFollowCursorWindow(
  segment: ManualZoomSegment,
  state: TimelineState,
  cursorEngine: CursorEngine,
  sampleStepMs: number,
  options: FollowCursorKeyframeOptions,
): FollowCursorWindow | undefined {
  const segmentStartMs = segment.startMs
  const segmentEndMs = segment.startMs + Math.max(1, segment.durationMs)
  const raw = getRawFollowCursorKeyframes(segment, state, cursorEngine, sampleStepMs)
  const requestedStart = options.windowStartMs ?? segmentStartMs
  const requestedEnd = options.windowEndMs ?? segmentEndMs
  const windowStartMs = Math.min(
    segmentEndMs,
    Math.max(segmentStartMs, Number.isFinite(requestedStart) ? requestedStart : segmentStartMs),
  )
  const windowEndMs = Math.max(
    windowStartMs,
    Math.min(segmentEndMs, Number.isFinite(requestedEnd) ? requestedEnd : segmentEndMs),
  )
  const startTarget = interpolateFollowCursorTarget(raw, windowStartMs)
  const endTarget = interpolateFollowCursorTarget(raw, windowEndMs)
  if (!startTarget || !endTarget) return undefined

  return {
    keyframes: deduplicateFollowCursorKeyframes([
      { timeMs: windowStartMs, target: startTarget },
      ...raw.filter(({ timeMs }) => timeMs > windowStartMs && timeMs < windowEndMs),
      { timeMs: windowEndMs, target: endTarget },
    ]),
  }
}

function safeMotionTolerance(value: number | undefined): number {
  return Number.isFinite(value)
    ? Math.max(0, value ?? FOLLOW_CAMERA_MOTION_TOLERANCE_PX)
    : FOLLOW_CAMERA_MOTION_TOLERANCE_PX
}

function motionPointFromKeyframe(keyframe: FollowCursorKeyframe): RenderPlanZoomMotionPoint {
  return zoomTargetCenter(keyframe.target)
}

function motionPointDistance(
  left: RenderPlanZoomMotionPoint,
  right: RenderPlanZoomMotionPoint,
): number {
  return Math.hypot(left.x - right.x, left.y - right.y)
}

function pointToLineDistance(
  point: RenderPlanZoomMotionPoint,
  start: RenderPlanZoomMotionPoint,
  end: RenderPlanZoomMotionPoint,
): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= Number.EPSILON) return motionPointDistance(point, start)

  const projection = Math.min(
    1,
    Math.max(0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
  )
  return Math.hypot(point.x - (start.x + projection * dx), point.y - (start.y + projection * dy))
}

function shouldPreserveMotionAnchor(
  samples: FollowCursorKeyframe[],
  index: number,
  tolerancePx: number,
): boolean {
  const previous = samples[index - 1]
  const current = samples[index]
  const next = samples[index + 1]
  if (!previous || !current || !next) return false

  const previousPoint = motionPointFromKeyframe(previous)
  const currentPoint = motionPointFromKeyframe(current)
  const nextPoint = motionPointFromKeyframe(next)
  const previousDistance = motionPointDistance(previousPoint, currentPoint)
  const nextDistance = motionPointDistance(currentPoint, nextPoint)
  const hasPauseBoundary =
    (previousDistance <= tolerancePx && nextDistance > tolerancePx) ||
    (nextDistance <= tolerancePx && previousDistance > tolerancePx)
  if (hasPauseBoundary) return true

  const previousDuration = Math.max(1, current.timeMs - previous.timeMs)
  const nextDuration = Math.max(1, next.timeMs - current.timeMs)
  const incoming = {
    x: (currentPoint.x - previousPoint.x) / previousDuration,
    y: (currentPoint.y - previousPoint.y) / previousDuration,
  }
  const outgoing = {
    x: (nextPoint.x - currentPoint.x) / nextDuration,
    y: (nextPoint.y - currentPoint.y) / nextDuration,
  }
  return incoming.x * outgoing.x + incoming.y * outgoing.y < 0
}

function rdpMotionPointIndices(
  samples: FollowCursorKeyframe[],
  startIndex: number,
  endIndex: number,
  tolerancePx: number,
  retained: Set<number>,
): void {
  const stack: Array<[number, number]> = [[startIndex, endIndex]]
  while (stack.length > 0) {
    const [start, end] = stack.pop() ?? [0, 0]
    if (end - start <= 1) continue

    const startPoint = motionPointFromKeyframe(samples[start])
    const endPoint = motionPointFromKeyframe(samples[end])
    let furthestIndex = -1
    let furthestDistance = tolerancePx
    for (let index = start + 1; index < end; index++) {
      const distance = pointToLineDistance(
        motionPointFromKeyframe(samples[index]),
        startPoint,
        endPoint,
      )
      if (distance > furthestDistance) {
        furthestDistance = distance
        furthestIndex = index
      }
    }

    if (furthestIndex < 0) continue
    retained.add(furthestIndex)
    stack.push([start, furthestIndex], [furthestIndex, end])
  }
}

function simplifyFollowCursorKeyframes(
  samples: FollowCursorKeyframe[],
  tolerancePx: number,
): FollowCursorKeyframe[] {
  if (samples.length <= 2) return samples

  const anchors = new Set<number>([0, samples.length - 1])
  for (let index = 1; index < samples.length - 1; index++) {
    if (shouldPreserveMotionAnchor(samples, index, tolerancePx)) anchors.add(index)
  }

  const sortedAnchors = [...anchors].sort((left, right) => left - right)
  const retained = new Set<number>(sortedAnchors)
  for (let index = 1; index < sortedAnchors.length; index++) {
    rdpMotionPointIndices(
      samples,
      sortedAnchors[index - 1],
      sortedAnchors[index],
      tolerancePx,
      retained,
    )
  }

  return [...retained].sort((left, right) => left - right).map((index) => samples[index])
}

function subtractMotionPoints(
  left: RenderPlanZoomMotionPoint,
  right: RenderPlanZoomMotionPoint,
): RenderPlanZoomMotionPoint {
  return { x: left.x - right.x, y: left.y - right.y }
}

function scaleMotionPoint(
  point: RenderPlanZoomMotionPoint,
  factor: number,
): RenderPlanZoomMotionPoint {
  return { x: point.x * factor, y: point.y * factor }
}

function addMotionPoints(
  left: RenderPlanZoomMotionPoint,
  right: RenderPlanZoomMotionPoint,
): RenderPlanZoomMotionPoint {
  return { x: left.x + right.x, y: left.y + right.y }
}

function clampMotionControlPoint(
  point: RenderPlanZoomMotionPoint,
  start: RenderPlanZoomMotionPoint,
  end: RenderPlanZoomMotionPoint,
): RenderPlanZoomMotionPoint {
  return {
    x: Math.min(Math.max(point.x, Math.min(start.x, end.x)), Math.max(start.x, end.x)),
    y: Math.min(Math.max(point.y, Math.min(start.y, end.y)), Math.max(start.y, end.y)),
  }
}

function buildFollowCursorMotionSegments(
  samples: FollowCursorKeyframe[],
  tolerancePx: number,
): RenderPlanZoomMotionSegment[] {
  const points = samples.map(motionPointFromKeyframe)
  const tangents = points.map((point, index) => {
    const previous = points[index - 1]
    const next = points[index + 1]
    const isStationary =
      (previous && motionPointDistance(previous, point) <= tolerancePx) ||
      (next && motionPointDistance(point, next) <= tolerancePx)
    if (isStationary) return { x: 0, y: 0 }
    if (!previous && next) {
      return scaleMotionPoint(
        subtractMotionPoints(next, point),
        1 / Math.max(1, samples[index + 1].timeMs - samples[index].timeMs),
      )
    }
    if (!next && previous) {
      return scaleMotionPoint(
        subtractMotionPoints(point, previous),
        1 / Math.max(1, samples[index].timeMs - samples[index - 1].timeMs),
      )
    }
    if (!previous || !next) return { x: 0, y: 0 }
    return scaleMotionPoint(
      subtractMotionPoints(next, previous),
      1 / Math.max(1, samples[index + 1].timeMs - samples[index - 1].timeMs),
    )
  })

  return samples.slice(0, -1).map((sample, index) => {
    const nextSample = samples[index + 1]
    const start = points[index]
    const end = points[index + 1]
    const durationMs = Math.max(1, nextSample.timeMs - sample.timeMs)
    const control1 = clampMotionControlPoint(
      addMotionPoints(start, scaleMotionPoint(tangents[index], durationMs / 3)),
      start,
      end,
    )
    const control2 = clampMotionControlPoint(
      subtractMotionPoints(end, scaleMotionPoint(tangents[index + 1], durationMs / 3)),
      start,
      end,
    )
    return {
      startMs: Math.round(sample.timeMs),
      endMs: Math.round(nextSample.timeMs),
      start,
      control1,
      control2,
      end,
    }
  })
}

function getMotionPlanTolerance(options: FollowCursorKeyframeOptions): number {
  return safeMotionTolerance(options.tolerancePx)
}

function buildMotionPlanFromWindow(
  window: FollowCursorWindow,
  options: FollowCursorKeyframeOptions,
): RenderPlanZoomMotionPlan | undefined {
  if (window.keyframes.length < 2) return undefined
  const tolerancePx = getMotionPlanTolerance(options)
  const samples = simplifyFollowCursorKeyframes(window.keyframes, tolerancePx)
  const segments = buildFollowCursorMotionSegments(samples, tolerancePx)
  if (segments.length === 0) return undefined
  const timeOffsetMs = Number.isFinite(options.timeOffsetMs) ? (options.timeOffsetMs ?? 0) : 0

  return {
    version: 1,
    kind: "cubic-bezier",
    segments: segments.map((segment) => ({
      ...segment,
      startMs: Math.round(segment.startMs - timeOffsetMs),
      endMs: Math.round(segment.endMs - timeOffsetMs),
    })),
  }
}

/** Build an adaptive cubic camera path without the legacy 11-keyframe limit. */
export function buildFollowCursorMotionPlan(
  segment: ManualZoomSegment,
  state: TimelineState,
  cursorEngine: CursorEngine | null | undefined,
  options: FollowCursorKeyframeOptions = {},
): RenderPlanZoomMotionPlan | undefined {
  if (segment.mode !== "follow-cursor" || !cursorEngine) return undefined

  const requestedSampleStepMs = options.sampleStepMs ?? FOLLOW_CAMERA_SAMPLE_STEP_MS
  const sampleStepMs = Number.isFinite(requestedSampleStepMs)
    ? Math.max(1, Math.round(requestedSampleStepMs))
    : FOLLOW_CAMERA_SAMPLE_STEP_MS
  const tolerancePx = getMotionPlanTolerance(options)
  const isFullPlan =
    options.windowStartMs === undefined &&
    options.windowEndMs === undefined &&
    (!options.timeOffsetMs || options.timeOffsetMs === 0)
  const cacheKey = followCursorMotionPlanCacheKey(segment, sampleStepMs, tolerancePx)

  if (isFullPlan && sampleStepMs === FOLLOW_CAMERA_SAMPLE_STEP_MS) {
    let stateCache = followCursorMotionPlanCache.get(state)
    if (!stateCache) {
      stateCache = new WeakMap()
      followCursorMotionPlanCache.set(state, stateCache)
    }
    let engineCache = stateCache.get(cursorEngine)
    if (!engineCache) {
      engineCache = new Map()
      stateCache.set(cursorEngine, engineCache)
    }
    const cached = engineCache.get(cacheKey)
    if (cached) return cached

    const window = getFollowCursorWindow(segment, state, cursorEngine, sampleStepMs, options)
    const plan = window ? buildMotionPlanFromWindow(window, options) : undefined
    if (plan) engineCache.set(cacheKey, plan)
    return plan
  }

  const window = getFollowCursorWindow(segment, state, cursorEngine, sampleStepMs, options)
  return window ? buildMotionPlanFromWindow(window, options) : undefined
}

/**
 * Keep the old keyframe helper available for callers that still need samples.
 * New preview and export paths use `buildFollowCursorMotionPlan` instead.
 */
export function buildFollowCursorKeyframes(
  segment: ManualZoomSegment,
  state: TimelineState,
  cursorEngine: CursorEngine | null | undefined,
  options: FollowCursorKeyframeOptions = {},
): FollowCursorKeyframe[] {
  if (segment.mode !== "follow-cursor" || !cursorEngine) return []

  const requestedSampleStepMs = options.sampleStepMs ?? FOLLOW_CAMERA_SAMPLE_STEP_MS
  const sampleStepMs = Number.isFinite(requestedSampleStepMs)
    ? Math.max(1, Math.round(requestedSampleStepMs))
    : FOLLOW_CAMERA_SAMPLE_STEP_MS
  const window = getFollowCursorWindow(segment, state, cursorEngine, sampleStepMs, options)
  if (!window) return []

  const timeOffsetMs = Number.isFinite(options.timeOffsetMs) ? (options.timeOffsetMs ?? 0) : 0

  return window.keyframes.map((keyframe) => ({
    timeMs: keyframe.timeMs - timeOffsetMs,
    target: clampZoomTarget(keyframe.target, state.canvas),
  }))
}

function cubicBezierPoint(
  segment: RenderPlanZoomMotionSegment,
  progress: number,
): RenderPlanZoomMotionPoint {
  const inverse = 1 - progress
  const inverseSquared = inverse * inverse
  const progressSquared = progress * progress
  return {
    x:
      inverseSquared * inverse * segment.start.x +
      3 * inverseSquared * progress * segment.control1.x +
      3 * inverse * progressSquared * segment.control2.x +
      progressSquared * progress * segment.end.x,
    y:
      inverseSquared * inverse * segment.start.y +
      3 * inverseSquared * progress * segment.control1.y +
      3 * inverse * progressSquared * segment.control2.y +
      progressSquared * progress * segment.end.y,
  }
}

function resolveFollowCursorMotionPointAtTime(
  motionPlan: RenderPlanZoomMotionPlan,
  timeMs: number,
): RenderPlanZoomMotionPoint | undefined {
  const segments = motionPlan.segments
  if (segments.length === 0) return undefined
  const safeTimeMs = Number.isFinite(timeMs) ? timeMs : segments[0].startMs
  if (safeTimeMs <= segments[0].startMs) return segments[0].start

  let low = 0
  let high = segments.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (safeTimeMs <= segments[middle].endMs) high = middle
    else low = middle + 1
  }

  const segment = segments[low]
  const durationMs = Math.max(1, segment.endMs - segment.startMs)
  const progress = Math.min(1, Math.max(0, (safeTimeMs - segment.startMs) / durationMs))
  return cubicBezierPoint(segment, progress)
}

/** Evaluate a compact motion plan into the canonical zoom target at a time. */
export function resolveFollowCursorMotionPlanTargetAtTime(
  motionPlan: RenderPlanZoomMotionPlan,
  segment: ManualZoomSegment,
  state: TimelineState,
  timeMs: number,
): ZoomTarget | undefined {
  const point = resolveFollowCursorMotionPointAtTime(motionPlan, timeMs)
  if (!point) return undefined
  const baseTarget = canonicalizeZoomTarget(segment.target, state.canvas, segment.scale)
  const desiredScale = Math.max(1.05, state.canvas.width / Math.max(1, baseTarget.width))
  return zoomTargetForCursorPoint(point, state.canvas, desiredScale)
}

/** Resolve a preview target from the same motion plan that export receives. */
export function resolveFollowCursorTargetAtTime(
  segment: ManualZoomSegment,
  state: TimelineState,
  timeMs: number,
  cursorEngine: CursorEngine | null | undefined,
  sampleStepMs = FOLLOW_CAMERA_SAMPLE_STEP_MS,
): ZoomTarget | undefined {
  if (segment.mode !== "follow-cursor" || !cursorEngine) return undefined
  const motionPlan = buildFollowCursorMotionPlan(segment, state, cursorEngine, { sampleStepMs })
  return motionPlan
    ? resolveFollowCursorMotionPlanTargetAtTime(motionPlan, segment, state, timeMs)
    : undefined
}

function resolvePreviousZoomTarget(
  previous: ManualZoomSegment | null,
  state: TimelineState,
  cursorEngine: CursorEngine | null | undefined,
): ZoomTarget | null {
  if (!previous) return null
  if (previous.mode !== "follow-cursor" || !cursorEngine) return previous.target

  return (
    resolveFollowCursorTargetAtTime(
      previous,
      state,
      previous.startMs + Math.max(1, previous.durationMs),
      cursorEngine,
    ) ?? previous.target
  )
}

/**
 * Build a single preview composition for a given timeline time.
 *
 * This is the one place that decides, for a given frame, what every layer
 * (screen, zoom, camera, mask, caption, cursor) should look like. Preview
 * components and the export plan should derive from the same composition
 * wherever possible so they cannot diverge silently.
 */
export function resolvePreviewComposition(
  state: TimelineState,
  timeMs: number,
  options: PreviewCompositionOptions = {},
): PreviewComposition {
  const canvas = { width: state.canvas.width, height: state.canvas.height }

  const cursorEngine =
    options.cursorEngine ??
    (options.cursorTelemetry ? createCursorEngine(options.cursorTelemetry) : null)

  const screenClip = findTimelineClipAt(state, "screen", timeMs)
  const screenSourceMs = screenClip ? timelineToSource(screenClip, timeMs) : null
  const activeZoom = findManualZoomAtTime(state, timeMs)
  const followTarget = activeZoom
    ? resolveFollowCursorTargetAtTime(activeZoom, state, timeMs, cursorEngine)
    : undefined

  const previousZoom = activeZoom ? findPreviousZoomSegment(state, activeZoom) : null
  const previousTarget = activeZoom
    ? resolvePreviousZoomTarget(previousZoom, state, cursorEngine)
    : null

  const zoomTransform = activeZoom
    ? resolveZoomTransform(activeZoom, timeMs, state.canvas, {
        target: followTarget,
        fromTarget: previousTarget,
        fromScale: previousZoom?.scale,
      })
    : null

  const cameras: CameraLayer[] = state.tracks
    .filter((track) => track.kind === "camera" && !track.muted)
    .flatMap((track) =>
      track.clips
        .filter((clip): clip is CameraClip => clip.kind === "camera")
        .map((clip) => {
          const active = isActiveClip(clip, timeMs) && clip.transform.visible !== false
          const sourceMs = active ? clip.sourceInMs + (timeMs - clip.startMs) * clip.speed : null
          return { clip, active, sourceMs }
        }),
    )

  const masks: MaskLayer[] = state.tracks
    .filter((track) => track.kind === "effects" && !track.muted)
    .flatMap((track) =>
      track.clips
        .filter((clip): clip is MaskClip => clip.kind === "mask")
        .map((clip) => ({
          clip,
          active: clip.enabled !== false && isActiveClip(clip, timeMs),
          rect: clampRect(clip.rect, state.canvas),
        })),
    )

  const captions: CaptionLayer[] = state.tracks
    .filter((track) => track.kind === "captions" && !track.muted)
    .flatMap((track) =>
      track.clips
        .filter((clip): clip is CaptionClip => clip.kind === "caption")
        .map((clip) => ({
          clip,
          active: isActiveClip(clip, timeMs),
          text: clip.text,
          placement: clip.placement ?? "bottom",
          style: clip.style,
          safeAreaMargin: clip.safeAreaMargin ?? 48,
        })),
    )

  const annotations: AnnotationLayer[] = state.tracks
    .filter((track) => !track.muted)
    .flatMap((track) =>
      track.clips
        .filter((clip): clip is AnnotationClip => clip.kind === "annotation")
        .map((clip) => ({
          clip,
          active: clip.enabled !== false && isActiveClip(clip, timeMs),
        })),
    )

  const texts: TextLayer[] = state.tracks
    .filter((track) => !track.muted)
    .flatMap((track) =>
      track.clips
        .filter((clip): clip is TextClip => clip.kind === "text")
        .map((clip) => ({
          clip,
          active: clip.enabled !== false && isActiveClip(clip, timeMs),
        })),
    )

  const images: ImageLayer[] = state.tracks
    .filter((track) => !track.muted)
    .flatMap((track) =>
      track.clips
        .filter((clip): clip is ImageClip => clip.kind === "image")
        .map((clip) => ({
          clip,
          active: clip.enabled !== false && isActiveClip(clip, timeMs),
        })),
    )

  const cursorEffect = findCursorEffectAtTime(state, timeMs)
  const cursorSourceTimeMs = timelineToCursorSourceTime(state, timeMs)
  const cursorSettings = cursorSettingsForEffect(state.canvas.cursorSettings, cursorEffect)

  let cursorSourcePoint: { x: number; y: number } | null = null
  let cursorFrame: CursorFrame | null = null
  if (cursorSourceTimeMs !== null && cursorEngine) {
    const frame = cursorEngine.evaluate(cursorSourceTimeMs, cursorSettings)
    if (frame.visible) {
      const fitted = fitCursorPoint(
        { x: frame.sourceX, y: frame.sourceY },
        cursorEngine.telemetry,
        canvas.width,
        canvas.height,
      )
      if (fitted.visible) {
        cursorSourcePoint = { x: fitted.x, y: fitted.y }
        cursorFrame = frame
      }
    }
  }

  const cursor: CursorLayer = {
    active:
      cursorSettings.enabled &&
      screenClip !== null &&
      cursorSourceTimeMs !== null &&
      cursorSourcePoint !== null,
    sourceTimeMs: cursorSourceTimeMs,
    settings: cursorSettings,
    sourcePoint: cursorSourcePoint,
    frame: cursorFrame,
  }

  return {
    timeMs,
    canvas,
    screen: {
      active: screenClip !== null,
      clip: screenClip,
      sourceMs: screenSourceMs,
      zoomTransform,
      isGap: screenClip === null,
    },
    cameras,
    masks,
    captions,
    annotations,
    texts,
    images,
    cursor,
  }
}

/**
 * Convert a zoom crop to a pixel matrix so the preview video and cursor overlay
 * apply exactly the same transform at the rendered video dimensions.
 */
export function zoomTransformToCss(
  transform: ZoomTransform,
  canvas: { width: number; height: number },
  viewport: { width: number; height: number } = canvas,
): string {
  const canvasWidth = Math.max(1, canvas.width)
  const canvasHeight = Math.max(1, canvas.height)
  const viewportWidth = Math.max(1, viewport.width)
  const viewportHeight = Math.max(1, viewport.height)
  const scaleX = canvasWidth / Math.max(1, transform.crop.width)
  const scaleY = canvasHeight / Math.max(1, transform.crop.height)
  const translateX = -(transform.crop.x / canvasWidth) * viewportWidth * scaleX
  const translateY = -(transform.crop.y / canvasHeight) * viewportHeight * scaleY

  return `matrix(${scaleX}, 0, 0, ${scaleY}, ${translateX}, ${translateY})`
}
