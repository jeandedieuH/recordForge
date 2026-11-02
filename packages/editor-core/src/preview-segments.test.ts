import { describe, expect, it } from "vitest"
import type { TimelineClip } from "@recordforge/domain"
import {
  buildPreviewSegments,
  classifyPreviewFrame,
  nextPreviewSegment,
  previewSegmentAt,
  previewSegmentSourceMs,
  previewSegmentTimelineMs,
  type PreviewSegment,
} from "./preview-segments"

function clip(partial: Partial<TimelineClip> & { id: string; startMs: number }): TimelineClip {
  return {
    assetId: "screen",
    kind: "screen",
    durationMs: 1_000,
    sourceInMs: partial.startMs,
    sourceOutMs: partial.startMs + (partial.durationMs ?? 1_000),
    speed: 1,
    ...partial,
  } as TimelineClip
}

const sourceKey = (item: TimelineClip) => item.assetId

describe("buildPreviewSegments", () => {
  it("fuses output-contiguous clips with continuous source and equal speed", () => {
    const segments = buildPreviewSegments(
      [
        clip({ id: "a", startMs: 0, durationMs: 1_000, sourceInMs: 10_000, sourceOutMs: 11_000 }),
        clip({
          id: "b",
          startMs: 1_000,
          durationMs: 2_000,
          sourceInMs: 11_000,
          sourceOutMs: 13_000,
        }),
      ],
      sourceKey,
    )
    expect(segments).toEqual([
      {
        startMs: 0,
        endMs: 3_000,
        sourceInMs: 10_000,
        sourceOutMs: 13_000,
        speed: 1,
        sourceKey: "screen",
        clipIds: ["a", "b"],
      },
    ])
  })

  it("splits on a source hole, a speed change, or a different source", () => {
    const segments = buildPreviewSegments(
      [
        clip({ id: "a", startMs: 0, durationMs: 1_000, sourceInMs: 0, sourceOutMs: 1_000 }),
        clip({ id: "b", startMs: 1_000, durationMs: 1_000, sourceInMs: 5_000, sourceOutMs: 6_000 }),
        clip({ id: "c", startMs: 2_000, durationMs: 1_000, sourceInMs: 6_000, sourceOutMs: 7_000 }),
        clip({ id: "d", startMs: 3_000, durationMs: 1_000, sourceInMs: 7_500, sourceOutMs: 8_500 }),
        clip({
          id: "e",
          startMs: 4_000,
          durationMs: 1_000,
          sourceInMs: 8_000,
          sourceOutMs: 9_000,
          assetId: "camera",
        }),
        clip({
          id: "f",
          startMs: 5_000,
          durationMs: 1_000,
          sourceInMs: 9_000,
          sourceOutMs: 10_500,
          speed: 1.5,
        }),
      ],
      sourceKey,
    )
    expect(segments.map((segment) => segment.clipIds)).toEqual([
      ["a"],
      ["b", "c"],
      ["d"],
      ["e"],
      ["f"],
    ])
    expect(segments[2]!.speed).toBe(1)
    expect(segments[4]!.speed).toBe(1.5)
  })

  it("leaves gaps uncovered instead of stretching a segment", () => {
    const segments = buildPreviewSegments(
      [
        clip({ id: "a", startMs: 0, durationMs: 1_000, sourceInMs: 0, sourceOutMs: 1_000 }),
        clip({ id: "b", startMs: 2_000, durationMs: 1_000, sourceInMs: 2_000, sourceOutMs: 3_000 }),
      ],
      sourceKey,
    )
    expect(segments).toHaveLength(2)
    expect(segments[0]!.endMs).toBe(1_000)
    expect(segments[1]!.startMs).toBe(2_000)
  })
})

describe("preview segment lookup", () => {
  const segments: PreviewSegment[] = [
    {
      startMs: 0,
      endMs: 1_000,
      sourceInMs: 0,
      sourceOutMs: 1_000,
      speed: 1,
      sourceKey: "screen",
      clipIds: ["a"],
    },
    {
      startMs: 2_000,
      endMs: 3_000,
      sourceInMs: 2_000,
      sourceOutMs: 3_000,
      speed: 1,
      sourceKey: "screen",
      clipIds: ["b"],
    },
  ]

  it("finds the active segment and reports gaps", () => {
    expect(previewSegmentAt(segments, 0)).toBe(0)
    expect(previewSegmentAt(segments, 999)).toBe(0)
    expect(previewSegmentAt(segments, 1_000)).toBe(-1)
    expect(previewSegmentAt(segments, 1_500)).toBe(-1)
    expect(previewSegmentAt(segments, 2_500)).toBe(1)
    expect(previewSegmentAt(segments, 3_000)).toBe(-1)
  })

  it("pre-rolls the segment after the active one, or after the playhead in a gap", () => {
    expect(nextPreviewSegment(segments, 500)).toBe(1)
    expect(nextPreviewSegment(segments, 1_500)).toBe(1)
    expect(nextPreviewSegment(segments, 2_500)).toBe(-1)
    expect(nextPreviewSegment(segments, 5_000)).toBe(-1)
  })
})

describe("preview segment frame math", () => {
  const segment: PreviewSegment = {
    startMs: 2_000,
    endMs: 4_000,
    sourceInMs: 10_000,
    sourceOutMs: 12_000,
    speed: 1,
    sourceKey: "screen",
    clipIds: ["a"],
  }

  it("maps the playhead to source time and clamps at both edges", () => {
    expect(previewSegmentSourceMs(segment, 2_500)).toBe(10_500)
    expect(previewSegmentSourceMs(segment, 1_000)).toBe(10_000)
    expect(previewSegmentSourceMs(segment, 9_000)).toBe(12_000)
  })

  it("maps source time back to the timeline and clamps at both edges", () => {
    expect(previewSegmentTimelineMs(segment, 10_500)).toBe(2_500)
    expect(previewSegmentTimelineMs(segment, 0)).toBe(2_000)
    expect(previewSegmentTimelineMs(segment, 99_000)).toBe(4_000)
  })

  it("honors speed in both directions", () => {
    const fast: PreviewSegment = { ...segment, speed: 2, sourceOutMs: 14_000 }
    expect(previewSegmentSourceMs(fast, 2_500)).toBe(11_000)
    expect(previewSegmentTimelineMs(fast, 11_000)).toBe(2_500)
  })

  it("classifies frames around the segment with one-frame tolerance", () => {
    expect(classifyPreviewFrame(segment, 9_000, 16)).toBe("before-start")
    expect(classifyPreviewFrame(segment, 10_005, 16)).toBe("inside")
    expect(classifyPreviewFrame(segment, 11_000, 16)).toBe("inside")
    expect(classifyPreviewFrame(segment, 11_995, 16)).toBe("past-end")
    expect(classifyPreviewFrame(segment, 12_400, 16)).toBe("past-end")
  })
})
