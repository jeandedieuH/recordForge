import { describe, expect, it } from "vitest"
import { defaultCursorSettings, type TimelineState } from "@recordforge/domain"
import {
  buildTimelineSegments,
  clipDurationFromSourceRange,
  findNextTimelineClip,
  findTimelineClipAt,
  isInsideClip,
  outputToTimeline,
  sourceToClipTime,
  sourceToTimeline,
  timelineToOutput,
  timelineToSource,
  timelineToSourceForState,
  timelineToSourceForTrack,
} from "./time-mapping"

function makeTestState(): TimelineState {
  return {
    version: 1,
    id: "project-1",
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
    tracks: [
      {
        id: "track-1",
        kind: "screen",
        name: "Screen",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "clip-1",
            kind: "screen",
            assetId: "rec-1",
            startMs: 0,
            durationMs: 60_000,
            sourceInMs: 0,
            sourceOutMs: 60_000,
            speed: 1,
          },
        ],
      },
    ],
    markers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function makeGappedState(): TimelineState {
  const state = makeTestState()
  state.tracks[0].clips = [
    {
      id: "clip-1",
      kind: "screen",
      assetId: "rec-1",
      startMs: 0,
      durationMs: 20_000,
      sourceInMs: 0,
      sourceOutMs: 20_000,
      speed: 1,
    },
    {
      id: "clip-2",
      kind: "screen",
      assetId: "rec-1",
      startMs: 40_000,
      durationMs: 20_000,
      sourceInMs: 20_000,
      sourceOutMs: 40_000,
      speed: 1,
    },
  ]
  return state
}

function makeSpedState(): TimelineState {
  const state = makeTestState()
  state.tracks[0].clips = [
    {
      id: "clip-1",
      kind: "screen",
      assetId: "rec-1",
      startMs: 0,
      durationMs: 30_000,
      sourceInMs: 0,
      sourceOutMs: 60_000,
      speed: 2,
    },
  ]
  return state
}

describe("time mapping", () => {
  it("computes clip duration from source range and speed", () => {
    expect(clipDurationFromSourceRange(0, 60_000, 1)).toBe(60_000)
    expect(clipDurationFromSourceRange(0, 60_000, 2)).toBe(30_000)
    expect(clipDurationFromSourceRange(10_000, 50_000, 0.5)).toBe(80_000)
  })

  it("determines whether a time is inside a clip", () => {
    const clip = makeTestState().tracks[0].clips[0]
    expect(isInsideClip(clip, 0)).toBe(true)
    expect(isInsideClip(clip, 30_000)).toBe(true)
    expect(isInsideClip(clip, 60_000)).toBe(true)
    expect(isInsideClip(clip, -1)).toBe(false)
    expect(isInsideClip(clip, 60_001)).toBe(false)
  })

  it("maps timeline time to source time for a clip", () => {
    const clip = makeTestState().tracks[0].clips[0]
    expect(timelineToSource(clip, 10_000)).toBe(10_000)
    expect(timelineToSource(clip, 30_000)).toBe(30_000)
    expect(timelineToSource(clip, 70_000)).toBe(null)
  })

  it("maps source time to clip timeline time", () => {
    const clip = makeTestState().tracks[0].clips[0]
    expect(sourceToClipTime(clip, 10_000)).toBe(10_000)
    expect(sourceToClipTime(clip, 60_000)).toBe(60_000)
    expect(sourceToClipTime(clip, 70_000)).toBe(null)
  })

  it("maps source time to the active timeline time across the state", () => {
    const state = makeGappedState()
    expect(sourceToTimeline(state, "rec-1", 5_000)).toMatchObject({
      clipId: "clip-1",
      timelineMs: 5_000,
      unambiguous: true,
    })
    expect(sourceToTimeline(state, "rec-1", 25_000)).toMatchObject({
      clipId: "clip-2",
      timelineMs: 45_000,
      unambiguous: true,
    })
  })

  it("maps timeline time to the active source time across the state", () => {
    const state = makeGappedState()
    expect(timelineToSourceForState(state, 5_000)).toMatchObject({
      clipId: "clip-1",
      sourceMs: 5_000,
    })
    expect(timelineToSourceForState(state, 45_000)).toMatchObject({
      clipId: "clip-2",
      sourceMs: 25_000,
    })
    expect(timelineToSourceForState(state, 30_000)).toBe(null)
  })

  it("maps edited playback to the screen track and skips gaps", () => {
    const state = makeGappedState()
    expect(findTimelineClipAt(state, "screen", 5_000)?.id).toBe("clip-1")
    expect(findTimelineClipAt(state, "screen", 30_000)).toBe(null)
    expect(findNextTimelineClip(state, "screen", 30_000)?.id).toBe("clip-2")
  })

  it("uses the edited clip range after a trim and split", () => {
    const state = makeTestState()
    state.tracks[0].clips = [
      {
        ...state.tracks[0].clips[0],
        id: "trimmed",
        sourceInMs: 10_000,
        sourceOutMs: 30_000,
        durationMs: 20_000,
      },
      {
        ...state.tracks[0].clips[0],
        id: "split",
        startMs: 20_000,
        sourceInMs: 30_000,
        sourceOutMs: 50_000,
        durationMs: 20_000,
      },
    ]

    expect(timelineToSourceForTrack(state, "screen", 5_000)).toMatchObject({
      clipId: "trimmed",
      sourceMs: 15_000,
    })
    expect(timelineToSourceForTrack(state, "screen", 25_000)).toMatchObject({
      clipId: "split",
      sourceMs: 35_000,
    })
  })

  it("preserves gaps in the default output mapping", () => {
    const state = makeGappedState()
    expect(timelineToOutput(state, 0)).toBe(0)
    expect(timelineToOutput(state, 20_000)).toBe(20_000)
    expect(timelineToOutput(state, 40_000)).toBe(40_000)
    expect(timelineToOutput(state, 60_000)).toBe(60_000)
  })

  it("squeezes gaps when requested", () => {
    const state = makeGappedState()
    expect(timelineToOutput(state, 0, { squeezeGaps: true })).toBe(0)
    expect(timelineToOutput(state, 20_000, { squeezeGaps: true })).toBe(20_000)
    expect(timelineToOutput(state, 40_000, { squeezeGaps: true })).toBe(20_000)
    expect(timelineToOutput(state, 60_000, { squeezeGaps: true })).toBe(40_000)
  })

  it("round-trips output to timeline in squeeze mode", () => {
    const state = makeGappedState()
    const outputTimes = [0, 10_000, 20_000, 30_000]
    for (const outputMs of outputTimes) {
      const timelineMs = outputToTimeline(state, outputMs, { squeezeGaps: true })
      expect(timelineMs).not.toBe(null)
      if (timelineMs === null) continue
      expect(timelineToOutput(state, timelineMs, { squeezeGaps: true })).toBe(outputMs)
    }
  })

  it("handles speed in source/timeline mapping", () => {
    const state = makeSpedState()
    const clip = state.tracks[0].clips[0]
    expect(timelineToSource(clip, 15_000)).toBe(30_000)
    expect(sourceToClipTime(clip, 30_000)).toBe(15_000)
    expect(timelineToSourceForState(state, 15_000)).toMatchObject({
      clipId: "clip-1",
      sourceMs: 30_000,
    })
  })

  it("builds segments for a single asset", () => {
    const state = makeGappedState()
    const segments = buildTimelineSegments(state, "rec-1")
    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({
      startMs: 0,
      endMs: 20_000,
      sourceInMs: 0,
      sourceOutMs: 20_000,
    })
    expect(segments[1]).toMatchObject({
      startMs: 40_000,
      endMs: 60_000,
      sourceInMs: 20_000,
      sourceOutMs: 40_000,
    })
  })
})
