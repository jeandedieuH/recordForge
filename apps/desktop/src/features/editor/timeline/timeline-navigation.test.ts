import { describe, expect, it } from "vitest"
import type { TimelineState } from "@recordforge/contracts"
import {
  findNextCut,
  findPreviousCut,
  getTimelineEditPoints,
  parseTimecode,
} from "./timeline-navigation"

describe("timeline-navigation", () => {
  const sampleTimeline = {
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
            kind: "screen",
            assetId: "asset-1",
            sourceInMs: 0,
            sourceOutMs: 5000,
            startMs: 0,
            durationMs: 5000,
            speed: 1,
          },
          {
            id: "clip-2",
            kind: "screen",
            assetId: "asset-1",
            sourceInMs: 5000,
            sourceOutMs: 12000,
            startMs: 6000,
            durationMs: 6000,
            speed: 1,
          },
        ],
      },
      {
        id: "track-audio",
        name: "Mic",
        kind: "audio",
        muted: false,
        solo: false,
        locked: false,
        volume: 1,
        clips: [
          {
            id: "clip-audio-1",
            kind: "audio",
            assetId: "asset-2",
            sourceInMs: 0,
            sourceOutMs: 10000,
            startMs: 1000,
            durationMs: 9000,
            speed: 1,
            volume: 1,
            fadeInMs: 0,
            fadeOutMs: 0,
          },
        ],
      },
    ],
    markers: [
      { id: "m-1", label: "Intro", timeMs: 3000, color: "#38bdf8" },
      { id: "m-2", label: "Outro", timeMs: 11000, color: "#a78bfa" },
    ],
    zoomSegments: [
      {
        id: "z-1",
        startMs: 2000,
        durationMs: 2000,
        scale: 1.5,
        target: { x: 0.5, y: 0.5, width: 1, height: 1 },
      },
    ],
  } as unknown as TimelineState

  describe("getTimelineEditPoints", () => {
    it("gathers and deduplicates all edit boundaries, markers, and zoom points in order", () => {
      const points = getTimelineEditPoints(sampleTimeline, 15000)
      expect(points).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000, 10000, 11000, 12000, 15000])
    })

    it("handles an empty timeline gracefully", () => {
      const emptyState: TimelineState = {
        ...sampleTimeline,
        tracks: [],
        markers: [],
        zoomSegments: [],
      }
      const points = getTimelineEditPoints(emptyState, 5000)
      expect(points).toEqual([0, 5000])
    })
  })

  describe("findPreviousCut", () => {
    const editPoints = [0, 1000, 2000, 3000, 5000, 10000]

    it("jumps to the closest cut before playhead", () => {
      expect(findPreviousCut(editPoints, 2500)).toBe(2000)
      expect(findPreviousCut(editPoints, 4900)).toBe(3000)
      expect(findPreviousCut(editPoints, 10000)).toBe(5000)
    })

    it("respects threshold to prevent getting stuck on current cut", () => {
      // If playhead is right on or near 3000 (e.g. 3005), jumping previous should go to 2000, not 3000
      expect(findPreviousCut(editPoints, 3005, 20)).toBe(2000)
    })

    it("returns 0 if already at or before the first cut", () => {
      expect(findPreviousCut(editPoints, 0)).toBe(0)
      expect(findPreviousCut(editPoints, 10)).toBe(0)
    })
  })

  describe("findNextCut", () => {
    const editPoints = [0, 1000, 2000, 3000, 5000, 10000]

    it("jumps to the closest cut after playhead", () => {
      expect(findNextCut(editPoints, 500)).toBe(1000)
      expect(findNextCut(editPoints, 2500)).toBe(3000)
      expect(findNextCut(editPoints, 5000)).toBe(10000)
    })

    it("respects threshold to prevent getting stuck on current cut", () => {
      // If playhead is before 2000 beyond threshold (e.g. 1970), jump next hits 2000
      expect(findNextCut(editPoints, 1970, 20)).toBe(2000)
      // If playhead is right on or within threshold of 2000 (e.g. 1995 or 2005), jumping next advances to 3000
      expect(findNextCut(editPoints, 1995, 20)).toBe(3000)
      expect(findNextCut(editPoints, 2005, 20)).toBe(3000)
    })

    it("returns the last point if already at or past the last cut", () => {
      expect(findNextCut(editPoints, 10000)).toBe(10000)
      expect(findNextCut(editPoints, 12000)).toBe(10000)
    })
  })

  describe("parseTimecode", () => {
    const durationMs = 120000 // 2 minutes

    it("parses MM:SS format correctly", () => {
      expect(parseTimecode("01:30", durationMs)).toBe(90000)
      expect(parseTimecode("0:15", durationMs)).toBe(15000)
    })

    it("parses MM:SS.ms format correctly", () => {
      expect(parseTimecode("00:05.5", durationMs)).toBe(5500)
      expect(parseTimecode("01:00.25", durationMs)).toBe(60250)
    })

    it("parses HH:MM:SS format correctly", () => {
      expect(parseTimecode("00:01:30", durationMs)).toBe(90000)
      expect(parseTimecode("01:00:00", 7200000)).toBe(3600000)
    })

    it("parses raw seconds correctly", () => {
      expect(parseTimecode("45", durationMs)).toBe(45000)
      expect(parseTimecode("12.5", durationMs)).toBe(12500)
    })

    it("clamps to durationMs range", () => {
      expect(parseTimecode("05:00", durationMs)).toBe(120000)
      expect(parseTimecode("999", durationMs)).toBe(120000)
    })

    it("rejects invalid strings", () => {
      expect(parseTimecode("", durationMs)).toBeNull()
      expect(parseTimecode("abc", durationMs)).toBeNull()
      expect(parseTimecode("12abc", durationMs)).toBeNull()
      expect(parseTimecode(":", durationMs)).toBeNull()
      expect(parseTimecode("::", durationMs)).toBeNull()
      expect(parseTimecode(":::", durationMs)).toBeNull()
      expect(parseTimecode(":30", durationMs)).toBeNull()
      expect(parseTimecode("30:", durationMs)).toBeNull()
      expect(parseTimecode("1.5:30", durationMs)).toBeNull()
      expect(parseTimecode("1:2.5:30", durationMs)).toBeNull()
      expect(parseTimecode("12.34.56", durationMs)).toBeNull()
      expect(parseTimecode("-10", durationMs)).toBeNull()
      expect(parseTimecode("+10", durationMs)).toBeNull()
      expect(parseTimecode("01:65", durationMs)).toBeNull()
      expect(parseTimecode("1:2:3:4", durationMs)).toBeNull()
    })

    it("parses relative offsets when currentMs is provided", () => {
      // Forward offset
      expect(parseTimecode("+5", durationMs, 20000)).toBe(25000)
      expect(parseTimecode("+01:30", durationMs, 10000)).toBe(100000)
      // Backward offset
      expect(parseTimecode("-10", durationMs, 25000)).toBe(15000)
      expect(parseTimecode("-0:05", durationMs, 12000)).toBe(7000)
      // Boundary clamping on relative offsets
      expect(parseTimecode("-999", durationMs, 5000)).toBe(0)
      expect(parseTimecode("+999", durationMs, 110000)).toBe(120000)
    })

    it("handles zero and boundary inputs gracefully", () => {
      expect(parseTimecode("0", durationMs)).toBe(0)
      expect(parseTimecode("00:00", durationMs)).toBe(0)
      expect(parseTimecode("00:00.00", durationMs)).toBe(0)
      expect(parseTimecode("10", 0)).toBe(0)
    })
  })

  describe("edge cases in edit points and cuts", () => {
    it("handles corrupted or NaN values in timeline without throwing", () => {
      const corruptedTimeline = {
        tracks: [
          {
            id: "bad-track",
            clips: [
              { id: "c-nan", startMs: NaN, durationMs: 5000 },
              { id: "c-valid", startMs: 2000, durationMs: 3000 },
            ],
          },
        ],
        markers: [{ id: "m-bad", timeMs: NaN }],
        zoomSegments: [{ id: "z-bad", startMs: NaN, durationMs: NaN }],
      } as unknown as TimelineState

      const points = getTimelineEditPoints(corruptedTimeline, 10000)
      expect(points).toEqual([0, 2000, 5000, 10000])
    })

    it("clamps edit points extending past durationMs", () => {
      const overflowTimeline = {
        tracks: [
          {
            id: "overflow-track",
            clips: [
              { id: "c-overflow", startMs: 8000, durationMs: 5000 }, // ends at 13000
            ],
          },
        ],
        markers: [{ id: "m-overflow", timeMs: 15000 }],
        zoomSegments: [{ id: "z-overflow", startMs: 9000, durationMs: 4000 }],
      } as unknown as TimelineState

      const points = getTimelineEditPoints(overflowTimeline, 10000)
      expect(points).toEqual([0, 8000, 9000, 10000])
      expect(points.every((pt) => pt >= 0 && pt <= 10000)).toBe(true)
    })

    it("handles negative currentMs or empty arrays in findPreviousCut / findNextCut", () => {
      expect(findPreviousCut([], 5000)).toBe(0)
      expect(findPreviousCut([0, 1000, 2000], -500)).toBe(0)
      expect(findNextCut([], 5000)).toBe(5000)
      expect(findNextCut([0, 1000, 2000], -500)).toBe(0)
    })
  })
})
