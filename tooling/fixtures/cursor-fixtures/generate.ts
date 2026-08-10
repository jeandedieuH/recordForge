#!/usr/bin/env bun

/**
 * Cursor fixture generator for recordForge Phase 0.
 *
 * Usage:
 *   bun run tooling/fixtures/cursor-fixtures/generate.ts
 *
 * This script creates deterministic V1 and V2 cursor telemetry fixtures
 * covering DPI, mixed-DPI, negative virtual-desktop coordinates, region/window
 * capture, clicks, idle, shape changes, pause/resume, and recovery.
 */

import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"

const OUTPUT_DIR = join(import.meta.dir, ".")

interface BaseV1Fixture {
  name: string
  schemaVersion: number
  assetId: string
  recordingId: string
  sourceWidth: number
  sourceHeight: number
  captureBounds: { x: number; y: number; width: number; height: number }
  dpiScale: { x: number; y: number }
  timebase: { unit: "ms"; ticksPerSecond: number }
  sampleRateHz: number
  events: Array<{
    tMs: number
    x: number
    y: number
    clicked: boolean
    button: "left" | "right" | "middle" | "none"
    buttonEvent: "none" | "down" | "held" | "up"
    visible: boolean
  }>
}

interface V2Fixture extends BaseV1Fixture {
  captureKind: "display" | "window" | "region"
  virtualDesktopPhysicalBounds: { x: number; y: number; width: number; height: number }
  sourcePhysicalBounds: { x: number; y: number; width: number; height: number }
  encodedFrameDimensions: { width: number; height: number }
  affineTransform: { a: number; b: number; c: number; d: number; e: number; f: number }
  monitorTopology: Array<{
    id: string
    x: number
    y: number
    width: number
    height: number
    dpiScale: number
  }>
  sessionClockRef: { epochMs: number; ticksPerSecond: number }
  clockOffsetMs: number
  diagnostics: { gapCount: number; clockOffsetMs: number; droppedSamples: number }
  segmentBoundaries: Array<{ startMs: number; endMs: number; kind: "recording" | "pause" }>
  checkpoints: Array<{ tMs: number; hash: string }>
  events: Array<{
    tMs: number
    x: number
    y: number
    clicked: boolean
    button: "left" | "right" | "middle" | "none"
    buttonEvent: "none" | "down" | "held" | "up"
    visible: boolean
    shapeId?: string
    hotspotX?: number
    hotspotY?: number
    buttonEdges?: {
      left: { downMs: number | null; upMs: number | null } | null
      right: { downMs: number | null; upMs: number | null } | null
      middle: { downMs: number | null; upMs: number | null } | null
    }
    wheelDelta?: { deltaX: number; deltaY: number } | null
  }>
}

mkdirSync(OUTPUT_DIR, { recursive: true })

function linearEvents(durationMs: number, samples: number, width: number, height: number) {
  const events: BaseV1Fixture["events"] = []
  for (let i = 0; i < samples; i++) {
    const tMs = Math.round((durationMs / (samples - 1)) * i)
    const x = Math.round((width / (samples - 1)) * i)
    const y = Math.round((height / (samples - 1)) * i)
    events.push({
      tMs,
      x,
      y,
      clicked: false,
      button: "none",
      buttonEvent: "none",
      visible: true,
    })
  }
  return events
}

function writeFixture(name: string, data: unknown) {
  const path = join(OUTPUT_DIR, name)
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8")
  console.log("Wrote", path)
}

function baseV1Fixture(
  name: string,
  recordingId: string,
  width: number,
  height: number,
  events: BaseV1Fixture["events"],
  dpiScale = { x: 1, y: 1 },
  captureBounds?: { x: number; y: number; width: number; height: number },
): BaseV1Fixture {
  return {
    name,
    schemaVersion: 1,
    assetId: `cursor-events:${recordingId}`,
    recordingId,
    sourceWidth: width,
    sourceHeight: height,
    captureBounds: captureBounds ?? { x: 0, y: 0, width, height },
    dpiScale,
    timebase: { unit: "ms", ticksPerSecond: 1000 },
    sampleRateHz: 60,
    events,
  }
}

function withClicks(
  events: BaseV1Fixture["events"],
  clickTimes: number[],
  button: "left" | "right" = "left",
) {
  for (const tMs of clickTimes) {
    const index = events.findIndex((e) => e.tMs >= tMs)
    if (index >= 0) {
      events[index].clicked = true
      events[index].button = button
      events[index].buttonEvent = "down"
    }
  }
  return events
}

function withIdle(events: BaseV1Fixture["events"], startMs: number, endMs: number) {
  for (const e of events) {
    if (e.tMs >= startMs && e.tMs <= endMs) {
      e.x = events[events.findIndex((x) => x.tMs >= startMs)]?.x ?? e.x
      e.y = events[events.findIndex((x) => x.tMs >= startMs)]?.y ?? e.y
    }
  }
  return events
}

function withPauseResume(events: BaseV1Fixture["events"], pauseAtMs: number, resumeAtMs: number) {
  // Events after the pause have an artificial time jump, simulating a recording pause.
  const pausedFor = resumeAtMs - pauseAtMs
  for (const e of events) {
    if (e.tMs >= pauseAtMs) {
      e.tMs += pausedFor
    }
  }
  return events
}

// V1 fixtures
writeFixture(
  "cursor-v1-100dpi-10s.json",
  baseV1Fixture(
    "V1 100% DPI 10s",
    "fixture-100dpi-10s",
    1920,
    1080,
    linearEvents(10000, 601, 1920, 1080),
  ),
)

writeFixture(
  "cursor-v1-125dpi-10s.json",
  baseV1Fixture(
    "V1 125% DPI 10s",
    "fixture-125dpi-10s",
    1920,
    1080,
    linearEvents(10000, 601, 1536, 864),
    { x: 1.25, y: 1.25 },
  ),
)

writeFixture(
  "cursor-v1-150dpi-10s.json",
  baseV1Fixture(
    "V1 150% DPI 10s",
    "fixture-150dpi-10s",
    1920,
    1080,
    linearEvents(10000, 601, 1280, 720),
    { x: 1.5, y: 1.5 },
  ),
)

writeFixture(
  "cursor-v1-mixed-dpi-10s.json",
  baseV1Fixture(
    "V1 mixed-DPI 10s",
    "fixture-mixed-dpi-10s",
    1920,
    1080,
    linearEvents(10000, 601, 1536, 720),
    { x: 1.25, y: 1.5 },
  ),
)

writeFixture(
  "cursor-v1-negative-coords-10s.json",
  baseV1Fixture(
    "V1 negative virtual-desktop 10s",
    "fixture-negative-coords-10s",
    1920,
    1080,
    linearEvents(10000, 601, 1280, 720),
    { x: 1, y: 1 },
    { x: -640, y: -360, width: 1920, height: 1080 },
  ),
)

writeFixture(
  "cursor-v1-region-capture-10s.json",
  baseV1Fixture(
    "V1 region capture 10s",
    "fixture-region-capture-10s",
    1024,
    768,
    linearEvents(10000, 601, 800, 600),
    { x: 1, y: 1 },
    { x: 200, y: 150, width: 800, height: 600 },
  ),
)

writeFixture(
  "cursor-v1-window-capture-10s.json",
  baseV1Fixture(
    "V1 window capture 10s",
    "fixture-window-capture-10s",
    1280,
    720,
    linearEvents(10000, 601, 1000, 600),
    { x: 1, y: 1 },
    { x: 0, y: 0, width: 1000, height: 600 },
  ),
)

writeFixture(
  "cursor-v1-left-clicks-10s.json",
  baseV1Fixture(
    "V1 left clicks 10s",
    "fixture-left-clicks-10s",
    1920,
    1080,
    withClicks(linearEvents(10000, 601, 1920, 1080), [1200, 4500, 7800], "left"),
  ),
)

writeFixture(
  "cursor-v1-right-clicks-10s.json",
  baseV1Fixture(
    "V1 right clicks 10s",
    "fixture-right-clicks-10s",
    1920,
    1080,
    withClicks(linearEvents(10000, 601, 1920, 1080), [1500, 5200, 8200], "right"),
  ),
)

writeFixture(
  "cursor-v1-idle-intervals-10s.json",
  baseV1Fixture(
    "V1 idle intervals 10s",
    "fixture-idle-intervals-10s",
    1920,
    1080,
    withIdle(linearEvents(10000, 601, 1920, 1080), 3000, 6000),
  ),
)

writeFixture(
  "cursor-v1-shape-change-10s.json",
  baseV1Fixture(
    "V1 shape change (default) 10s",
    "fixture-shape-change-10s",
    1920,
    1080,
    linearEvents(10000, 601, 1920, 1080),
  ),
)

writeFixture(
  "cursor-v1-pause-resume-10s.json",
  baseV1Fixture(
    "V1 pause/resume 10s",
    "fixture-pause-resume-10s",
    1920,
    1080,
    withPauseResume(linearEvents(6000, 361, 1920, 1080), 4000, 4000),
  ),
)

writeFixture(
  "cursor-v1-recovery-gap-10s.json",
  baseV1Fixture(
    "V1 recovery gap 10s",
    "fixture-recovery-gap-10s",
    1920,
    1080,
    linearEvents(10000, 241, 1920, 1080),
  ),
)

function v2Base(
  name: string,
  recordingId: string,
  captureKind: V2Fixture["captureKind"],
  width: number,
  height: number,
  events: V2Fixture["events"],
  opts: {
    virtualDesktop?: V2Fixture["virtualDesktopPhysicalBounds"]
    sourcePhysical?: V2Fixture["sourcePhysicalBounds"]
    encoded?: V2Fixture["encodedFrameDimensions"]
    dpi?: V2Fixture["dpiScale"]
    monitors?: V2Fixture["monitorTopology"]
    segmentBoundaries?: V2Fixture["segmentBoundaries"]
    checkpoints?: V2Fixture["checkpoints"]
    diagnostics?: V2Fixture["diagnostics"]
  } = {},
): V2Fixture {
  return {
    name,
    schemaVersion: 2,
    assetId: `cursor-events:${recordingId}`,
    recordingId,
    sourceWidth: width,
    sourceHeight: height,
    captureBounds: { x: 0, y: 0, width, height },
    dpiScale: opts.dpi ?? { x: 1, y: 1 },
    timebase: { unit: "ms", ticksPerSecond: 1000 },
    sampleRateHz: 60,
    captureKind,
    virtualDesktopPhysicalBounds: opts.virtualDesktop ?? { x: 0, y: 0, width, height },
    sourcePhysicalBounds: opts.sourcePhysical ?? { x: 0, y: 0, width, height },
    encodedFrameDimensions: opts.encoded ?? { width, height },
    affineTransform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    monitorTopology: opts.monitors ?? [
      { id: "monitor-0", x: 0, y: 0, width, height, dpiScale: 1 },
    ],
    sessionClockRef: { epochMs: 1700000000000, ticksPerSecond: 1000 },
    clockOffsetMs: 0,
    diagnostics: opts.diagnostics ?? { gapCount: 0, clockOffsetMs: 0, droppedSamples: 0 },
    segmentBoundaries: opts.segmentBoundaries ?? [{ startMs: 0, endMs: 10000, kind: "recording" }],
    checkpoints: opts.checkpoints ?? [{ tMs: 0, hash: "00000000" }],
    events,
  }
}

function v2LinearEvents(
  durationMs: number,
  samples: number,
  width: number,
  height: number,
  shape: string,
): V2Fixture["events"] {
  const events: V2Fixture["events"] = []
  for (let i = 0; i < samples; i++) {
    const tMs = Math.round((durationMs / (samples - 1)) * i)
    const x = Math.round((width / (samples - 1)) * i)
    const y = Math.round((height / (samples - 1)) * i)
    events.push({
      tMs,
      x,
      y,
      clicked: false,
      button: "none",
      buttonEvent: "none",
      visible: true,
      shapeId: shape,
      hotspotX: 0,
      hotspotY: 0,
      buttonEdges: { left: null, right: null, middle: null },
      wheelDelta: null,
    })
  }
  return events
}

function v2Click(events: V2Fixture["events"], tMs: number, button: "left" | "right" = "left") {
  const index = events.findIndex((e) => e.tMs >= tMs)
  if (index >= 0) {
    const e = events[index]
    e.clicked = true
    e.button = button
    e.buttonEvent = "down"
    e.buttonEdges = e.buttonEdges ?? { left: null, right: null, middle: null }
    e.buttonEdges[button] = { downMs: tMs, upMs: tMs + 120 }
    e.shapeId = "hand-pointer"
  }
  return events
}

// V2 fixtures
writeFixture(
  "cursor-v2-physical-pixel-10s.json",
  v2Base(
    "V2 physical-pixel 10s",
    "fixture-v2-physical-pixel-10s",
    "display",
    1920,
    1080,
    v2LinearEvents(10000, 601, 1920, 1080, "default"),
    {
      sourcePhysical: { x: 0, y: 0, width: 3840, height: 2160 },
      encoded: { width: 1920, height: 1080 },
    },
  ),
)

writeFixture(
  "cursor-v2-topology-single-10s.json",
  v2Base(
    "V2 single-monitor topology 10s",
    "fixture-v2-topology-single-10s",
    "display",
    1920,
    1080,
    v2LinearEvents(10000, 601, 1920, 1080, "default"),
    {
      monitors: [{ id: "monitor-0", x: 0, y: 0, width: 1920, height: 1080, dpiScale: 1 }],
    },
  ),
)

writeFixture(
  "cursor-v2-topology-multi-10s.json",
  v2Base(
    "V2 multi-monitor topology 10s",
    "fixture-v2-topology-multi-10s",
    "display",
    1920,
    1080,
    v2LinearEvents(10000, 601, 1920, 1080, "default"),
    {
      virtualDesktop: { x: -1920, y: 0, width: 3840, height: 1080 },
      sourcePhysical: { x: 1920, y: 0, width: 1920, height: 1080 },
      monitors: [
        { id: "monitor-0", x: -1920, y: 0, width: 1920, height: 1080, dpiScale: 1.25 },
        { id: "monitor-1", x: 0, y: 0, width: 1920, height: 1080, dpiScale: 1 },
      ],
    },
  ),
)

writeFixture(
  "cursor-v2-shape-hotspot-10s.json",
  v2Base(
    "V2 shape and hotspot 10s",
    "fixture-v2-shape-hotspot-10s",
    "display",
    1920,
    1080,
    v2LinearEvents(10000, 601, 1920, 1080, "default"),
  ),
)

writeFixture(
  "cursor-v2-button-edges-10s.json",
  v2Base(
    "V2 independent button edges 10s",
    "fixture-v2-button-edges-10s",
    "display",
    1920,
    1080,
    v2Click(
      v2Click(v2LinearEvents(10000, 601, 1920, 1080, "default"), 1200, "left"),
      4500,
      "right",
    ),
  ),
)

writeFixture(
  "cursor-v2-session-clock-10s.json",
  v2Base(
    "V2 session clock 10s",
    "fixture-v2-session-clock-10s",
    "display",
    1920,
    1080,
    v2LinearEvents(10000, 601, 1920, 1080, "default"),
    {
      sessionClockRef: { epochMs: 1700000000000, ticksPerSecond: 1000 },
      clockOffsetMs: 50,
    },
  ),
)

writeFixture(
  "cursor-v2-segment-boundaries-10s.json",
  v2Base(
    "V2 segment boundaries 10s",
    "fixture-v2-segment-boundaries-10s",
    "display",
    1920,
    1080,
    v2LinearEvents(10000, 601, 1920, 1080, "default"),
    {
      segmentBoundaries: [
        { startMs: 0, endMs: 4000, kind: "recording" },
        { startMs: 4000, endMs: 6000, kind: "pause" },
        { startMs: 6000, endMs: 10000, kind: "recording" },
      ],
      checkpoints: [
        { tMs: 0, hash: "00000000" },
        { tMs: 6000, hash: "11111111" },
      ],
    },
  ),
)

writeFixture(
  "cursor-v2-checkpoint-recovery-10s.json",
  v2Base(
    "V2 checkpoint/recovery 10s",
    "fixture-v2-checkpoint-recovery-10s",
    "display",
    1920,
    1080,
    v2LinearEvents(10000, 601, 1920, 1080, "default"),
    {
      diagnostics: { gapCount: 2, clockOffsetMs: 10, droppedSamples: 5 },
      checkpoints: [
        { tMs: 0, hash: "00000000" },
        { tMs: 5000, hash: "abc123" },
        { tMs: 10000, hash: "def456" },
      ],
    },
  ),
)

writeFixture(
  "cursor-v2-compact-indexed-10s.json",
  v2Base(
    "V2 compact indexed 10s",
    "fixture-v2-compact-indexed-10s",
    "display",
    1920,
    1080,
    v2LinearEvents(10000, 601, 1920, 1080, "default"),
  ),
)

writeFixture(
  "cursor-v2-diagnostics-10s.json",
  v2Base(
    "V2 diagnostics 10s",
    "fixture-v2-diagnostics-10s",
    "display",
    1920,
    1080,
    v2LinearEvents(10000, 481, 1920, 1080, "default"),
    {
      diagnostics: { gapCount: 3, clockOffsetMs: 25, droppedSamples: 12 },
    },
  ),
)

writeFixture(
  "cursor-v2-wheel-deltas-10s.json",
  v2Base(
    "V2 wheel deltas 10s",
    "fixture-v2-wheel-deltas-10s",
    "display",
    1920,
    1080,
    v2LinearEvents(10000, 601, 1920, 1080, "default").map((e, i) => ({
      ...e,
      wheelDelta: i % 50 === 0 ? { deltaX: 0, deltaY: -3 } : null,
    })),
  ),
)

writeFixture(
  "cursor-v2-capture-kind-display-10s.json",
  v2Base(
    "V2 display capture kind 10s",
    "fixture-v2-capture-kind-display-10s",
    "display",
    1920,
    1080,
    v2LinearEvents(10000, 601, 1920, 1080, "default"),
  ),
)

writeFixture(
  "cursor-v2-capture-kind-window-10s.json",
  v2Base(
    "V2 window capture kind 10s",
    "fixture-v2-capture-kind-window-10s",
    "window",
    1280,
    720,
    v2LinearEvents(10000, 601, 1000, 600, "default"),
    {
      sourcePhysical: { x: 100, y: 100, width: 1000, height: 600 },
    },
  ),
)

writeFixture(
  "cursor-v2-capture-kind-region-10s.json",
  v2Base(
    "V2 region capture kind 10s",
    "fixture-v2-capture-kind-region-10s",
    "region",
    1024,
    768,
    v2LinearEvents(10000, 601, 800, 600, "default"),
    {
      sourcePhysical: { x: 200, y: 150, width: 800, height: 600 },
    },
  ),
)

// Comprehensive 30s V2 fixture with all fields.
const comprehensiveEvents: V2Fixture["events"] = []
for (let i = 0; i < 1801; i++) {
  const tMs = Math.round((30000 / 1800) * i)
  const x = Math.round(1920 * (i % 100) / 100)
  const y = Math.round(1080 * (i % 100) / 100)
  const isClick = i === 200 || i === 1200
  const isRightClick = i === 1500
  comprehensiveEvents.push({
    tMs,
    x,
    y,
    clicked: isClick || isRightClick,
    button: isRightClick ? "right" : isClick ? "left" : "none",
    buttonEvent: isClick || isRightClick ? "down" : "none",
    visible: i < 1700,
    shapeId: i % 400 === 0 ? "text" : "default",
    hotspotX: 0,
    hotspotY: 0,
    buttonEdges: {
      left: isClick ? { downMs: tMs, upMs: tMs + 120 } : null,
      right: isRightClick ? { downMs: tMs, upMs: tMs + 120 } : null,
      middle: null,
    },
    wheelDelta: i % 300 === 0 ? { deltaX: 0, deltaY: -3 } : null,
  })
}

writeFixture(
  "cursor-comprehensive-30s.json",
  v2Base(
    "Comprehensive 30s V1/V2",
    "fixture-comprehensive-30s",
    "display",
    1920,
    1080,
    comprehensiveEvents,
    {
      virtualDesktop: { x: -1920, y: 0, width: 3840, height: 1080 },
      sourcePhysical: { x: 0, y: 0, width: 1920, height: 1080 },
      encoded: { width: 1920, height: 1080 },
      dpi: { x: 1, y: 1 },
      monitors: [
        { id: "monitor-0", x: -1920, y: 0, width: 1920, height: 1080, dpiScale: 1.25 },
        { id: "monitor-1", x: 0, y: 0, width: 1920, height: 1080, dpiScale: 1 },
      ],
      segmentBoundaries: [
        { startMs: 0, endMs: 10000, kind: "recording" },
        { startMs: 10000, endMs: 15000, kind: "pause" },
        { startMs: 15000, endMs: 30000, kind: "recording" },
      ],
      checkpoints: [
        { tMs: 0, hash: "00000000" },
        { tMs: 10000, hash: "aaaa1111" },
        { tMs: 20000, hash: "bbbb2222" },
      ],
      diagnostics: { gapCount: 0, clockOffsetMs: 0, droppedSamples: 0 },
    },
  ),
)

console.log("Cursor fixture generation complete.")
