import { describe, expect, it } from "vitest"
import type { TimelineClip, TimelineTrack } from "@recordforge/contracts"
import { clampTrimEdge, edgeScrollDelta, moveOverlaps } from "./timeline-gesture-math"

function mockClip(
  overrides: Partial<TimelineClip> & { kind?: TimelineClip["kind"] } = {},
): TimelineClip {
  return {
    id: "clip",
    kind: "screen",
    assetId: "asset",
    startMs: 5000,
    durationMs: 3000,
    sourceInMs: 2000,
    sourceOutMs: 5000,
    speed: 1,
    ...overrides,
  } as unknown as TimelineClip
}

function mockTrack(clips: TimelineClip[]): TimelineTrack {
  return {
    id: "track",
    kind: "screen",
    name: "Screen",
    muted: false,
    locked: false,
    solo: false,
    volume: 1,
    clips,
  } as unknown as TimelineTrack
}

const BASE = { frameMs: 33, prevEndMs: null, nextStartMs: null }

describe("clampTrimEdge", () => {
  it("clamps a media start edge at the source in-point", () => {
    // sourceLower = 5000 - 2000/1 = 3000
    const result = clampTrimEdge({
      ...BASE,
      edge: "start",
      edgeMs: 1000,
      clip: mockClip(),
    })
    expect(result).toEqual({ edgeMs: 3000, limit: "source-start" })
  })

  it("reports neighbor when the previous clip binds tighter than the source", () => {
    const result = clampTrimEdge({
      ...BASE,
      edge: "start",
      edgeMs: 1000,
      clip: mockClip(),
      prevEndMs: 4500,
    })
    expect(result).toEqual({ edgeMs: 4500, limit: "neighbor" })
  })

  it("clamps a start edge at the minimum duration", () => {
    const result = clampTrimEdge({
      ...BASE,
      edge: "start",
      edgeMs: 7999,
      clip: mockClip(),
    })
    expect(result).toEqual({ edgeMs: 8000 - 33, limit: "min-duration" })
  })

  it("clamps an end edge at the minimum duration", () => {
    const result = clampTrimEdge({
      ...BASE,
      edge: "end",
      edgeMs: 5001,
      clip: mockClip(),
    })
    expect(result).toEqual({ edgeMs: 5000 + 33, limit: "min-duration" })
  })

  it("clamps a media end edge at the source duration, honoring speed", () => {
    // sourceUpper = 0 + (max(6000, 4000) - 0) / 2 = 3000 at 2× speed
    const result = clampTrimEdge({
      ...BASE,
      edge: "end",
      edgeMs: 9000,
      clip: mockClip({ startMs: 0, sourceInMs: 0, sourceOutMs: 4000, speed: 2 }),
      sourceDurationMs: 6000,
    })
    expect(result).toEqual({ edgeMs: 3000, limit: "source-end" })
  })

  it("reports neighbor when the next clip binds tighter than the source", () => {
    const result = clampTrimEdge({
      ...BASE,
      edge: "end",
      edgeMs: 9000,
      clip: mockClip({ startMs: 0, sourceInMs: 0, sourceOutMs: 4000, speed: 2 }),
      sourceDurationMs: 6000,
      nextStartMs: 2000,
    })
    expect(result).toEqual({ edgeMs: 2000, limit: "neighbor" })
  })

  it("leaves free edges untouched", () => {
    const result = clampTrimEdge({
      ...BASE,
      edge: "start",
      edgeMs: 6000,
      clip: mockClip(),
    })
    expect(result).toEqual({ edgeMs: 6000, limit: null })
  })

  it("applies no source limits to non-media clips", () => {
    const caption = mockClip({ kind: "caption", sourceInMs: 0, sourceOutMs: 3000 })
    const result = clampTrimEdge({
      ...BASE,
      edge: "end",
      edgeMs: 999_999,
      clip: caption,
      sourceDurationMs: 6000,
    })
    expect(result).toEqual({ edgeMs: 999_999, limit: null })
  })

  it("applies no source limits to cursor-effect ranges", () => {
    // A media clip with sourceInMs > 0 would report "source-start" here; the
    // range clamps at the timeline edge instead.
    const range = mockClip({ kind: "cursor-effect", sourceInMs: 0, sourceOutMs: 0 })
    const result = clampTrimEdge({
      ...BASE,
      edge: "start",
      edgeMs: -5000,
      clip: range,
    })
    expect(result).toEqual({ edgeMs: 0, limit: "neighbor" })
  })
})

describe("moveOverlaps", () => {
  it("detects intersection with another clip", () => {
    const track = mockTrack([mockClip({ id: "a", startMs: 0, durationMs: 1000 })])
    expect(moveOverlaps(track, "b", 500, 1000)).toBe(true)
    expect(moveOverlaps(track, "b", 1000, 1000)).toBe(false)
  })

  it("ignores the clip itself", () => {
    const track = mockTrack([mockClip({ id: "a", startMs: 0, durationMs: 1000 })])
    expect(moveOverlaps(track, "a", 0, 1000)).toBe(false)
  })
})

describe("edgeScrollDelta", () => {
  it("returns 0 outside the edge zones", () => {
    expect(edgeScrollDelta(500, 0, 1000)).toBe(0)
  })

  it("scrolls left near the left edge, right near the right edge", () => {
    expect(edgeScrollDelta(20, 0, 1000)).toBeLessThan(0)
    expect(edgeScrollDelta(980, 0, 1000)).toBeGreaterThan(0)
  })

  it("hits max speed at the edges and eases quadratically", () => {
    expect(edgeScrollDelta(0, 0, 1000, 56, 22)).toBe(-22)
    expect(edgeScrollDelta(1000, 0, 1000, 56, 22)).toBe(22)
    // Halfway into the zone → quarter of max speed.
    expect(edgeScrollDelta(28, 0, 1000, 56, 22)).toBeCloseTo(-5.5)
  })
})
