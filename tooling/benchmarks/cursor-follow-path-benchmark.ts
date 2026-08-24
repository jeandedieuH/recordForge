import {
  buildFollowCursorMotionPlan,
  resolveFollowCursorTarget,
  resolveFollowCursorMotionPlanTargetAtTime,
} from "@recordforge/editor-core"
import { createCursorEngine, type CursorEngine } from "@recordforge/cursor-core"
import {
  defaultCursorSettings,
  type CursorTelemetryFile,
  type ManualZoomSegment,
  type TimelineState,
  type ZoomTarget,
} from "@recordforge/domain"

const REFERENCE_STEP_MS = 100
const MOTION_PLAN_TOLERANCE_PX = 2
const BENCHMARK_DURATIONS_MS = [60_000, 5 * 60_000, 30 * 60_000]

interface DenseReferenceSample {
  timeMs: number
  target: ZoomTarget
}

interface PathMetrics {
  lengthPx: number
  totalTurnRadians: number
  averageTurnDegrees: number
}

interface BenchmarkResult {
  label: string
  durationMs: number
  telemetryEvents: number
  referenceSamples: number
  motionSegments: number
  segmentReductionPercent: number
  referencePathLengthPx: number
  referenceTotalTurnDegrees: number
  referenceAverageTurnDegrees: number
  referenceBuildMs: number
  motionPlanBuildMs: number
  motionPlanEvaluationMs: number
  evaluatedSamples: number
  maxCenterErrorPx: number
  rmsCenterErrorPx: number
  maxErrorTimeMs: number
  checksum: number
}

function cursorPositionAtTime(timeMs: number): { x: number; y: number } {
  // A bounded Lissajous path exercises repeated reversals and tight turns while
  // keeping the synthetic cursor inside a 1920x1080 capture.
  const phase = (timeMs / 2_400) * Math.PI * 2
  return {
    x: 960 + 800 * Math.sin(phase) + 90 * Math.sin(3 * phase + 0.35),
    y: 540 + 400 * Math.sin(2 * phase + 0.7) + 45 * Math.cos(5 * phase),
  }
}

function makeCursorTelemetry(durationMs: number): CursorTelemetryFile {
  const sampleRateHz = 60
  const intervalMs = 1000 / sampleRateHz
  const eventCount = Math.ceil(durationMs / intervalMs) + 1
  const events: CursorTelemetryFile["events"] = []

  for (let index = 0; index < eventCount; index++) {
    const tMs = Math.min(durationMs, Math.round(index * intervalMs))
    const point = cursorPositionAtTime(tMs)
    events.push({
      tMs,
      rawX: Math.round(point.x),
      rawY: Math.round(point.y),
      sourceX: point.x,
      sourceY: point.y,
      buttons: {
        left: false,
        right: false,
        middle: false,
        x1: false,
        x2: false,
      },
      buttonEvent: "none",
      visible: true,
      shapeId: "arrow",
      shapeChanged: false,
    })
  }

  return {
    schemaVersion: 2,
    assetId: "cursor-events:high-curvature-benchmark",
    recordingId: "high-curvature-benchmark",
    sourceWidth: 1920,
    sourceHeight: 1080,
    captureBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    coordinateTransform: { a00: 1, a01: 0, a10: 0, a11: 1, b0: 0, b1: 0 },
    shapes: [],
    timebase: { unit: "ms", ticksPerSecond: 1000 },
    sampleRateHz,
    clickWindowMs: 350,
    health: "healthy",
    eventCount: events.length,
    index: [],
    eventFile: "cursor_events.bin",
    events,
  }
}

function makeFollowSegment(durationMs: number): ManualZoomSegment {
  return {
    id: "high-curvature-follow",
    startMs: 0,
    durationMs,
    target: { x: 480, y: 270, width: 960, height: 540 },
    scale: 2,
    easing: "linear",
    transitionInMs: 0,
    transitionOutMs: 0,
    enabled: true,
    locked: false,
    mode: "follow-cursor",
    source: "follow",
    preset: "cinematic",
    followDeadzonePercent: 0.01,
    followSmoothingAlpha: 1,
  }
}

function makeState(durationMs: number, segment: ManualZoomSegment): TimelineState {
  return {
    version: 1,
    id: `high-curvature-${durationMs}`,
    name: `High-curvature path ${durationMs}ms`,
    recordingId: "high-curvature-benchmark",
    canvas: {
      width: 1920,
      height: 1080,
      fps: 30,
      background: "#000000",
      padding: 0,
      borderRadius: 0,
      shadow: false,
      cursorSettings: { ...defaultCursorSettings, smoothMovement: false },
    },
    tracks: [
      {
        id: "screen",
        kind: "screen",
        name: "Screen",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "screen-clip",
            kind: "screen",
            assetId: "screen",
            startMs: 0,
            durationMs,
            sourceInMs: 0,
            sourceOutMs: durationMs,
            speed: 1,
          },
        ],
      },
      {
        id: "cursor",
        kind: "cursor",
        name: "Cursor",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "cursor-effect",
            kind: "cursor-effect",
            assetId: "cursor-events:high-curvature-benchmark",
            startMs: 0,
            durationMs,
            sourceInMs: 0,
            sourceOutMs: 0,
            speed: 1,
            presetId: "recorded-system",
            scale: 1,
            smoothing: "off",
            settings: {},
            enabled: true,
            locked: false,
          },
        ],
      },
    ],
    zoomSegments: [segment],
    markers: [],
    createdAt: "2026-08-24T00:00:00Z",
    updatedAt: "2026-08-24T00:00:00Z",
  }
}

function createFixture(durationMs: number): {
  state: TimelineState
  segment: ManualZoomSegment
  engine: CursorEngine
} {
  const telemetry = makeCursorTelemetry(durationMs)
  const segment = makeFollowSegment(durationMs)
  return {
    state: makeState(durationMs, segment),
    segment,
    engine: createCursorEngine(telemetry),
  }
}

function targetCenter(target: ZoomTarget): { x: number; y: number } {
  return {
    x: target.x + target.width / 2,
    y: target.y + target.height / 2,
  }
}

function pointDistance(left: { x: number; y: number }, right: { x: number; y: number }): number {
  return Math.hypot(left.x - right.x, left.y - right.y)
}

function buildDenseReference(
  segment: ManualZoomSegment,
  state: TimelineState,
  engine: CursorEngine,
): DenseReferenceSample[] {
  const endMs = segment.startMs + Math.max(1, segment.durationMs)
  const baseTarget = segment.target
  let previousTarget = baseTarget
  let previousCenter = targetCenter(baseTarget)
  const samples: DenseReferenceSample[] = []

  for (let timeMs = segment.startMs; timeMs < endMs; timeMs += REFERENCE_STEP_MS) {
    const target =
      resolveFollowCursorTarget(segment, state, timeMs, engine, previousCenter) ?? previousTarget
    samples.push({ timeMs, target })
    previousTarget = target
    previousCenter = targetCenter(target)
  }

  const endTarget =
    resolveFollowCursorTarget(segment, state, endMs, engine, previousCenter) ?? previousTarget
  samples.push({ timeMs: endMs, target: endTarget })
  return samples
}

function measurePath(reference: DenseReferenceSample[]): PathMetrics {
  let lengthPx = 0
  let totalTurnRadians = 0

  for (let index = 1; index < reference.length; index++) {
    lengthPx += pointDistance(
      targetCenter(reference[index - 1].target),
      targetCenter(reference[index].target),
    )
  }

  for (let index = 1; index < reference.length - 1; index++) {
    const previous = targetCenter(reference[index - 1].target)
    const current = targetCenter(reference[index].target)
    const next = targetCenter(reference[index + 1].target)
    const incomingX = current.x - previous.x
    const incomingY = current.y - previous.y
    const outgoingX = next.x - current.x
    const outgoingY = next.y - current.y
    totalTurnRadians += Math.abs(
      Math.atan2(
        incomingX * outgoingY - incomingY * outgoingX,
        incomingX * outgoingX + incomingY * outgoingY,
      ),
    )
  }

  return {
    lengthPx,
    totalTurnRadians,
    averageTurnDegrees:
      reference.length > 2 ? (totalTurnRadians / (reference.length - 2)) * (180 / Math.PI) : 0,
  }
}

function formatDuration(durationMs: number): string {
  if (durationMs % (60 * 60 * 1000) === 0) return `${durationMs / (60 * 60 * 1000)}-hour`
  if (durationMs % (60 * 1000) === 0) return `${durationMs / (60 * 1000)}-minute`
  return `${durationMs / 1000}-second`
}

function benchmarkPath(durationMs: number): BenchmarkResult {
  const referenceFixture = createFixture(durationMs)
  const referenceStart = performance.now()
  const reference = buildDenseReference(
    referenceFixture.segment,
    referenceFixture.state,
    referenceFixture.engine,
  )
  const referenceBuildMs = performance.now() - referenceStart
  const pathMetrics = measurePath(reference)

  const planFixture = createFixture(durationMs)
  const planStart = performance.now()
  const motionPlan = buildFollowCursorMotionPlan(
    planFixture.segment,
    planFixture.state,
    planFixture.engine,
    { sampleStepMs: REFERENCE_STEP_MS, tolerancePx: MOTION_PLAN_TOLERANCE_PX },
  )
  const motionPlanBuildMs = performance.now() - planStart
  if (!motionPlan) throw new Error(`Motion plan failed for ${formatDuration(durationMs)} path`)

  let maxCenterErrorPx = 0
  let maxErrorTimeMs = 0
  let sumSquaredError = 0
  let checksum = 0
  const evaluationStart = performance.now()

  for (const sample of reference) {
    const target = resolveFollowCursorMotionPlanTargetAtTime(
      motionPlan,
      planFixture.segment,
      planFixture.state,
      sample.timeMs,
      planFixture.engine,
    )
    if (!target) throw new Error(`Motion plan returned no target at ${sample.timeMs}ms`)

    const errorPx = pointDistance(targetCenter(target), targetCenter(sample.target))
    if (errorPx > maxCenterErrorPx) {
      maxCenterErrorPx = errorPx
      maxErrorTimeMs = sample.timeMs
    }
    sumSquaredError += errorPx * errorPx
    checksum += target.x * 0.000001 + target.y * 0.000002
  }

  const motionPlanEvaluationMs = performance.now() - evaluationStart
  const segmentReductionPercent =
    reference.length > 1 ? (1 - motionPlan.segments.length / (reference.length - 1)) * 100 : 0

  return {
    label: formatDuration(durationMs),
    durationMs,
    telemetryEvents: referenceFixture.engine.telemetry.events.length,
    referenceSamples: reference.length,
    motionSegments: motionPlan.segments.length,
    segmentReductionPercent,
    referencePathLengthPx: pathMetrics.lengthPx,
    referenceTotalTurnDegrees: pathMetrics.totalTurnRadians * (180 / Math.PI),
    referenceAverageTurnDegrees: pathMetrics.averageTurnDegrees,
    referenceBuildMs,
    motionPlanBuildMs,
    motionPlanEvaluationMs,
    evaluatedSamples: reference.length,
    maxCenterErrorPx,
    rmsCenterErrorPx: Math.sqrt(sumSquaredError / Math.max(1, reference.length)),
    maxErrorTimeMs,
    checksum,
  }
}

function main(): void {
  const results = BENCHMARK_DURATIONS_MS.map(benchmarkPath)
  console.log(
    JSON.stringify(
      {
        benchmark: "cursor-follow-path",
        referenceStepMs: REFERENCE_STEP_MS,
        motionPlanTolerancePx: MOTION_PLAN_TOLERANCE_PX,
        path: "bounded-lissajous",
        results,
      },
      null,
      2,
    ),
  )
}

main()
