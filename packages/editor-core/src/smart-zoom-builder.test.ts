import { describe, expect, it } from "vitest"
import {
  defaultCursorSettings,
  type TimelineCanvas,
  type TimelineState,
} from "@recordforge/contracts"
import {
  buildSmartZoomSegment,
  computeSmartZoomDuration,
} from "./smart-zoom-builder"

const canvas: TimelineCanvas = {
  width: 1920,
  height: 1080,
  fps: 60,
  background: "#000000",
  padding: 0,
  borderRadius: 0,
  shadow: false,
  cursorSettings: defaultCursorSettings,
}

function makeState(): TimelineState {
  return {
    version: 1,
    id: "smart-zoom-test-project",
    name: "Smart Zoom Test",
    recordingId: "rec",
    canvas,
    tracks: [
      {
        id: "track-screen",
        name: "Screen",
        kind: "screen",
        muted: false,
        solo: false,
        locked: false,
        volume: 1,
        clips: [
          {
            id: "clip-1",
            assetId: "asset-1",
            kind: "screen",
            startMs: 0,
            durationMs: 10_000,
            sourceInMs: 0,
            sourceOutMs: 10_000,
            speed: 1,
          },
        ],
      },
      {
        id: "track-zoom",
        name: "Zoom",
        kind: "zoom",
        muted: false,
        solo: false,
        locked: false,
        volume: 1,
        clips: [],
      },
    ],
    markers: [],
    zoomSegments: [
      {
        id: "existing-zoom-1",
        startMs: 4_000,
        durationMs: 2_000,
        target: { x: 320, y: 180, width: 1280, height: 720 },
        scale: 1.5,
        easing: "smooth",
        enabled: true,
        locked: false,
      },
    ],
    createdAt: "2026-08-14T00:00:00Z",
    updatedAt: "2026-08-14T00:00:00Z",
  }
}

describe("Smart Zoom Builder", () => {
  it("builds a default zoom segment centered on the cursor point", () => {
    const mockTimeline = makeState()
    const cursor = { x: 400, y: 300 }
    const segment = buildSmartZoomSegment(mockTimeline, cursor, {
      startMs: 1_000,
    })

    expect(segment.startMs).toBe(1_000)
    expect(segment.durationMs).toBe(2_000)
    expect(segment.scale).toBe(1.5)
    expect(segment.mode).toBe("follow-cursor")
    expect(segment.easing).toBe("smooth")
    expect(segment.enabled).toBe(true)
    expect(segment.locked).toBe(false)
    expect(segment.target.x).toBe(0) // Clamped to left edge
    expect(segment.target.width).toBe(1280)
    expect(segment.target.height).toBe(720)
  })

  it("falls back to canvas center when cursor is null", () => {
    const mockTimeline = makeState()
    const segment = buildSmartZoomSegment(mockTimeline, null, {
      startMs: 500,
    })

    expect(segment.startMs).toBe(500)
    // For 1.5x on 1920x1080: crop is 1280x720, centered at (960, 540) => top-left is (320, 180)
    expect(segment.target.x).toBeCloseTo(320, 0)
    expect(segment.target.y).toBeCloseTo(180, 0)
    expect(segment.target.width).toBeCloseTo(1280, 0)
    expect(segment.target.height).toBeCloseTo(720, 0)
  })

  it("applies developer preset (2.0x, snappy, 300ms transitions)", () => {
    const mockTimeline = makeState()
    const segment = buildSmartZoomSegment(mockTimeline, { x: 500, y: 500 }, {
      startMs: 1_000,
      preset: "developer",
    })

    expect(segment.scale).toBe(2.0)
    expect(segment.easing).toBe("snappy")
    expect(segment.transitionInMs).toBe(300)
    expect(segment.transitionOutMs).toBe(300)
  })

  it("applies cinematic preset (1.8x, cinematic, 600ms transitions)", () => {
    const mockTimeline = makeState()
    const segment = buildSmartZoomSegment(mockTimeline, { x: 500, y: 500 }, {
      startMs: 1_000,
      preset: "cinematic",
    })

    expect(segment.scale).toBe(1.8)
    expect(segment.easing).toBe("cinematic")
    expect(segment.mode).toBe("smooth-pan")
    expect(segment.transitionInMs).toBe(600)
    expect(segment.transitionOutMs).toBe(600)
  })

  it("applies subtle preset (1.25x, smooth, 400ms transitions)", () => {
    const mockTimeline = makeState()
    const segment = buildSmartZoomSegment(mockTimeline, { x: 500, y: 500 }, {
      startMs: 1_000,
      preset: "subtle",
    })

    expect(segment.scale).toBe(1.25)
    expect(segment.easing).toBe("smooth")
  })

  it("computes duration matching explicit endMs (range selection)", () => {
    const mockTimeline = makeState()
    const duration = computeSmartZoomDuration(mockTimeline, 1_000, {
      endMs: 3_500,
    })

    expect(duration).toBe(2_500)
  })

  it("clamps duration to avoid overlapping subsequent zoom segments", () => {
    const mockTimeline = makeState()
    // There is an existing segment starting at 4_000ms
    // If we insert at 2_500ms with default 2_000ms, it would end at 4_500ms (overlapping)
    // computeSmartZoomDuration should clamp it to 4_000 - 2_500 = 1_500ms
    const duration = computeSmartZoomDuration(mockTimeline, 2_500)

    expect(duration).toBe(1_500)
  })

  it("respects static mode and centers target even when cursor is provided", () => {
    const mockTimeline = makeState()
    const segment = buildSmartZoomSegment(
      mockTimeline,
      { x: 100, y: 100 },
      {
        startMs: 0,
        preset: "manual-only",
        mode: "static",
      },
    )

    expect(segment.mode).toBe("static")
    expect(segment.target.x).toBeCloseTo(320, 0)
    expect(segment.target.y).toBeCloseTo(180, 0)
    expect(segment.target.width).toBeCloseTo(1280, 0)
    expect(segment.target.height).toBeCloseTo(720, 0)
  })
})
