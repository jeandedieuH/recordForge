import { describe, expect, it } from "vitest"
import {
  defaultCursorSettings,
  type TimelineCanvas,
  type TimelineClip,
  type TimelineState,
} from "@recordforge/contracts"
import {
  analyzeCursorTelemetry,
  generateSmartZoomSuggestions,
  getCursorPointAtTimelineTime,
  normalizeCursorTelemetry,
} from "./index"

const canvas: TimelineCanvas = {
  width: 1920,
  height: 1080,
  fps: 30,
  background: "#000000",
  padding: 48,
  borderRadius: 0,
  shadow: false,
  cursorSettings: defaultCursorSettings,
}

const buttons = (left: boolean, right = false, middle = false) => ({
  left,
  right,
  middle,
  x1: false,
  x2: false,
})

const v2Event = (
  tMs: number,
  x: number,
  y: number,
  buttonEvent: string,
  isLeft = false,
  isRight = false,
  isMiddle = false,
) => ({
  tMs,
  rawX: x,
  rawY: y,
  sourceX: x,
  sourceY: y,
  buttons: buttons(isLeft, isRight, isMiddle),
  buttonEvent,
  visible: true,
  shapeId: "arrow",
  shapeChanged: false,
})

function makeTimelineState(
  clips: Array<
    Pick<TimelineClip, "startMs" | "durationMs" | "sourceInMs" | "sourceOutMs" | "speed">
  >,
  canvasOverride: Partial<TimelineCanvas> = {},
): TimelineState {
  return {
    version: 1,
    id: "smart-zoom-test",
    name: "Smart zoom test",
    recordingId: "recording",
    canvas: { ...canvas, ...canvasOverride },
    tracks: [
      {
        id: "screen",
        kind: "screen",
        name: "Screen",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: clips.map((clip, index) => ({
          ...clip,
          id: `clip-${index}`,
          kind: "screen" as const,
          assetId: "recording",
        })),
      },
    ],
    markers: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  } as TimelineState
}

const fullRangeState = makeTimelineState([
  { startMs: 0, durationMs: 20_000, sourceInMs: 0, sourceOutMs: 20_000, speed: 1 },
])

const telemetry = normalizeCursorTelemetry({
  recordingId: "recording",
  sourceWidth: 1920,
  sourceHeight: 1080,
  events: [
    v2Event(0, 200, 180, "none"),
    v2Event(100, 960, 540, "left-down", true),
    v2Event(500, 960, 540, "none"),
    v2Event(1_200, 960, 540, "none"),
    v2Event(1_500, 1_700, 900, "none"),
    v2Event(2_000, 1_900, 1_060, "right-down", false, true),
    v2Event(15_000, 20, 30, "none"),
    v2Event(16_000, 20, 30, "none"),
    v2Event(17_500, 20, 30, "none"),
  ],
})

describe("smart zoom telemetry analysis", () => {
  it("extracts click, dwell, movement, and safe-edge features", () => {
    const features = analyzeCursorTelemetry(telemetry, { minDwellMs: 500 })

    expect(features.clicks).toHaveLength(2)
    expect(features.dwells.length).toBeGreaterThanOrEqual(2)
    expect(features.safeEdges[features.safeEdges.length - 1]).toEqual(
      expect.objectContaining({ nearLeft: true, nearTop: true }),
    )
  })

  it("skips movement and safe-edge extraction when the include flags are off", () => {
    const features = analyzeCursorTelemetry(telemetry, {
      minDwellMs: 500,
      includeMovements: false,
      includeSafeEdges: false,
    })

    expect(features.clicks).toHaveLength(2)
    expect(features.dwells.length).toBeGreaterThanOrEqual(2)
    expect(features.movements).toEqual([])
    expect(features.safeEdges).toEqual([])
  })

  it("generates aspect-ratio-aware, canvas-safe editable suggestions", () => {
    const suggestions = generateSmartZoomSuggestions(telemetry, fullRangeState, {
      preset: "product-demo",
      minDwellMs: 500,
      includeDwells: true,
    })

    expect(suggestions.length).toBeGreaterThan(0)
    expect(suggestions.some((segment) => segment.source === "click")).toBe(true)
    expect(suggestions.some((segment) => segment.source === "dwell")).toBe(true)
    for (const segment of suggestions) {
      expect(segment.mode).toBeDefined()
      expect(segment.locked).toBe(false)
      expect(segment.target.x).toBeGreaterThanOrEqual(0)
      expect(segment.target.y).toBeGreaterThanOrEqual(0)
      expect(segment.target.x + segment.target.width).toBeLessThanOrEqual(canvas.width + 0.001)
      expect(segment.target.y + segment.target.height).toBeLessThanOrEqual(canvas.height + 0.001)
      expect(segment.target.width / segment.target.height).toBeCloseTo(
        canvas.width / canvas.height,
        5,
      )
    }
  })

  it("uses the selected preset transition profile unless an explicit transition is provided", () => {
    const singleClickTelemetry = normalizeCursorTelemetry({
      recordingId: "preset-transitions",
      sourceWidth: 1920,
      sourceHeight: 1080,
      events: [v2Event(3_000, 800, 600, "left-down", true)],
    })

    const cinematic = generateSmartZoomSuggestions(singleClickTelemetry, fullRangeState, {
      preset: "cinematic",
    })
    // Segment is 2620ms, so the preset transition is capped at a quarter of it.
    expect(cinematic[0]?.transitionInMs).toBe(655)
    expect(cinematic[0]?.transitionOutMs).toBe(655)
    expect(cinematic[0]?.followSpeed).toBe("relaxed")

    const custom = generateSmartZoomSuggestions(singleClickTelemetry, fullRangeState, {
      preset: "cinematic",
      defaultTransitionInMs: 200,
      defaultTransitionOutMs: 250,
    })
    expect(custom[0]?.transitionInMs).toBe(200)
    expect(custom[0]?.transitionOutMs).toBe(250)
  })

  it("merges rapid clicks close in time into a single extended zoom without overlap", () => {
    const multiClickTelemetry = normalizeCursorTelemetry({
      recordingId: "multi-click",
      sourceWidth: 1920,
      sourceHeight: 1080,
      events: [
        v2Event(1_000, 500, 400, "left-down", true),
        v2Event(1_800, 520, 410, "left-down", true),
        v2Event(2_500, 510, 405, "left-down", true),
        v2Event(8_000, 1_400, 800, "left-down", true),
      ],
    })

    const suggestions = generateSmartZoomSuggestions(multiClickTelemetry, fullRangeState, {
      preset: "product-demo",
      clusterToleranceMs: 2_000,
    })

    // Clicks at 1.0s, 1.8s, and 2.5s must be merged into ONE extended zoom segment
    expect(suggestions).toHaveLength(2)
    const cluster1 = suggestions[0]
    expect(cluster1.startMs).toBeLessThanOrEqual(1_000)
    expect(cluster1.startMs + cluster1.durationMs).toBeGreaterThan(2_500 + 800)

    // Strict invariant: no two generated zoom segments ever overlap
    for (let i = 0; i < suggestions.length - 1; i++) {
      const current = suggestions[i]
      const next = suggestions[i + 1]
      expect(current.startMs + current.durationMs).toBeLessThanOrEqual(next.startMs)
    }
  })

  it("ensures zoom transitions arrive and settle on target before the click occurs (perfect click sync)", () => {
    const clickTimeMs = 3_000
    const testTelemetry = normalizeCursorTelemetry({
      recordingId: "sync-test",
      sourceWidth: 1920,
      sourceHeight: 1080,
      events: [
        v2Event(1_000, 200, 200, "none"),
        v2Event(clickTimeMs, 800, 600, "left-down", true),
        v2Event(4_500, 800, 600, "none"),
      ],
    })

    const suggestions = generateSmartZoomSuggestions(testTelemetry, fullRangeState, {
      preset: "product-demo",
    })

    expect(suggestions).toHaveLength(1)
    const zoom = suggestions[0]

    // Invariant: Transition-in must complete BEFORE the click occurs
    const fullySettledTimeMs = zoom.startMs + (zoom.transitionInMs ?? 380)
    expect(fullySettledTimeMs).toBeLessThanOrEqual(clickTimeMs)

    // Invariant: Zoom segment remains active after the click to frame the result
    expect(zoom.startMs + zoom.durationMs).toBeGreaterThan(clickTimeMs + 1_000)
  })

  it("returns no suggestions when the manual-only preset is selected", () => {
    expect(
      generateSmartZoomSuggestions(telemetry, fullRangeState, { preset: "manual-only" }),
    ).toEqual([])
  })

  it("keeps the preset scale for a tight multi-point cluster", () => {
    const tightClusterTelemetry = normalizeCursorTelemetry({
      recordingId: "tight-cluster",
      sourceWidth: 1920,
      sourceHeight: 1080,
      events: [
        v2Event(3_000, 800, 600, "left-down", true),
        v2Event(3_300, 820, 615, "left-down", true),
      ],
    })

    const suggestions = generateSmartZoomSuggestions(tightClusterTelemetry, fullRangeState, {
      preset: "product-demo",
    })

    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].scale).toBe(1.5)
  })

  it("widens the crop when cluster points spread over 60% of the canvas width", () => {
    // Two clicks 1152px apart (60% of 1920) need a wider crop than the preset's
    // 1.5x would give, so generation falls back toward the auto-fit floor.
    const spreadClusterTelemetry = normalizeCursorTelemetry({
      recordingId: "spread-cluster",
      sourceWidth: 1920,
      sourceHeight: 1080,
      events: [
        v2Event(3_000, 384, 540, "left-down", true),
        v2Event(3_300, 1_536, 540, "left-down", true),
      ],
    })

    const suggestions = generateSmartZoomSuggestions(spreadClusterTelemetry, fullRangeState, {
      preset: "product-demo",
    })

    expect(suggestions).toHaveLength(1)
    const segment = suggestions[0]
    expect(segment.scale).toBeLessThan(1.5)
    for (const x of [384, 1_536]) {
      expect(x).toBeGreaterThanOrEqual(segment.target.x)
      expect(x).toBeLessThanOrEqual(segment.target.x + segment.target.width)
    }
    expect(540).toBeGreaterThanOrEqual(segment.target.y)
    expect(540).toBeLessThanOrEqual(segment.target.y + segment.target.height)
  })

  it("centers a single-click segment on the click at the preset scale", () => {
    const singleClickTelemetry = normalizeCursorTelemetry({
      recordingId: "single-click",
      sourceWidth: 1920,
      sourceHeight: 1080,
      events: [v2Event(3_000, 800, 600, "left-down", true)],
    })

    const suggestions = generateSmartZoomSuggestions(singleClickTelemetry, fullRangeState, {
      preset: "product-demo",
    })

    expect(suggestions).toHaveLength(1)
    const segment = suggestions[0]
    expect(segment.scale).toBe(1.5)
    expect(segment.target.x + segment.target.width / 2).toBeCloseTo(800, 5)
    expect(segment.target.y + segment.target.height / 2).toBeCloseTo(600, 5)
  })

  it("weighs clicks 3:1 over dwells when picking the cluster center", () => {
    const dwellThenClickTelemetry = normalizeCursorTelemetry({
      recordingId: "dwell-click",
      sourceWidth: 1920,
      sourceHeight: 1080,
      events: [
        v2Event(1_000, 400, 540, "none"),
        v2Event(1_200, 400, 540, "none"),
        v2Event(1_400, 400, 540, "none"),
        v2Event(1_600, 400, 540, "none"),
        v2Event(1_800, 400, 540, "none"),
        v2Event(2_000, 400, 540, "none"),
        v2Event(2_100, 800, 540, "left-down", true),
        v2Event(2_500, 1_900, 900, "none"),
      ],
    })

    const suggestions = generateSmartZoomSuggestions(dwellThenClickTelemetry, fullRangeState, {
      preset: "product-demo",
      includeDwells: true,
      minDwellMs: 500,
    })

    expect(suggestions).toHaveLength(1)
    const target = suggestions[0].target
    // (400 * 1 dwell + 800 * 3 click) / 4 = 700
    expect(target.x + target.width / 2).toBeCloseTo(700, 5)
  })

  it("maps cursor points into zoom space as a stretch, not an aspect fit", () => {
    // 9:16 canvas + 16:9 telemetry: zoom space spans the full canvas, so a
    // source point at the bottom edge must reach y=1920, not the letterboxed
    // middle band an aspect-fit mapping would produce.
    const tallCanvas: TimelineCanvas = { ...canvas, width: 1080, height: 1920, padding: 0 }
    const tallTelemetry = normalizeCursorTelemetry({
      recordingId: "recording",
      sourceWidth: 1920,
      sourceHeight: 1080,
      events: [v2Event(0, 960, 0, "none"), v2Event(1_000, 960, 1_080, "none")],
    })
    const tallTimeline = {
      canvas: tallCanvas,
      tracks: [
        {
          id: "screen",
          kind: "screen" as const,
          name: "Screen",
          muted: false,
          locked: false,
          solo: false,
          volume: 1,
          clips: [
            {
              id: "screen-clip",
              kind: "screen" as const,
              assetId: "recording",
              startMs: 0,
              durationMs: 2_000,
              sourceInMs: 0,
              sourceOutMs: 2_000,
              speed: 1,
            },
          ],
        },
      ],
    } as any

    expect(getCursorPointAtTimelineTime(tallTimeline, 0, tallTelemetry)).toEqual({
      x: 540,
      y: 0,
    })
    expect(getCursorPointAtTimelineTime(tallTimeline, 1_000, tallTelemetry)).toEqual({
      x: 540,
      y: 1_920,
    })
  })

  it("evaluates canvas-fitted cursor position at timeline time via getCursorPointAtTimelineTime", () => {
    const mockTimeline = {
      canvas,
      tracks: [
        {
          id: "screen",
          kind: "screen" as const,
          name: "Screen",
          muted: false,
          locked: false,
          solo: false,
          volume: 1,
          clips: [
            {
              id: "screen-clip",
              kind: "screen" as const,
              assetId: "recording",
              startMs: 0,
              durationMs: 3_000,
              sourceInMs: 0,
              sourceOutMs: 3_000,
              speed: 1,
            },
          ],
        },
      ],
    } as any

    const point = getCursorPointAtTimelineTime(mockTimeline, 100, telemetry)
    expect(point).not.toBeNull()
    expect(point?.x).toBe(960)
    expect(point?.y).toBe(540)
  })

  it("targets the canvas center for a click at source center even with canvas padding", () => {
    const paddedState = makeTimelineState(
      [{ startMs: 0, durationMs: 20_000, sourceInMs: 0, sourceOutMs: 20_000, speed: 1 }],
      { padding: 96 },
    )
    const centeredTelemetry = normalizeCursorTelemetry({
      recordingId: "recording",
      sourceWidth: 1920,
      sourceHeight: 1080,
      events: [v2Event(3_000, 960, 540, "left-down", true)],
    })

    const suggestions = generateSmartZoomSuggestions(centeredTelemetry, paddedState, {
      preset: "product-demo",
    })

    expect(suggestions).toHaveLength(1)
    const target = suggestions[0].target
    expect(target.x + target.width / 2).toBeCloseTo(paddedState.canvas.width / 2, 5)
    expect(target.y + target.height / 2).toBeCloseTo(paddedState.canvas.height / 2, 5)
  })

  it("maps interaction times from source time to timeline time across offsets and speed", () => {
    // Screen clip covers source [4000, 10000) at speed 2, so it occupies
    // timeline [2000, 5000). A click at source 5000ms must land at 2500ms.
    const state = makeTimelineState([
      { startMs: 2_000, durationMs: 3_000, sourceInMs: 4_000, sourceOutMs: 10_000, speed: 2 },
    ])
    const clickTelemetry = normalizeCursorTelemetry({
      recordingId: "recording",
      sourceWidth: 1920,
      sourceHeight: 1080,
      events: [v2Event(5_000, 800, 600, "left-down", true), v2Event(9_900, 800, 600, "none")],
    })

    const suggestions = generateSmartZoomSuggestions(clickTelemetry, state, {
      preset: "product-demo",
      durationMs: 5_000,
    })

    expect(suggestions).toHaveLength(1)
    const segment = suggestions[0]
    // Click timeline time = 2000 + (5000-4000)/2 = 2500; the lead-in is the
    // larger of clickLeadInMs (500) and transitionIn (450) + 120ms buffer =
    // 570ms, and the 1200ms source-side click duration halves to 600ms at
    // speed 2. So the segment covers 2500-570=1930 to 2500+600=3100.
    expect(segment.startMs).toBe(1_930)
    expect(segment.durationMs).toBe(1_170)
  })

  it("drops interactions whose source range was trimmed away", () => {
    const state = makeTimelineState([
      { startMs: 0, durationMs: 3_000, sourceInMs: 4_000, sourceOutMs: 10_000, speed: 1 },
    ])
    const removedTelemetry = normalizeCursorTelemetry({
      recordingId: "recording",
      sourceWidth: 1920,
      sourceHeight: 1080,
      events: [v2Event(1_000, 800, 600, "left-down", true)],
    })

    expect(
      generateSmartZoomSuggestions(removedTelemetry, state, { preset: "product-demo" }),
    ).toEqual([])
  })
})
