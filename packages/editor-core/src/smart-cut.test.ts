import { describe, expect, it } from "vitest"
import {
  defaultCursorSettings,
  type ManualZoomSegment,
  type ScreenClip,
  type TimelineState,
  type TimelineTrack,
} from "@recordforge/contracts"
import {
  analyzeSmartCutRanges,
  lockedTracksBlockingRanges,
  prepareSmartCutRanges,
} from "./smart-cut"

describe("prepareSmartCutRanges", () => {
  const durationMs = 10_000

  it("preserves padding on both cut edges", () => {
    expect(
      prepareSmartCutRanges({
        ranges: [{ startMs: 1_000, endMs: 2_000 }],
        durationMs,
        paddingMs: 120,
      }),
    ).toEqual([{ startMs: 1_120, endMs: 1_880 }])
  })

  it("preserves no padding at the physical timeline ends", () => {
    expect(
      prepareSmartCutRanges({
        ranges: [
          { startMs: 0, endMs: 500 },
          { startMs: 9_000, endMs: 10_000 },
        ],
        durationMs,
        paddingMs: 120,
      }),
    ).toEqual([
      { startMs: 0, endMs: 380 },
      { startMs: 9_120, endMs: 10_000 },
    ])
  })

  it("merges overlapping and adjacent ranges before padding", () => {
    expect(
      prepareSmartCutRanges({
        ranges: [
          { startMs: 3_000, endMs: 4_000 },
          { startMs: 1_000, endMs: 2_000 },
          { startMs: 2_000, endMs: 3_000 },
        ],
        durationMs,
        paddingMs: 0,
      }),
    ).toEqual([{ startMs: 1_000, endMs: 4_000 }])
  })

  it("clamps out-of-bounds ranges to the timeline", () => {
    expect(
      prepareSmartCutRanges({
        ranges: [{ startMs: -200, endMs: 99_999 }],
        durationMs: 5_000,
        paddingMs: 0,
      }),
      // Covers the entire timeline → never delete the whole project.
    ).toEqual([])
    expect(
      prepareSmartCutRanges({
        ranges: [{ startMs: 4_000, endMs: 99_999 }],
        durationMs: 5_000,
        paddingMs: 0,
      }),
    ).toEqual([{ startMs: 4_000, endMs: 5_000 }])
  })

  it("discards cuts shorter than 80ms after padding", () => {
    expect(
      prepareSmartCutRanges({
        ranges: [{ startMs: 1_000, endMs: 1_250 }],
        durationMs,
        paddingMs: 120,
      }),
    ).toEqual([])
    expect(
      prepareSmartCutRanges({
        ranges: [{ startMs: 1_000, endMs: 1_320 }],
        durationMs,
        paddingMs: 120,
      }),
    ).toEqual([{ startMs: 1_120, endMs: 1_200 }])
  })

  it("drops malformed ranges instead of guessing", () => {
    expect(
      prepareSmartCutRanges({
        ranges: [
          { startMs: Number.NaN, endMs: 2_000 },
          { startMs: 100.5, endMs: 900 },
          { startMs: -50, endMs: 3_000 },
          { startMs: 3_000, endMs: 2_000 },
          { startMs: Number.POSITIVE_INFINITY, endMs: 9_000 },
          { startMs: 6_000, endMs: 7_000 },
        ],
        durationMs,
        paddingMs: 0,
      }),
    ).toEqual([
      { startMs: 0, endMs: 3_000 },
      { startMs: 6_000, endMs: 7_000 },
    ])
  })

  it("returns no cuts when silence covers the whole timeline", () => {
    expect(
      prepareSmartCutRanges({
        ranges: [{ startMs: 0, endMs: durationMs }],
        durationMs,
        paddingMs: 120,
      }),
    ).toEqual([])
    expect(
      prepareSmartCutRanges({
        ranges: [
          { startMs: 0, endMs: 5_000 },
          { startMs: 5_000, endMs: 10_000 },
        ],
        durationMs,
        paddingMs: 0,
      }),
    ).toEqual([])
  })

  it("reports wholeTimeline only when cuts would delete the whole project", () => {
    const whole = analyzeSmartCutRanges({
      ranges: [{ startMs: 0, endMs: durationMs }],
      durationMs,
      paddingMs: 120,
    })
    expect(whole).toEqual({ ranges: [], wholeTimeline: true })
    // No detections at all is a plain empty result, not a safety bail.
    expect(analyzeSmartCutRanges({ ranges: [], durationMs, paddingMs: 120 })).toEqual({
      ranges: [],
      wholeTimeline: false,
    })
    // Cuts surviving under the timeline are normal results.
    expect(
      analyzeSmartCutRanges({
        ranges: [{ startMs: 1_000, endMs: 2_000 }],
        durationMs,
        paddingMs: 0,
      }).wholeTimeline,
    ).toBe(false)
  })

  it("returns [] for degenerate durations", () => {
    expect(prepareSmartCutRanges({ ranges: [{ startMs: 0, endMs: 100 }], durationMs: 0 })).toEqual(
      [],
    )
    expect(
      prepareSmartCutRanges({
        ranges: [{ startMs: 0, endMs: 100 }],
        durationMs: Number.NaN,
      }),
    ).toEqual([])
  })

  it("treats missing or invalid padding as zero", () => {
    const ranges = [{ startMs: 1_000, endMs: 2_000 }]
    expect(prepareSmartCutRanges({ ranges, durationMs })).toEqual(ranges)
    expect(prepareSmartCutRanges({ ranges, durationMs, paddingMs: Number.NaN })).toEqual(ranges)
  })
})

function screenClip(id: string, startMs: number, durationMs: number): ScreenClip {
  return {
    id,
    assetId: "asset-1",
    kind: "screen",
    startMs,
    durationMs,
    sourceInMs: startMs,
    sourceOutMs: startMs + durationMs,
    speed: 1,
  }
}

function track(partial: Partial<TimelineTrack>): TimelineTrack {
  return {
    id: "track-1",
    kind: "screen",
    name: "Screen",
    muted: false,
    locked: false,
    solo: false,
    volume: 1,
    clips: [],
    ...partial,
  }
}

function stateWith(tracks: TimelineTrack[], zoomSegments?: ManualZoomSegment[]): TimelineState {
  return {
    version: 1,
    id: "timeline-1",
    name: "Test",
    recordingId: "rec-1",
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
    tracks,
    markers: [],
    zoomSegments,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

function zoomSegment(startMs: number, durationMs: number): ManualZoomSegment {
  return {
    id: `zoom-${startMs}`,
    startMs,
    durationMs,
    target: { x: 0, y: 0, width: 960, height: 540 },
    scale: 1.5,
    easing: "smooth",
    enabled: true,
    locked: false,
    mode: "manual",
  }
}

describe("lockedTracksBlockingRanges", () => {
  const ranges = [{ startMs: 5_000, endMs: 6_000 }]

  it("flags a locked track whose clips sit downstream of a cut", () => {
    const state = stateWith([
      track({
        id: "t-open",
        name: "Screen",
        clips: [screenClip("a", 0, 3_000), screenClip("b", 7_000, 2_000)],
      }),
      track({
        id: "t-locked",
        name: "Mic",
        locked: true,
        clips: [screenClip("c", 8_000, 1_000)],
      }),
    ])
    expect(lockedTracksBlockingRanges(state, ranges)).toEqual(["Mic"])
  })

  it("ignores locked tracks that end before the earliest cut", () => {
    const state = stateWith([
      track({
        id: "t-locked",
        name: "Intro",
        locked: true,
        clips: [screenClip("a", 0, 2_000)],
      }),
    ])
    expect(lockedTracksBlockingRanges(state, ranges)).toEqual([])
  })

  it("flags a locked zoom lane with segments downstream of a cut", () => {
    const state = stateWith(
      [track({ id: "t-zoom", kind: "zoom", name: "Zoom", locked: true })],
      [zoomSegment(8_000, 2_000)],
    )
    expect(lockedTracksBlockingRanges(state, ranges)).toEqual(["Zoom"])
  })

  it("ignores a locked zoom lane whose segments end before the cut", () => {
    const state = stateWith(
      [track({ id: "t-zoom", kind: "zoom", name: "Zoom", locked: true })],
      [zoomSegment(0, 2_000)],
    )
    expect(lockedTracksBlockingRanges(state, ranges)).toEqual([])
  })

  it("ignores unlocked tracks entirely", () => {
    const state = stateWith([track({ clips: [screenClip("a", 8_000, 2_000)] })])
    expect(lockedTracksBlockingRanges(state, ranges)).toEqual([])
  })

  it("returns [] for empty cut sets", () => {
    const state = stateWith([
      track({
        id: "t-locked",
        name: "Mic",
        locked: true,
        clips: [screenClip("a", 0, 9_000)],
      }),
    ])
    expect(lockedTracksBlockingRanges(state, [])).toEqual([])
  })
})
