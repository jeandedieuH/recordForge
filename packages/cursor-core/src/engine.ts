import {
  defaultCursorSettings,
  type CursorSettings,
  type CursorTelemetryEvent,
  type CursorTelemetryFile,
  type RenderPlanZoomMotionPlan,
  type RenderPlanZoomMotionPoint,
} from "@recordforge/contracts"

export interface CursorPoint {
  x: number
  y: number
}

export interface CursorClickEffect {
  button: "left" | "right" | "middle"
  startMs: number
  /** Source coordinates where the click occurred. */
  sourceX: number
  sourceY: number
  /** 0..1 progress through the effect duration. */
  progress: number
  /** 0..1 visual intensity at this point in time. */
  intensity: number
}

export interface CursorFrame {
  sourceTimeMs: number
  /** Smoothed cursor position in source (capture) coordinates. */
  sourceX: number
  sourceY: number
  visible: boolean
  opacity: number
  /** Shape identifier from the telemetry, or an empty string if unavailable. */
  shapeId: string
  isIdle: boolean
  activeClicks: CursorClickEffect[]
  velocityPxPerSec: number
}

export interface CursorEngineOptions {
  /** Samples farther apart than this are treated as a cut/gap and reset smoothing. */
  gapThresholdMs?: number
  /** Sub-pixel movement below this is treated as noise and ignored. */
  jitterThresholdPx?: number
  /** Movement above this is considered real motion for idle detection. */
  motionThresholdPx?: number
  /** Number of recent events used for smoothing. */
  smoothingWindowSize?: number
  /** Duration over which the cursor fades when idle. */
  idleFadeDurationMs?: number
}

interface PreparedEvent {
  tMs: number
  rawX: number
  rawY: number
  denoisedX: number
  denoisedY: number
  visible: boolean
  shapeId: string
  shapeChanged: boolean
  buttonEvent: CursorTelemetryEvent["buttonEvent"]
  segmentId: number
  speedPxPerSec: number
  isMotion: boolean
  lastMotionMs: number
  isClickEdge: boolean
  clickButton: "left" | "right" | "middle"
}

interface ClickEntry {
  index: number
  tMs: number
  x: number
  y: number
  button: "left" | "right" | "middle"
}

interface SmoothedPositions {
  x: Float64Array
  y: Float64Array
}

const DEFAULT_JITTER_THRESHOLD_PX = 1.0
const DEFAULT_MOTION_THRESHOLD_PX = 1.5
const DEFAULT_IDLE_FADE_MS = 400
const DEFAULT_CLICK_DURATION_MS = 350
const DEFAULT_GAP_MULTIPLIER = 8
const MIN_GAP_THRESHOLD_MS = 120
const ADAPTIVE_SPEED_REF_PX_PER_SEC = 2000

// Kept only for non-browser callers and the short period before the WASM
// adapter finishes loading; preview/export use the Rust implementation when available.
function isEvaluableMotionSegment(segment: RenderPlanZoomMotionPlan["segments"][number]): boolean {
  return (
    segment.endMs > segment.startMs &&
    [segment.start, segment.control1, segment.control2, segment.end].every(
      (point) => Number.isFinite(point.x) && Number.isFinite(point.y),
    )
  )
}

function evaluateCubicMotionPlanFallback(
  motionPlan: RenderPlanZoomMotionPlan,
  timeMs: number,
): RenderPlanZoomMotionPoint | null {
  if (
    motionPlan.version !== 1 ||
    motionPlan.kind !== "cubic-bezier" ||
    motionPlan.segments.length === 0
  ) {
    return null
  }

  const first = motionPlan.segments[0]
  const last = motionPlan.segments[motionPlan.segments.length - 1]
  if (!isEvaluableMotionSegment(first) || !isEvaluableMotionSegment(last)) return null

  const safeTimeMs = Number.isFinite(timeMs) ? timeMs : first.startMs
  if (safeTimeMs <= first.startMs) return first.start
  if (safeTimeMs >= last.endMs) return last.end

  let low = 0
  let high = motionPlan.segments.length - 1
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (safeTimeMs <= motionPlan.segments[middle].endMs) high = middle
    else low = middle + 1
  }

  const segment = motionPlan.segments[low]
  if (!isEvaluableMotionSegment(segment)) return null
  const durationMs = Math.max(1, segment.endMs - segment.startMs)
  const progress = Math.min(1, Math.max(0, (safeTimeMs - segment.startMs) / durationMs))
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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function parseClickButton(event: CursorTelemetryEvent): "left" | "right" | "middle" {
  const be = event.buttonEvent ?? "none"
  const prefix = be.split("-")[0]
  if (prefix === "left" || prefix === "right" || prefix === "middle") return prefix

  return "left"
}

function isClickEdge(event: CursorTelemetryEvent): boolean {
  const be = event.buttonEvent ?? "none"
  return be !== "none" && be.endsWith("-down")
}

function getSmoothingAlpha(settings: CursorSettings): number {
  if (!settings.smoothMovement) return 1
  return clamp(settings.smoothFactor ?? defaultCursorSettings.smoothFactor, 0.05, 1)
}

function getClickDuration(settings: CursorSettings): number {
  return settings.clickDurationMs ?? DEFAULT_CLICK_DURATION_MS
}

function getEffectiveShapeId(event: PreparedEvent): string {
  if (event.shapeId && event.shapeId.length > 0) return event.shapeId
  return ""
}

export interface CursorEngine {
  evaluate: (timeMs: number, settings: CursorSettings) => CursorFrame
  evaluateMotionPlan: (
    timeMs: number,
    motionPlan: RenderPlanZoomMotionPlan,
  ) => RenderPlanZoomMotionPoint | null
  telemetry: CursorTelemetryFile
}

export function createCursorEngine(
  telemetry: CursorTelemetryFile,
  options: CursorEngineOptions = {},
): CursorEngine {
  const events = telemetry.events
  const count = events.length

  if (count === 0) {
    return {
      evaluate: () => ({
        sourceTimeMs: 0,
        sourceX: 0,
        sourceY: 0,
        visible: false,
        opacity: 0,
        shapeId: "",
        isIdle: false,
        activeClicks: [],
        velocityPxPerSec: 0,
      }),
      evaluateMotionPlan: (timeMs, motionPlan) =>
        evaluateCubicMotionPlanFallback(motionPlan, timeMs),
      telemetry,
    }
  }

  const expectedIntervalMs = telemetry.sampleRateHz ? 1000 / telemetry.sampleRateHz : 1000 / 60
  const gapThresholdMs = Math.max(
    options.gapThresholdMs ?? expectedIntervalMs * DEFAULT_GAP_MULTIPLIER,
    MIN_GAP_THRESHOLD_MS,
  )
  const jitterThresholdPx = options.jitterThresholdPx ?? DEFAULT_JITTER_THRESHOLD_PX
  const motionThresholdPx = options.motionThresholdPx ?? DEFAULT_MOTION_THRESHOLD_PX
  const idleFadeDurationMs = options.idleFadeDurationMs ?? DEFAULT_IDLE_FADE_MS

  const prepared: PreparedEvent[] = new Array(count)
  const times: number[] = new Array(count)
  const segmentStartIndex: number[] = new Array(count)
  const segmentEndIndex: number[] = new Array(count)
  const clicks: ClickEntry[] = []
  // Smoothing is deterministic for a segment and settings pair. Cache the
  // zero-phase pass so frame-by-frame playback does not rescan a 60-minute
  // telemetry stream on every render tick.
  const smoothingCache = new Map<string, SmoothedPositions>()

  let currentSegmentId = 0

  for (let index = 0; index < count; index++) {
    const event = events[index]
    const rawX = event.rawX
    const rawY = event.rawY
    const sourceX = event.sourceX
    const sourceY = event.sourceY
    const click = isClickEdge(event)
    const clickButton = parseClickButton(event)

    let denoisedX = sourceX
    let denoisedY = sourceY

    if (index > 0) {
      const previous = prepared[index - 1]
      const dt = event.tMs - previous.tMs
      const dx = sourceX - previous.denoisedX
      const dy = sourceY - previous.denoisedY
      const displacement = Math.hypot(dx, dy)

      if (click || event.shapeChanged) {
        // Hard physical anchor for clicks and shape changes
        denoisedX = sourceX
        denoisedY = sourceY
      } else if (
        dt < expectedIntervalMs * 2.5 &&
        displacement < jitterThresholdPx &&
        jitterThresholdPx > 0
      ) {
        // Continuous quadratic attenuation below jitter threshold (no staircasing)
        const factor = Math.pow(displacement / jitterThresholdPx, 2)
        denoisedX = previous.denoisedX + dx * factor
        denoisedY = previous.denoisedY + dy * factor
      } else {
        denoisedX = sourceX
        denoisedY = sourceY
      }
    }

    let speedPxPerSec = 0
    if (index > 0) {
      const previous = prepared[index - 1]
      const dt = event.tMs - previous.tMs
      if (dt > 0) {
        const dx = denoisedX - previous.denoisedX
        const dy = denoisedY - previous.denoisedY
        speedPxPerSec = (Math.hypot(dx, dy) / dt) * 1000
      }
    }

    if (index > 0) {
      const previous = prepared[index - 1]
      const dt = event.tMs - previous.tMs
      if (dt >= gapThresholdMs) {
        currentSegmentId += 1
      }
    }

    segmentStartIndex[index] =
      index === 0 || prepared[index - 1].segmentId !== currentSegmentId
        ? index
        : segmentStartIndex[index - 1]

    let isMotion = false
    if (index === 0) {
      isMotion = true
    } else {
      const previous = prepared[index - 1]
      const dx = denoisedX - previous.denoisedX
      const dy = denoisedY - previous.denoisedY
      const displacement = Math.hypot(dx, dy)
      isMotion = displacement > motionThresholdPx || click || event.shapeChanged
    }

    const lastMotionMs = isMotion
      ? event.tMs
      : index > 0
        ? prepared[index - 1].lastMotionMs
        : event.tMs

    if (click) {
      clicks.push({
        index,
        tMs: event.tMs,
        x: denoisedX,
        y: denoisedY,
        button: clickButton,
      })
    }

    prepared[index] = {
      tMs: event.tMs,
      rawX,
      rawY,
      denoisedX,
      denoisedY,
      visible: event.visible,
      shapeId: event.shapeId,
      shapeChanged: event.shapeChanged,
      buttonEvent: event.buttonEvent,
      segmentId: currentSegmentId,
      speedPxPerSec,
      isMotion,
      lastMotionMs,
      isClickEdge: click,
      clickButton,
    }

    times[index] = event.tMs
  }

  let currentStart = 0
  for (let i = 0; i < count; i++) {
    if (i === count - 1 || segmentStartIndex[i + 1] !== segmentStartIndex[i]) {
      for (let j = currentStart; j <= i; j++) {
        segmentEndIndex[j] = i
      }
      currentStart = i + 1
    }
  }

  function findEventIndex(timeMs: number): number {
    if (timeMs <= times[0]) return 0
    if (timeMs >= times[count - 1]) return count - 1

    let low = 0
    let high = count - 1
    while (low < high) {
      const mid = low + Math.floor((high - low + 1) / 2)
      if (times[mid] <= timeMs) {
        low = mid
      } else {
        high = mid - 1
      }
    }
    return low
  }

  function getSmoothedPositions(
    segStart: number,
    segEnd: number,
    alpha: number,
  ): SmoothedPositions {
    const key = `${segStart}:${segEnd}:${alpha}`
    const cached = smoothingCache.get(key)
    if (cached) return cached

    const segLen = segEnd - segStart + 1
    const forwardX = new Float64Array(segLen)
    const forwardY = new Float64Array(segLen)

    // Forward pass of zero-phase bidirectional smoothing. This is computed once
    // per segment/settings pair and reused for every output frame.
    for (let i = segStart; i <= segEnd; i++) {
      const relI = i - segStart
      const ev = prepared[i]
      const x = ev.denoisedX
      const y = ev.denoisedY

      if (i === segStart || ev.isClickEdge || alpha >= 1) {
        forwardX[relI] = x
        forwardY[relI] = y
      } else {
        const prevFx = forwardX[relI - 1]
        const prevFy = forwardY[relI - 1]
        const dt = Math.max(1, ev.tMs - prepared[i - 1].tMs)
        const speedFactor = ev.speedPxPerSec / ADAPTIVE_SPEED_REF_PX_PER_SEC
        const sampleAlpha = clamp(alpha * (1 + speedFactor), 0.05, 1)
        const rate = clamp(dt / expectedIntervalMs, 0.1, 5)
        const lambda = clamp(1 - Math.pow(1 - sampleAlpha, rate), 0.05, 1)

        forwardX[relI] = prevFx + (x - prevFx) * lambda
        forwardY[relI] = prevFy + (y - prevFy) * lambda
      }
    }

    const smoothedX = new Float64Array(segLen)
    const smoothedY = new Float64Array(segLen)

    // Backward pass removes phase lag without making evaluation stateful.
    for (let relI = segLen - 1; relI >= 0; relI--) {
      const absI = segStart + relI
      const ev = prepared[absI]
      const fx = forwardX[relI]
      const fy = forwardY[relI]

      if (relI === segLen - 1 || ev.isClickEdge || alpha >= 1) {
        smoothedX[relI] = fx
        smoothedY[relI] = fy
      } else {
        const nextBx = smoothedX[relI + 1]
        const nextBy = smoothedY[relI + 1]
        const dt = Math.max(1, prepared[absI + 1].tMs - ev.tMs)
        const speedFactor = ev.speedPxPerSec / ADAPTIVE_SPEED_REF_PX_PER_SEC
        const sampleAlpha = clamp(alpha * (1 + speedFactor), 0.05, 1)
        const rate = clamp(dt / expectedIntervalMs, 0.1, 5)
        const lambda = clamp(1 - Math.pow(1 - sampleAlpha, rate), 0.05, 1)

        smoothedX[relI] = nextBx + (fx - nextBx) * lambda
        smoothedY[relI] = nextBy + (fy - nextBy) * lambda
      }
    }

    const result = { x: smoothedX, y: smoothedY }
    // Settings usually have only the base and strong presets. Bound the cache
    // so unusual per-range values cannot retain unbounded telemetry arrays.
    if (smoothingCache.size >= 8) {
      const oldest = smoothingCache.keys().next().value
      if (oldest !== undefined) smoothingCache.delete(oldest)
    }
    smoothingCache.set(key, result)
    return result
  }

  function evaluateSplinePosition(
    index: number,
    timeMs: number,
    settings: CursorSettings,
  ): CursorPoint {
    const segStart = segmentStartIndex[index]
    const segEnd = segmentEndIndex[index]

    if (segStart === segEnd) {
      return { x: prepared[segStart].denoisedX, y: prepared[segStart].denoisedY }
    }

    const alpha = getSmoothingAlpha(settings)
    const segLen = segEnd - segStart + 1
    const { x: smoothedX, y: smoothedY } = getSmoothedPositions(segStart, segEnd, alpha)

    // Time-aware Catmull-Rom interpolation gives the renderer a continuous
    // path between high-frequency samples instead of a staircase of segments.
    const k = index
    const kRel = k - segStart
    const t0 = prepared[k].tMs

    if (k === segEnd || timeMs <= t0) {
      return { x: smoothedX[kRel], y: smoothedY[kRel] }
    }

    const k1 = k + 1
    const k1Rel = k1 - segStart
    const t1 = prepared[k1].tMs

    const u = t1 <= t0 ? 0 : clamp((timeMs - t0) / (t1 - t0), 0, 1)

    const p1X = smoothedX[kRel]
    const p1Y = smoothedY[kRel]
    const p2X = smoothedX[k1Rel]
    const p2Y = smoothedY[k1Rel]

    const p0X = kRel > 0 ? smoothedX[kRel - 1] : p1X - (p2X - p1X)
    const p0Y = kRel > 0 ? smoothedY[kRel - 1] : p1Y - (p2Y - p1Y)
    const p3X = k1Rel + 1 < segLen ? smoothedX[k1Rel + 1] : p2X + (p2X - p1X)
    const p3Y = k1Rel + 1 < segLen ? smoothedY[k1Rel + 1] : p2Y + (p2Y - p1Y)

    // Cardinal Catmull-Rom expressed as a time-aware cubic Hermite curve.
    // Irregular polling intervals therefore affect tangents by duration, not
    // by array index, eliminating timing-dependent bends and phase lag.
    const previousTime = kRel > 0 ? prepared[k - 1].tMs : t0 - (t1 - t0)
    const nextTime = k1Rel + 1 < segLen ? prepared[k1 + 1].tMs : t1 + (t1 - t0)
    const interval = Math.max(1, t1 - t0)
    const tangent1Scale = interval / Math.max(1, t1 - previousTime)
    const tangent2Scale = interval / Math.max(1, nextTime - t0)
    const tangent1X = (p2X - p0X) * tangent1Scale
    const tangent1Y = (p2Y - p0Y) * tangent1Scale
    const tangent2X = (p3X - p1X) * tangent2Scale
    const tangent2Y = (p3Y - p1Y) * tangent2Scale

    const u2 = u * u
    const u3 = u2 * u
    const h00 = 2 * u3 - 3 * u2 + 1
    const h10 = u3 - 2 * u2 + u
    const h01 = -2 * u3 + 3 * u2
    const h11 = u3 - u2

    return {
      x: h00 * p1X + h10 * tangent1X + h01 * p2X + h11 * tangent2X,
      y: h00 * p1Y + h10 * tangent1Y + h01 * p2Y + h11 * tangent2Y,
    }
  }

  function activeClicks(timeMs: number, settings: CursorSettings): CursorClickEffect[] {
    if (settings.clickFeedback === "none") return []

    const duration = getClickDuration(settings)
    if (duration <= 0) return []

    const result: CursorClickEffect[] = []
    let low = 0
    let high = clicks.length
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2)
      if (clicks[middle].tMs <= timeMs) low = middle + 1
      else high = middle
    }

    // Clicks are sparse; seek to the last eligible click before scanning the
    // short active window instead of walking every future click at t=0.
    for (let i = low - 1; i >= 0; i--) {
      const click = clicks[i]
      const elapsed = timeMs - click.tMs
      if (elapsed > duration) break

      if (click.button === "left" && !settings.leftClickEnabled) continue
      if (click.button === "right" && !settings.rightClickEnabled) continue

      const progress = elapsed / duration
      const intensity = 1 - progress
      result.push({
        button: click.button,
        startMs: click.tMs,
        sourceX: click.x,
        sourceY: click.y,
        progress,
        intensity,
      })
    }

    return result.reverse()
  }

  function evaluate(timeMs: number, settings: CursorSettings): CursorFrame {
    const index = findEventIndex(timeMs)
    const event = prepared[index]

    const point = evaluateSplinePosition(index, timeMs, settings)

    const velocityPxPerSec = event.speedPxPerSec

    const idleDuration = Math.max(0, timeMs - event.lastMotionMs)
    const idleTimeoutMs = settings.autoHideIdle ? settings.idleTimeoutMs : 0
    const isIdle = idleTimeoutMs > 0 && idleDuration > idleTimeoutMs

    let opacity = 1
    if (isIdle && idleFadeDurationMs > 0) {
      const fadeProgress = clamp((idleDuration - idleTimeoutMs) / idleFadeDurationMs, 0, 1)
      opacity = 1 - fadeProgress
    } else if (isIdle) {
      opacity = 0
    }

    const visible = settings.enabled && event.visible && opacity > 0

    return {
      sourceTimeMs: timeMs,
      sourceX: point.x,
      sourceY: point.y,
      visible,
      opacity,
      shapeId: getEffectiveShapeId(event),
      isIdle,
      activeClicks: activeClicks(timeMs, settings),
      velocityPxPerSec,
    }
  }

  return {
    evaluate,
    evaluateMotionPlan: (timeMs, motionPlan) => evaluateCubicMotionPlanFallback(motionPlan, timeMs),
    telemetry,
  }
}
