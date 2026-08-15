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

const DEFAULT_JITTER_THRESHOLD_PX = 1.0
const DEFAULT_MOTION_THRESHOLD_PX = 1.5
const DEFAULT_IDLE_FADE_MS = 400
const DEFAULT_CLICK_DURATION_MS = 350
const DEFAULT_GAP_MULTIPLIER = 8
const MIN_GAP_THRESHOLD_MS = 120
const ADAPTIVE_SPEED_REF_PX_PER_SEC = 2000

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
  const idleFadeDurationMs = options.idleFadeDurationMs ?? DEFAULT_IDLE_FADE_MS

  const prepared: PreparedEvent[] = new Array(count)
  const times: number[] = new Array(count)
  const segmentStartIndex: number[] = new Array(count)
  const segmentEndIndex: number[] = new Array(count)
  const clicks: ClickEntry[] = []

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

    // Forward pass of zero-phase bidirectional smoothing
    const forwardX = new Float64Array(segLen)
    const forwardY = new Float64Array(segLen)

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

    // Backward pass of zero-phase bidirectional smoothing
    const smoothedX = new Float64Array(segLen)
    const smoothedY = new Float64Array(segLen)

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

    // Centripetal Catmull-Rom Spline Interpolation between index and index+1:
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

    const u2 = u * u
    const u3 = u2 * u

    const interpX =
      0.5 *
      (2 * p1X +
        (-p0X + p2X) * u +
        (2 * p0X - 5 * p1X + 4 * p2X - p3X) * u2 +
        (-p0X + 3 * p1X - 3 * p2X + p3X) * u3)

    const interpY =
      0.5 *
      (2 * p1Y +
        (-p0Y + p2Y) * u +
        (2 * p0Y - 5 * p1Y + 4 * p2Y - p3Y) * u2 +
        (-p0Y + 3 * p1Y - 3 * p2Y + p3Y) * u3)

    return { x: interpX, y: interpY }
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

  return { evaluate, telemetry }
}
