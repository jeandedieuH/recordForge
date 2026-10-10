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
  /** Ease-out-cubic expansion factor: `1 - (1 - p)^3`. */
  expand: number
  /** Quadratic fade factor: `(1 - p)^2`. */
  fade: number
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
  clickScale: number
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
  /** Idle gap that preceded the most recent motion event; 0 while still moving. */
  motionGapMs: number
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
// Smoothing strength is derived from wall-clock sample spacing against this
// fixed interval rather than the telemetry's declared rate, so a preset feels
// identical on 60 Hz and 120 Hz captures.
const SMOOTHING_REFERENCE_INTERVAL_MS = 1_000 / 60
const IDLE_FADE_IN_MS = 150

// Button-aware press model. Mirrors packages/cursor-engine/src/lib.rs.
const PRESS_SCALE = 0.8 // cursor scale while an enabled button is held
// Taps shorter than this are stretched so the press stays visible at video
// frame rates.
const PRESS_MIN_HOLD_MS = 90
// Press-in spring (rad/s); near critical damping, no visible undershoot.
const PRESS_IN_OMEGA = 70
const PRESS_IN_ZETA = 0.92
// Release spring (rad/s); under-damped, one soft overshoot peaking near 1.041.
const PRESS_OUT_OMEGA = 24
const PRESS_OUT_ZETA = 0.45
// Gap after which the spring is back at rest (residual < 1e-4); also the
// fast-path cutoff for frames far from any press.
const PRESS_SETTLE_MS = 700
// Cap on presses replayed into a single evaluation.
const PRESS_MAX_CHAIN = 64
const PRESS_SCALE_MIN = 0.5
const PRESS_SCALE_MAX = 1.25

interface PressInterval {
  startMs: number
  endMs: number
}

type PressPhase = "down" | "up" | "held" | "none"

function pressPhase(buttonEvent: string): PressPhase {
  if (buttonEvent === "down" || buttonEvent.endsWith("-down")) return "down"
  if (buttonEvent === "up" || buttonEvent.endsWith("-up")) return "up"
  if (buttonEvent === "held" || buttonEvent.endsWith("-held")) return "held"
  return "none"
}

/**
 * One closed-form step of an underdamped spring (zeta < 1, unit mass). `tau`
 * is in seconds; `tau <= 0` returns the state unchanged so the value at a
 * press edge is exact.
 */
function springStep(
  x: number,
  v: number,
  target: number,
  tau: number,
  omega: number,
  zeta: number,
): [number, number] {
  if (tau <= 0) return [x, v]
  const e0 = x - target
  const d = Math.exp(-zeta * omega * tau)
  const wd = omega * Math.sqrt(1 - zeta * zeta)
  const cos = Math.cos(wd * tau)
  const sin = Math.sin(wd * tau)
  return [
    target + d * (e0 * cos + ((v + zeta * omega * e0) / wd) * sin),
    d * (v * cos - ((omega * omega * e0 + zeta * omega * v) / wd) * sin),
  ]
}

// Shared by the TS engine and the WASM wrapper: motion-plan evaluation is pure
// math over an already-parsed plan, so both engines call the TypeScript mirror
// and skip a WASM round-trip per seek.
function isEvaluableMotionSegment(segment: RenderPlanZoomMotionPlan["segments"][number]): boolean {
  return (
    segment.endMs > segment.startMs &&
    [segment.start, segment.control1, segment.control2, segment.end].every(
      (point) => Number.isFinite(point.x) && Number.isFinite(point.y),
    )
  )
}

/**
 * TypeScript mirror of the Rust `evaluate_cubic_motion_plan`. Preview uses this
 * directly even on the WASM engine so motion-plan seeks never cross the bridge;
 * the parity suite checks it against the Rust binding.
 */
export function evaluateCubicMotionPlan(
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
  /** Release held resources (the WASM heap allocation). Optional for engines
   *  with nothing to free; must be idempotent when present. */
  dispose?: () => void
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
        clickScale: 1,
      }),
      evaluateMotionPlan: (timeMs, motionPlan) => evaluateCubicMotionPlan(motionPlan, timeMs),
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

    let isMotion: boolean
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

    // The idle gap that this motion event ended; non-motion events inherit the
    // gap of their last motion so the fade-in check stays stateless.
    const motionGapMs =
      index === 0
        ? 0
        : isMotion
          ? event.tMs - prepared[index - 1].lastMotionMs
          : prepared[index - 1].motionGapMs

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
      motionGapMs,
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

  // Derive [down, up] press windows per button class. A `-held` sample implies
  // an ongoing press, a `-up` or an ordinary sample closes it, and a segment
  // break closes everything at the last event before the gap because the
  // button state across it is unknown.
  const pressButtons = ["left", "right", "middle"] as const
  const pressClassIndex: Record<(typeof pressButtons)[number], number> = {
    left: 0,
    right: 1,
    middle: 2,
  }
  const rawPresses: { button: (typeof pressButtons)[number]; startMs: number; endMs: number }[] = []
  const openPresses: (number | null)[] = [null, null, null]
  const closeOpenPresses = (endMs: number) => {
    for (let slot = 0; slot < pressButtons.length; slot++) {
      const startMs = openPresses[slot]
      if (startMs !== null) {
        rawPresses.push({ button: pressButtons[slot], startMs, endMs })
        openPresses[slot] = null
      }
    }
  }
  for (let index = 0; index < count; index++) {
    const event = prepared[index]
    if (index > 0 && event.segmentId !== prepared[index - 1].segmentId) {
      closeOpenPresses(prepared[index - 1].tMs)
    }
    const phase = pressPhase(event.buttonEvent)
    const classIndex = pressClassIndex[event.clickButton]
    if (phase === "down" || phase === "held") {
      if (openPresses[classIndex] === null) openPresses[classIndex] = event.tMs
    } else if (phase === "up") {
      const startMs = openPresses[classIndex]
      if (startMs !== null) {
        rawPresses.push({ button: event.clickButton, startMs, endMs: event.tMs })
        openPresses[classIndex] = null
      }
    } else {
      closeOpenPresses(event.tMs)
    }
  }
  closeOpenPresses(prepared[count - 1].tMs)

  // Merge each settings mask's presses into sorted, non-overlapping intervals,
  // stretching short taps to the minimum hold. Index = left | right << 1;
  // middle presses are always included, matching the click-effect gating.
  const pressIntervals: PressInterval[][] = [0, 1, 2, 3].map((mask) => {
    const leftEnabled = (mask & 1) !== 0
    const rightEnabled = (mask & 2) !== 0
    const stretched = rawPresses
      .filter((press) =>
        press.button === "left" ? leftEnabled : press.button === "right" ? rightEnabled : true,
      )
      .map((press) => ({
        startMs: press.startMs,
        endMs: Math.max(press.endMs, press.startMs + PRESS_MIN_HOLD_MS),
      }))
      .sort((left, right) => left.startMs - right.startMs)
    const intervals: PressInterval[] = []
    for (const interval of stretched) {
      const last = intervals[intervals.length - 1]
      if (last && interval.startMs <= last.endMs) {
        last.endMs = Math.max(last.endMs, interval.endMs)
      } else {
        intervals.push({ ...interval })
      }
    }
    return intervals
  })

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
        const rawAlpha = alpha * (1 + ev.speedPxPerSec / ADAPTIVE_SPEED_REF_PX_PER_SEC)
        const sampleAlpha = rawAlpha < 0.05 ? 0.05 : rawAlpha > 1 ? 1 : rawAlpha
        // Time-based rate: dt measured against the fixed 60 Hz reference so
        // lambda = 1 - (1-a)^(dt/ref) behaves identically at any capture rate.
        const rawRate = dt / SMOOTHING_REFERENCE_INTERVAL_MS
        const rate = rawRate < 0.1 ? 0.1 : rawRate > 5 ? 5 : rawRate
        const rawLambda = rate === 1 ? sampleAlpha : 1 - Math.pow(1 - sampleAlpha, rate)
        const lambda = rawLambda < 0.01 ? 0.01 : rawLambda > 1 ? 1 : rawLambda

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
        const rawAlpha = alpha * (1 + ev.speedPxPerSec / ADAPTIVE_SPEED_REF_PX_PER_SEC)
        const sampleAlpha = rawAlpha < 0.05 ? 0.05 : rawAlpha > 1 ? 1 : rawAlpha
        // Same fixed reference interval as the forward pass.
        const rawRate = dt / SMOOTHING_REFERENCE_INTERVAL_MS
        const rate = rawRate < 0.1 ? 0.1 : rawRate > 5 ? 5 : rawRate
        const rawLambda = rate === 1 ? sampleAlpha : 1 - Math.pow(1 - sampleAlpha, rate)
        const lambda = rawLambda < 0.01 ? 0.01 : rawLambda > 1 ? 1 : rawLambda

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
      // Expansion/fade easing shared with the Rust engine and the exporter.
      const expand = 1 - (1 - progress) ** 3
      const fade = (1 - progress) ** 2
      result.push({
        button: click.button,
        startMs: click.tMs,
        sourceX: click.x,
        sourceY: click.y,
        progress,
        intensity,
        expand,
        fade,
      })
    }

    return result.reverse()
  }

  // Button-aware press model: a damped spring whose target is PRESS_SCALE
  // while any enabled button is held and 1.0 otherwise. Evaluated in closed
  // form per press interval, so position and velocity carry across presses
  // (C1 continuity) and double clicks interrupt each other naturally — all
  // without evaluation state. Off only when explicitly disabled; an absent
  // flag follows the on-by-default contract of the Rust engine and the
  // inspector.
  function calculateClickScale(timeMs: number, settings: CursorSettings): number {
    if (settings.clickPressAnimation === false) return 1.0

    const mask = (settings.leftClickEnabled ? 1 : 0) | (settings.rightClickEnabled ? 2 : 0)
    const intervals = pressIntervals[mask]
    if (intervals.length === 0) return 1.0

    // Last press that started at or before this time.
    let low = 0
    let high = intervals.length
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2)
      if (intervals[middle].startMs <= timeMs) low = middle + 1
      else high = middle
    }
    const k = low - 1
    if (k < 0) return 1.0
    // Well past the last press the spring is at rest; no replay needed.
    if (timeMs - intervals[k].endMs >= PRESS_SETTLE_MS) return 1.0

    // Walk back to the first press in the chain of nearby presses; the spring
    // is assumed at rest before it.
    let j = k
    while (
      j > 0 &&
      k - j < PRESS_MAX_CHAIN &&
      intervals[j].startMs - intervals[j - 1].endMs < PRESS_SETTLE_MS
    ) {
      j--
    }

    let x = 1.0
    let v = 0.0
    for (let i = j; i <= k; i++) {
      const interval = intervals[i]
      const pressed = springStep(
        x,
        v,
        PRESS_SCALE,
        (Math.min(interval.endMs, timeMs) - interval.startMs) / 1000,
        PRESS_IN_OMEGA,
        PRESS_IN_ZETA,
      )
      x = pressed[0]
      v = pressed[1]
      if (timeMs <= interval.endMs) return clamp(x, PRESS_SCALE_MIN, PRESS_SCALE_MAX)
      const releaseEnd = i < k ? intervals[i + 1].startMs : timeMs
      const released = springStep(
        x,
        v,
        1.0,
        (releaseEnd - interval.endMs) / 1000,
        PRESS_OUT_OMEGA,
        PRESS_OUT_ZETA,
      )
      x = released[0]
      v = released[1]
    }
    return clamp(x, PRESS_SCALE_MIN, PRESS_SCALE_MAX)
  }

  function applyClickMovement(
    timeMs: number,
    settings: CursorSettings,
    point: { x: number; y: number },
  ): { x: number; y: number } {
    const DWELL_HOLD_MS = 50.0
    const DWELL_TOTAL_MS = 160.0
    const DWELL_RELEASE_MS = DWELL_TOTAL_MS - DWELL_HOLD_MS

    let low = 0
    let high = clicks.length
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2)
      if (clicks[middle].tMs <= timeMs) low = middle + 1
      else high = middle
    }

    let x = point.x
    let y = point.y

    // Search for the most recent click within the dwell window
    for (let i = low - 1; i >= 0; i--) {
      const click = clicks[i]
      const elapsed = timeMs - click.tMs
      if (elapsed > DWELL_TOTAL_MS) break
      if (elapsed < 0) continue

      if (click.button === "left" && !settings.leftClickEnabled) continue
      if (click.button === "right" && !settings.rightClickEnabled) continue

      // Click dwell stabilization in smoothed movement modes
      if (settings.smoothMovement) {
        if (elapsed <= DWELL_HOLD_MS) {
          x = click.x
          y = click.y
        } else {
          const u = clamp((elapsed - DWELL_HOLD_MS) / DWELL_RELEASE_MS, 0, 1)
          const blend = u * u * (3 - 2 * u)
          x = click.x + (x - click.x) * blend
          y = click.y + (y - click.y) * blend
        }
      }

      break // Anchored to most recent active click
    }

    return { x, y }
  }

  function evaluate(timeMs: number, settings: CursorSettings): CursorFrame {
    const index = findEventIndex(timeMs)
    const event = prepared[index]

    const rawPoint = evaluateSplinePosition(index, timeMs, settings)

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
    } else if (idleTimeoutMs > 0 && event.motionGapMs > idleTimeoutMs) {
      // Motion resumed after an idle gap: replay the faded opacity backwards
      // over a fixed 150ms fade-in instead of popping straight back to 1.
      const opacityBefore =
        idleFadeDurationMs > 0
          ? 1 - clamp((event.motionGapMs - idleTimeoutMs) / idleFadeDurationMs, 0, 1)
          : 0
      const fadeIn = clamp((timeMs - event.lastMotionMs) / IDLE_FADE_IN_MS, 0, 1)
      opacity = opacityBefore + (1 - opacityBefore) * fadeIn
    }

    const visible = settings.enabled && event.visible && opacity > 0
    const clickScale = calculateClickScale(timeMs, settings)

    const point =
      settings.clickPressAnimation !== false
        ? applyClickMovement(timeMs, settings, rawPoint)
        : rawPoint

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
      clickScale,
    }
  }

  return {
    evaluate,
    evaluateMotionPlan: (timeMs, motionPlan) => evaluateCubicMotionPlan(motionPlan, timeMs),
    telemetry,
  }
}
