#!/usr/bin/env bun
/**
 * Regenerates the shared TS<->Rust camera fixtures consumed by
 * `exports::camera::tests` in apps/desktop/src-tauri.
 *
 * Usage: bun run packages/editor-core/scripts/generate-camera-fixtures.ts
 *
 * Also refreshes tooling/golden-fixtures/preview-rust-fractional-frame.json,
 * which both the editor-core parity test and the Rust cursor parity test
 * read as their shared expected values.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  createCursorEngine,
  fitCursorPoint,
  mapCursorPointThroughZoom,
} from "@recordforge/cursor-core"
import {
  cursorTelemetryFileSchema,
  timelineStateSchema,
  type ManualZoomSegment,
} from "@recordforge/domain"
import { resolveZoomTransform } from "../src/composition"
import { resolvePreviewComposition } from "../src/preview-composition"

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))

interface CameraFixtureCrop {
  x: number
  y: number
  width: number
  height: number
}

interface CameraFixtureFrame {
  timeMs: number
  crop: CameraFixtureCrop
  scale: number
  progress: number
}

interface CameraFixtureCase {
  name: string
  canvas: { width: number; height: number; padding: number }
  segment: {
    startMs: number
    durationMs: number
    target: CameraFixtureCrop
    scale: number
    easing: string
    transitionInMs: number
    transitionOutMs: number
    fromTarget: CameraFixtureCrop | null
    fromScale: number | null
  }
  frames: CameraFixtureFrame[]
}

const canvas = { width: 1920, height: 1080, padding: 0 }

function segmentFor(caseSegment: CameraFixtureCase["segment"]): ManualZoomSegment {
  return {
    id: `fixture-${caseSegment.easing}`,
    startMs: caseSegment.startMs,
    durationMs: caseSegment.durationMs,
    target: caseSegment.target,
    scale: caseSegment.scale,
    easing: caseSegment.easing as ManualZoomSegment["easing"],
    transitionInMs: caseSegment.transitionInMs,
    transitionOutMs: caseSegment.transitionOutMs,
    enabled: true,
    locked: false,
    mode: "manual",
    source: "manual",
  }
}

function evaluateCase(
  name: string,
  caseSegment: CameraFixtureCase["segment"],
  timesMs: number[],
): CameraFixtureCase {
  const segment = segmentFor(caseSegment)
  const frames = timesMs.map((timeMs) => {
    const transform = resolveZoomTransform(segment, timeMs, canvas, {
      fromTarget: caseSegment.fromTarget,
      fromScale: caseSegment.fromScale,
    })
    return {
      timeMs,
      crop: transform.crop,
      scale: transform.scale,
      progress: transform.progress,
    }
  })
  return { name, canvas, segment: caseSegment, frames }
}

function sampleTimes(startMs: number, endMs: number, count: number): number[] {
  // Segment ranges are half-open [start, end); the exact end instant belongs
  // to whatever follows and is not part of this camera's evaluation domain.
  const times: number[] = []
  for (let i = 0; i < count; i++) {
    times.push(startMs + ((endMs - startMs) * i) / count)
  }
  return times
}

const cases: CameraFixtureCase[] = [
  evaluateCase(
    "static-ease-out",
    {
      startMs: 0,
      durationMs: 2_000,
      target: { x: 480, y: 270, width: 960, height: 540 },
      scale: 2,
      easing: "ease-out",
      transitionInMs: 400,
      transitionOutMs: 400,
      fromTarget: null,
      fromScale: null,
    },
    sampleTimes(0, 2_000, 20),
  ),
  evaluateCase(
    "snappy-zoom",
    {
      startMs: 500,
      durationMs: 1_500,
      target: { x: 1_200, y: 540, width: 640, height: 360 },
      scale: 3,
      easing: "snappy",
      transitionInMs: 300,
      transitionOutMs: 300,
      fromTarget: null,
      fromScale: null,
    },
    sampleTimes(500, 2_000, 15),
  ),
  evaluateCase(
    "spring-overshoot",
    {
      startMs: 0,
      durationMs: 1_600,
      target: { x: 0, y: 0, width: 640, height: 360 },
      scale: 3,
      easing: "spring",
      transitionInMs: 500,
      transitionOutMs: 400,
      fromTarget: null,
      fromScale: null,
    },
    sampleTimes(0, 1_600, 16),
  ),
  evaluateCase(
    "bridged-pan",
    {
      startMs: 1_000,
      durationMs: 1_200,
      target: { x: 960, y: 540, width: 640, height: 360 },
      scale: 3,
      easing: "cinematic",
      transitionInMs: 300,
      transitionOutMs: 300,
      fromTarget: { x: 0, y: 0, width: 640, height: 360 },
      fromScale: 3,
    },
    sampleTimes(1_000, 2_200, 12),
  ),
  evaluateCase(
    "equal-scale-pan",
    {
      startMs: 0,
      durationMs: 1_000,
      target: { x: 960, y: 540, width: 960, height: 540 },
      scale: 2,
      easing: "linear",
      transitionInMs: 500,
      transitionOutMs: 0,
      fromTarget: { x: 0, y: 0, width: 960, height: 540 },
      fromScale: 2,
    },
    sampleTimes(0, 1_000, 10),
  ),
]

writeFileSync(
  `${repoRoot}/tooling/fixtures/camera-fixtures/camera-crops.json`,
  JSON.stringify({ version: 1, canvas, cases }, null, 2) + "\n",
)
console.log(`wrote tooling/fixtures/camera-fixtures/camera-crops.json (${cases.length} cases)`)

// ---------------------------------------------------------------------------
// Fractional preview/Rust golden frames: recompute the expected geometry with
// the current implementation so the TS and Rust parity tests stay in lockstep.
// ---------------------------------------------------------------------------

interface FractionalFixture {
  timeline: Record<string, unknown>
  canvas: Record<string, unknown>
  telemetry: unknown
  screenRect: { x: number; y: number; width: number; height: number }
  frames: Array<{
    timeMs: number
    expected: {
      sourceTimeMs: number
      sourcePoint: { x: number; y: number }
      zoom: {
        progress: number
        scale: number
        crop: { x: number; y: number; width: number; height: number }
      }
      cursorPoint: { x: number; y: number }
    }
  }>
  [key: string]: unknown
}

const fractionalPath = `${repoRoot}/tooling/golden-fixtures/preview-rust-fractional-frame.json`
const fixture = JSON.parse(readFileSync(fractionalPath, "utf-8")) as FractionalFixture
const state = timelineStateSchema.parse({ ...fixture.timeline, canvas: fixture.canvas })
const telemetry = cursorTelemetryFileSchema.parse(fixture.telemetry)
const cursorEngine = createCursorEngine(telemetry)

for (const frame of fixture.frames) {
  const composition = resolvePreviewComposition(state, frame.timeMs, { cursorEngine })
  const cursorFrame = composition.cursor.frame
  const zoom = composition.screen.zoomTransform
  const sourceTimeMs = composition.cursor.sourceTimeMs
  if (!cursorFrame || !zoom || sourceTimeMs === null) {
    throw new Error(`missing preview frame at ${frame.timeMs}ms`)
  }
  const fitted = fitCursorPoint(
    { x: cursorFrame.sourceX, y: cursorFrame.sourceY },
    telemetry,
    fixture.screenRect.width,
    fixture.screenRect.height,
  )
  const zoomed = mapCursorPointThroughZoom(
    { x: fitted.x, y: fitted.y },
    { width: fixture.screenRect.width, height: fixture.screenRect.height },
    { width: state.canvas.width, height: state.canvas.height },
    zoom,
  )
  frame.expected = {
    sourceTimeMs,
    sourcePoint: { x: cursorFrame.sourceX, y: cursorFrame.sourceY },
    zoom: {
      progress: zoom.progress,
      scale: zoom.scale,
      crop: zoom.crop,
    },
    cursorPoint: {
      x: fixture.screenRect.x + zoomed.x,
      y: fixture.screenRect.y + zoomed.y,
    },
  }
}

writeFileSync(fractionalPath, JSON.stringify(fixture, null, 2) + "\n")
console.log(
  `regenerated tooling/golden-fixtures/preview-rust-fractional-frame.json (${fixture.frames.length} frames)`,
)
