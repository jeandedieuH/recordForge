import { resolvePreviewComposition } from "@recordforge/editor-core"
import { buildRenderPlan } from "@recordforge/media-core"
import {
  defaultCursorSettings,
  type TimelineState,
  type CursorTelemetryFile,
  type ScreenClip,
  type CaptionClip,
  type ManualZoomSegment,
} from "@recordforge/domain"
import { createCursorEngine, type CursorEngine } from "@recordforge/cursor-core"

interface BenchmarkResult {
  label: string
  durationMs: number
  stateCreationMs: number
  previewResolveMs: number
  renderPlanMs: number
  previewFrames: number
}

function makeCursorTelemetry(durationMs: number): CursorTelemetryFile {
  const sampleRateHz = 60
  const intervalMs = 1000 / sampleRateHz
  const count = Math.floor(durationMs / intervalMs)
  const events: CursorTelemetryFile["events"] = []

  for (let index = 0; index < count; index++) {
    const tMs = Math.round(index * intervalMs)
    const progress = durationMs > 0 ? tMs / durationMs : 0
    const x = Math.round(progress * 1920)
    const y = Math.round(540 + Math.sin(tMs / 1000) * 200)
    events.push({
      tMs,
      rawX: x,
      rawY: y,
      sourceX: x,
      sourceY: y,
      buttons: {
        left: index % 100 === 0,
        right: false,
        middle: false,
        x1: false,
        x2: false,
      },
      buttonEvent: index % 100 === 0 ? "left-down" : "none",
      visible: true,
      shapeId: "arrow",
      shapeChanged: false,
    })
  }

  return {
    schemaVersion: 2,
    assetId: "cursor-events:benchmark",
    recordingId: "benchmark-recording",
    sourceWidth: 1920,
    sourceHeight: 1080,
    captureBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    coordinateTransform: { a00: 1, a01: 0, a10: 0, a11: 1, b0: 0, b1: 0 },
    shapes: [],
    timebase: { unit: "ms" as const, ticksPerSecond: 1000 },
    sampleRateHz,
    clickWindowMs: 350,
    health: "healthy" as const,
    eventCount: events.length,
    index: [],
    eventFile: "cursor_events.bin",
    events,
  }
}

function buildSyntheticState(durationMs: number): {
  state: TimelineState
  cursorEngine: CursorEngine
} {
  const screenClips: ScreenClip[] = []
  for (let index = 0; index < durationMs / 1000; index++) {
    const startMs = index * 1000
    screenClips.push({
      id: `screen-clip-${index}`,
      kind: "screen" as const,
      assetId: "asset-screen",
      startMs,
      durationMs: 1000,
      sourceInMs: startMs,
      sourceOutMs: startMs + 1000,
      speed: 1,
    })
  }

  const captionClips: CaptionClip[] = []
  for (let index = 0; index < durationMs; index += 30_000) {
    captionClips.push({
      id: `caption-${index}`,
      kind: "caption" as const,
      assetId: "asset-captions",
      startMs: index,
      durationMs: 1000,
      sourceInMs: index,
      sourceOutMs: index + 1000,
      speed: 1,
      text: `Caption at ${index}ms`,
      style: "default" as const,
      placement: "bottom" as const,
    })
  }

  const zoomSegments: ManualZoomSegment[] = []
  for (let index = 0; index < durationMs; index += 300_000) {
    zoomSegments.push({
      id: `zoom-${index}`,
      startMs: index,
      durationMs: 1000,
      target: { x: 960, y: 540, width: 960, height: 540 },
      scale: 1.5,
      easing: "smooth",
      enabled: true,
      locked: false,
    })
  }

  const cursorTelemetry = makeCursorTelemetry(durationMs)
  const cursorEngine = createCursorEngine(cursorTelemetry)

  const state: TimelineState = {
    version: 1,
    id: `benchmark-${durationMs}`,
    name: `Benchmark ${durationMs}ms`,
    recordingId: "benchmark-recording",
    canvas: {
      width: 1920,
      height: 1080,
      fps: 30,
      background: "#000000",
      padding: 0,
      borderRadius: 0,
      shadow: false,
      cursorSettings: defaultCursorSettings,
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
        clips: screenClips,
      },
      {
        id: "captions",
        kind: "captions",
        name: "Captions",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: captionClips,
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
            assetId: "cursor-events:benchmark",
            startMs: 0,
            durationMs,
            sourceInMs: 0,
            sourceOutMs: 0,
            speed: 1,
            presetId: "recorded-system",
            scale: 1,
            smoothing: "smooth",
            settings: {},
            enabled: true,
            locked: false,
          },
        ],
      },
    ],
    zoomSegments,
    markers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  return { state, cursorEngine }
}

function formatLabel(durationMs: number): string {
  if (durationMs === 5 * 60 * 1000) return "5-minute"
  if (durationMs === 30 * 60 * 1000) return "30-minute"
  if (durationMs === 60 * 60 * 1000) return "60-minute"
  return `${durationMs}ms`
}

async function main(): Promise<void> {
  const durations = [5 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000]
  const results: BenchmarkResult[] = []

  for (const durationMs of durations) {
    const stateStart = performance.now()
    const { state, cursorEngine } = buildSyntheticState(durationMs)
    const stateCreationMs = performance.now() - stateStart

    const step = Math.floor(durationMs / 30)
    const samples = Array.from({ length: 30 }, (_, index) => Math.min(index * step, durationMs - 1))

    const previewStart = performance.now()
    for (const t of samples) {
      resolvePreviewComposition(state, t, { cursorEngine })
    }
    const previewResolveMs = performance.now() - previewStart

    const planStart = performance.now()
    const plan = buildRenderPlan({ state, projectId: state.id })
    const renderPlanMs = performance.now() - planStart

    if (!plan.ok) {
      throw new Error(`Render plan failed for ${durationMs}ms: ${plan.error.message}`)
    }

    results.push({
      label: formatLabel(durationMs),
      durationMs,
      stateCreationMs,
      previewResolveMs,
      renderPlanMs,
      previewFrames: 30,
    })
  }

  console.log(JSON.stringify({ benchmarks: results }, null, 2))
  process.exit(0)
}

main()
