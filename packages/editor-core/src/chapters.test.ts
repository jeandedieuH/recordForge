import { describe, expect, it } from "vitest"
import type { TimelineMarker } from "@recordforge/domain"
import {
  formatChapterTimestamp,
  formatYouTubeChapters,
  parseYouTubeChapters,
  timelineMarkersToChapters,
} from "./chapters"

describe("formatChapterTimestamp", () => {
  it("formats MM:SS for durations under an hour", () => {
    expect(formatChapterTimestamp(0)).toBe("00:00")
    expect(formatChapterTimestamp(5_000)).toBe("00:05")
    expect(formatChapterTimestamp(75_000)).toBe("01:15")
    expect(formatChapterTimestamp(3_599_000)).toBe("59:59")
  })

  it("formats HH:MM:SS for durations over an hour or when forced", () => {
    expect(formatChapterTimestamp(3_600_000)).toBe("01:00:00")
    expect(formatChapterTimestamp(3_665_000)).toBe("01:01:05")
    expect(formatChapterTimestamp(0, true)).toBe("00:00:00")
    expect(formatChapterTimestamp(125_000, true)).toBe("00:02:05")
  })
})

describe("formatYouTubeChapters", () => {
  it("returns empty string when no markers exist", () => {
    expect(formatYouTubeChapters([])).toBe("")
  })

  it("synthesizes 00:00 Intro if first marker starts after 0 ms", () => {
    const markers: Array<{ timeMs: number; label: string }> = [
      { timeMs: 15_000, label: "Overview" },
      { timeMs: 45_000, label: "Exporting" },
    ]
    const formatted = formatYouTubeChapters(markers, 60_000)
    expect(formatted).toBe("00:00 Intro\n00:15 Overview\n00:45 Exporting")
  })

  it("does not synthesize extra intro if marker at 0 ms already exists", () => {
    const markers: Array<{ timeMs: number; label: string }> = [
      { timeMs: 0, label: "Welcome" },
      { timeMs: 30_000, label: "Demo" },
    ]
    const formatted = formatYouTubeChapters(markers, 60_000)
    expect(formatted).toBe("00:00 Welcome\n00:30 Demo")
  })

  it("formats hours properly when video duration or marker exceeds 1 hour", () => {
    const markers: Array<{ timeMs: number; label: string }> = [
      { timeMs: 0, label: "Start" },
      { timeMs: 3_720_000, label: "One hour in" },
    ]
    const formatted = formatYouTubeChapters(markers, 4_000_000)
    expect(formatted).toBe("00:00:00 Start\n01:02:00 One hour in")
  })

  it("sanitizes newlines in labels and provides fallback for empty labels", () => {
    const markers: Array<{ timeMs: number; label: string }> = [
      { timeMs: 10_000, label: "Line 1\nLine 2" },
      { timeMs: 20_000, label: "   " },
    ]
    const formatted = formatYouTubeChapters(markers)
    expect(formatted).toBe("00:00 Intro\n00:10 Line 1 Line 2\n00:20 Chapter 3")
  })
})

describe("parseYouTubeChapters", () => {
  it("parses valid YouTube timestamp descriptions", () => {
    const text = `
00:00 Introduction
01:30 Setup and Installation
05:45 - Advanced Configuration
01:10:20 Final Thoughts
`
    const parsed = parseYouTubeChapters(text)
    expect(parsed).toEqual([
      { timeMs: 0, label: "Introduction" },
      { timeMs: 90_000, label: "Setup and Installation" },
      { timeMs: 345_000, label: "Advanced Configuration" },
      { timeMs: 4_220_000, label: "Final Thoughts" },
    ])
  })

  it("handles empty or invalid text gracefully", () => {
    expect(parseYouTubeChapters("")).toEqual([])
    expect(parseYouTubeChapters("Just some description without timestamps")).toEqual([])
  })
})

describe("timelineMarkersToChapters", () => {
  it("returns empty array when markers is empty or duration is 0", () => {
    expect(timelineMarkersToChapters([], 60_000)).toEqual([])
    expect(
      timelineMarkersToChapters(
        [{ id: "m1", timeMs: 10_000, label: "Topic", color: "#f59e0b" }],
        0,
      ),
    ).toEqual([])
  })

  it("synthesizes starting chapter when first marker is > 0", () => {
    const markers: TimelineMarker[] = [
      { id: "m1", timeMs: 10_000, label: "First Topic", color: "#f59e0b" },
      { id: "m2", timeMs: 40_000, label: "Second Topic", color: "#f59e0b" },
    ]
    const chapters = timelineMarkersToChapters(markers, 60_000)

    expect(chapters).toEqual([
      {
        id: "chapter-intro",
        title: "Intro",
        startMs: 0,
        endMs: 10_000,
      },
      {
        id: "m1",
        title: "First Topic",
        startMs: 10_000,
        endMs: 40_000,
      },
      {
        id: "m2",
        title: "Second Topic",
        startMs: 40_000,
        endMs: 60_000,
      },
    ])
  })

  it("handles marker at 0 ms directly", () => {
    const markers: TimelineMarker[] = [
      { id: "m1", timeMs: 0, label: "Kickoff", color: "#f59e0b" },
      { id: "m2", timeMs: 30_000, label: "Wrap up", color: "#f59e0b" },
    ]
    const chapters = timelineMarkersToChapters(markers, 60_000)

    expect(chapters).toEqual([
      {
        id: "m1",
        title: "Kickoff",
        startMs: 0,
        endMs: 30_000,
      },
      {
        id: "m2",
        title: "Wrap up",
        startMs: 30_000,
        endMs: 60_000,
      },
    ])
  })

  it("remaps markers when an export range is applied", () => {
    const markers: TimelineMarker[] = [
      { id: "m0", timeMs: 5_000, label: "Before range", color: "#f59e0b" },
      { id: "m1", timeMs: 15_000, label: "Inside 1", color: "#f59e0b" },
      { id: "m2", timeMs: 35_000, label: "Inside 2", color: "#f59e0b" },
      { id: "m3", timeMs: 55_000, label: "After range", color: "#f59e0b" },
    ]
    const range = { startMs: 10_000, endMs: 50_000 }
    const chapters = timelineMarkersToChapters(markers, 60_000, range)

    expect(chapters).toEqual([
      {
        id: "chapter-intro",
        title: "Intro",
        startMs: 0,
        endMs: 5_000, // 15_000 - 10_000
      },
      {
        id: "m1",
        title: "Inside 1",
        startMs: 5_000,
        endMs: 25_000, // 35_000 - 10_000
      },
      {
        id: "m2",
        title: "Inside 2",
        startMs: 25_000,
        endMs: 40_000, // 50_000 - 10_000 (effectiveDuration = 40_000)
      },
    ])
  })
})
