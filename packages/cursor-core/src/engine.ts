import {
  defaultCursorSettings,
  type CursorSettings,
  type CursorTelemetryEvent,
  type CursorTelemetryFile,
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

const DEFAULT_SMOOTHING_WINDOW = 12
const DEFAULT_JITTER_THRESHOLD_PX = 1.0
const DEFAULT_MOTION_THRESHOLD_PX = 1.5
const DEFAULT_IDLE_FADE_MS = 400
const DEFAULT_CLICK_DURATION_MS = 350
const DEFAULT_GAP_MULTIPLIER = 8
const MIN_GAP_THRESHOLD_MS = 120
const JITTER_INTERVAL_MULTIPLIER = 2
const ADAPTIVE_SPEED_REF_PX_PER_SEC = 2000

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function distance(left: CursorPoint, right: CursorPoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y)
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
  const smoothingWindowSize = options.smoothingWindowSize ?? DEFAULT_SMOOTHING_WINDOW
  const idleFadeDurationMs = options.idleFadeDurationMs ?? DEFAULT_IDLE_FADE_MS

  const prepared: PreparedEvent[] = new Array(count)
  const times: number[] = new Array(count)
  const segmentStartIndex: number[] = new Array(count)
  const clicks: ClickEntry[] = []

  let currentSegmentId = 0

  for (let index = 0; index < count; index++) {
    const event = events[index]
    const rawX = event.rawX
    const rawY = event.rawY
    const sourceX = event.sourceX
    const sourceY = event.sourceY

    let denoisedX = sourceX
    let denoisedY = sourceY

    if (index > 0) {
      const previous = prepared[index - 1]
      const dt = event.tMs - previous.tMs
      const displacement = distance(
        { x: rawX, y: rawY },
        { x: previous.denoisedX, y: previous.denoisedY },
      )

      if (
        dt < expectedIntervalMs * JITTER_INTERVAL_MULTIPLIER &&
        displacement < jitterThresholdPx
      ) {
        denoisedX = previous.denoisedX
        denoisedY = previous.denoisedY
      }
    }

    let speedPxPerSec = 0
    if (index > 0) {
      const previous = prepared[index - 1]
      const dt = event.tMs - previous.tMs
      if (dt > 0) {
        const displacement = distance(
          { x: denoisedX, y: denoisedY },
          { x: previous.denoisedX, y: previous.denoisedY },
        )
        speedPxPerSec = (displacement / dt) * 1000
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

    const click = isClickEdge(event)
    const clickButton = parseClickButton(event)

    let isMotion = false
    if (index === 0) {
      isMotion = true
    } else {
      const previous = prepared[index - 1]
      const displacement = distance(
        { x: denoisedX, y: denoisedY },
        { x: previous.denoisedX, y: previous.denoisedY },
      )
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

  function smoothPosition(index: number, settings: CursorSettings): CursorPoint {
    const alpha = getSmoothingAlpha(settings)
    if (alpha >= 1) {
      return { x: prepared[index].denoisedX, y: prepared[index].denoisedY }
    }

    const segmentStart = segmentStartIndex[index]
    const start = Math.max(segmentStart, index - smoothingWindowSize + 1)

    let sumX = 0
    let sumY = 0
    let totalWeight = 0

    for (let i = start; i <= index; i++) {
      const lag = index - i
      // Per-sample adaptive weighting: higher speed reduces smoothing.
      const speedFactor = prepared[i].speedPxPerSec / ADAPTIVE_SPEED_REF_PX_PER_SEC
      const sampleAlpha = clamp(alpha * (1 + speedFactor), 0.05, 1)
      const weight = Math.pow(1 - sampleAlpha, lag)
      sumX += prepared[i].denoisedX * weight
      sumY += prepared[i].denoisedY * weight
      totalWeight += weight
    }

    if (totalWeight > 0) {
      return { x: sumX / totalWeight, y: sumY / totalWeight }
    }

    return { x: prepared[index].denoisedX, y: prepared[index].denoisedY }
  }

  function activeClicks(timeMs: number, settings: CursorSettings): CursorClickEffect[] {
    if (settings.clickFeedback === "none") return []

    const duration = getClickDuration(settings)
    if (duration <= 0) return []

    const result: CursorClickEffect[] = []

    // Clicks are sparse; scan backward from the end until we are outside the window.
    for (let i = clicks.length - 1; i >= 0; i--) {
      const click = clicks[i]
      if (click.tMs > timeMs) continue
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

    // Do not interpolate across a gap or beyond the last sample.
    let nextIndex = index + 1
    if (nextIndex >= count || times[nextIndex] - times[index] > gapThresholdMs) {
      nextIndex = index
    }

    const t0 = times[index]
    const t1 = times[nextIndex]
    const fraction = t1 === t0 || nextIndex === index ? 0 : clamp((timeMs - t0) / (t1 - t0), 0, 1)

    const p0 = smoothPosition(index, settings)
    const p1 = nextIndex === index ? p0 : smoothPosition(nextIndex, settings)

    const sourceX = p0.x + (p1.x - p0.x) * fraction
    const sourceY = p0.y + (p1.y - p0.y) * fraction

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
      sourceX,
      sourceY,
      visible,
      opacity,
      shapeId: getEffectiveShapeId(event),
      isIdle,
      activeClicks: activeClicks(timeMs, settings),
      velocityPxPerSec,
    }
  }

  return { evaluate, telemetry }
}
