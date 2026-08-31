import { describe, expect, it } from "vitest"
import { defaultCursorSettings, type TimelineState } from "@recordforge/domain"
import { computePreviewMediaSync, createPlaybackClock, shouldCorrectDrift } from "./playback-clock"

function makeState(): TimelineState {
  return {
    version: 1,
    id: "clock-project",
    name: "Clock project",
    recordingId: "recording",
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
        id: "screen",
        kind: "screen",
        name: "Screen",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "clip-a",
            kind: "screen",
            assetId: "recording",
            startMs: 0,
            durationMs: 10_000,
            sourceInMs: 0,
            sourceOutMs: 10_000,
            speed: 1,
          },
          {
            id: "clip-b",
            kind: "screen",
            assetId: "recording",
            startMs: 15_000,
            durationMs: 5_000,
            sourceInMs: 10_000,
            sourceOutMs: 15_000,
            speed: 1,
          },
        ],
      },
    ],
    markers: [],
    createdAt: "2026-08-10T00:00:00Z",
    updatedAt: "2026-08-10T00:00:00Z",
  }
}

function makeSpeedState(): TimelineState {
  return {
    ...makeState(),
    tracks: [
      {
        ...makeState().tracks[0]!,
        clips: [
          {
            id: "clip-speed",
            kind: "screen",
            assetId: "recording",
            startMs: 0,
            durationMs: 5_000,
            sourceInMs: 0,
            sourceOutMs: 10_000,
            speed: 2,
          },
        ],
      },
    ],
  }
}

describe("PlaybackClock", () => {
  it("maps timeline time to source time within the active screen clip", () => {
    const clock = createPlaybackClock(makeState(), { fps: 30 })
    const pos = clock.mapTimelineToSource(2_000)
    expect(pos).not.toBeNull()
    expect(pos?.clipId).toBe("clip-a")
    expect(pos?.sourceMs).toBe(2_000)
    expect(pos?.playbackRate).toBe(1)
  })

  it("returns null for gaps between clips", () => {
    const clock = createPlaybackClock(makeState(), { fps: 30 })
    expect(clock.mapTimelineToSource(12_000)).toBeNull()
    expect(clock.mapTimelineToSource(9_900)).not.toBeNull()
    expect(clock.mapTimelineToSource(15_000)).not.toBeNull()
  })

  it("rounds times to the nearest output frame", () => {
    const clock = createPlaybackClock(makeState(), { fps: 30 })
    expect(clock.roundToFrame(10)).toBe(0)
    expect(clock.roundToFrame(40)).toBe(33)
    expect(clock.roundToFrame(100)).toBe(100)
  })

  it("maps source time back to timeline time unambiguously", () => {
    const clock = createPlaybackClock(makeState(), { fps: 30 })
    const mapped = clock.mapSourceToTimeline(2_000)
    expect(mapped).toMatchObject({
      timelineMs: 2_000,
      clipId: "clip-a",
      unambiguous: true,
    })
  })

  it("prefers a specific clip when mapping ambiguous source ranges", () => {
    const clock = createPlaybackClock(makeState(), { fps: 30 })
    const mapped = clock.mapSourceToTimeline(10_000, { preferClipId: "clip-b" })
    expect(mapped?.clipId).toBe("clip-b")
    expect(mapped?.timelineMs).toBe(15_000)
  })

  it("finds the next clip boundary after a position", () => {
    const clock = createPlaybackClock(makeState(), { fps: 30 })
    expect(clock.nextBoundary(2_000)).toMatchObject({
      timelineMs: 10_000,
      kind: "clip-end",
      clipId: "clip-a",
    })
    expect(clock.nextBoundary(12_000)).toMatchObject({
      timelineMs: 15_000,
      kind: "clip-start",
      clipId: "clip-b",
    })
    expect(clock.nextBoundary(19_000)).toMatchObject({
      timelineMs: 20_000,
      kind: "end",
      clipId: "clip-b",
    })
  })

  it("advances playhead through a clip and across a gap", () => {
    const clock = createPlaybackClock(makeState(), { fps: 30 })
    expect(clock.advanceFrame(1_000, 100, 1)).toBe(1_100)
    expect(clock.advanceFrame(14_900, 100, 1)).toBe(15_000)
    expect(clock.advanceFrame(15_000, 1_000, 1)).toBe(16_000)
  })

  it("applies user playback rate when advancing", () => {
    const clock = createPlaybackClock(makeState(), { fps: 30 })
    expect(clock.advanceFrame(1_000, 100, 2)).toBe(1_200)
  })

  it("applies clip speed to the effective playback rate", () => {
    const clock = createPlaybackClock(makeSpeedState(), { fps: 30 })
    const pos = clock.mapTimelineToSource(2_000, 1)
    expect(pos?.sourceMs).toBe(4_000)
    expect(pos?.playbackRate).toBe(2)
  })

  it("advances frame-accurately with a 2x speed clip", () => {
    const clock = createPlaybackClock(makeSpeedState(), { fps: 30 })
    expect(clock.advanceFrame(1_000, 100, 1)).toBe(1_100)
    expect(clock.advanceFrame(2_500, 100, 1)).toBe(2_600)
  })

  it("stops at the end of the last clip", () => {
    const clock = createPlaybackClock(makeState(), { fps: 30 })
    expect(clock.advanceFrame(19_000, 2_000, 1)).toBe(20_000)
  })

  it("reports and aggregates drift metrics", () => {
    const clock = createPlaybackClock(makeState(), { fps: 30 })
    clock.reportDrift(1_000, 1_016)
    clock.reportDrift(2_000, 2_033)
    clock.reportDrift(3_000, 3_008)
    const metrics = clock.drift()
    expect(metrics.sampleCount).toBe(3)
    expect(metrics.lastDriftMs).toBe(8)
    expect(metrics.maxDriftMs).toBe(33)
    expect(metrics.averageDriftMs).toBeCloseTo(19, 0)
  })

  it("resets drift metrics", () => {
    const clock = createPlaybackClock(makeState(), { fps: 30 })
    clock.reportDrift(1_000, 1_016)
    clock.resetDrift()
    expect(clock.drift().sampleCount).toBe(0)
  })

  it("uses different drift tolerances per quality mode", () => {
    const quality = createPlaybackClock(makeState(), { fps: 30, mode: "quality" })
    const performance = createPlaybackClock(makeState(), { fps: 30, mode: "performance" })
    const power = createPlaybackClock(makeState(), { fps: 30, mode: "power" })

    expect(quality.maxDriftMs).toBe((1000 / 30) * 0.5)
    expect(performance.maxDriftMs).toBe((1000 / 30) * 1.5)
    expect(power.maxDriftMs).toBe((1000 / 30) * 3)

    expect(shouldCorrectDrift(quality, 1_000, 1_020)).toBe(true)
    expect(shouldCorrectDrift(performance, 1_000, 1_020)).toBe(false)
  })

  it("caps the rolling drift window", () => {
    const clock = createPlaybackClock(makeState(), { fps: 30, driftWindowSize: 2 })
    clock.reportDrift(1_000, 1_010)
    clock.reportDrift(2_000, 2_020)
    clock.reportDrift(3_000, 3_005)
    expect(clock.drift().sampleCount).toBe(2)
    expect(clock.drift().maxDriftMs).toBe(20)
  })

  it("nudges camera playback within the 60fps hard-seek budget", () => {
    const clip = makeState().tracks[0].clips[0]
    const ahead = computePreviewMediaSync({
      kind: "camera",
      clip,
      playheadMs: 2_000,
      currentTimeMs: 2_020,
      playbackRate: 1,
      isPlaying: true,
      frameMs: 1000 / 60,
    })
    const behind = computePreviewMediaSync({
      kind: "camera",
      clip,
      playheadMs: 2_000,
      currentTimeMs: 1_980,
      playbackRate: 1,
      isPlaying: true,
      frameMs: 1000 / 60,
    })

    expect(ahead.shouldSeek).toBe(false)
    expect(ahead.playbackRate).toBeCloseTo(0.98)
    expect(behind.playbackRate).toBeCloseTo(1.02)
  })

  it("hard-seeks camera but avoids seeking continuous audio within its click-safe budget", () => {
    const clip = makeState().tracks[0].clips[0]
    const camera = computePreviewMediaSync({
      kind: "camera",
      clip,
      playheadMs: 2_000,
      currentTimeMs: 2_040,
      playbackRate: 1,
      isPlaying: true,
      frameMs: 1000 / 60,
    })
    const audio = computePreviewMediaSync({
      kind: "audio",
      clip,
      playheadMs: 2_000,
      currentTimeMs: 2_040,
      playbackRate: 1,
      isPlaying: true,
      frameMs: 1000 / 60,
    })
    const largeAudioDrift = computePreviewMediaSync({
      kind: "audio",
      clip,
      playheadMs: 2_000,
      currentTimeMs: 2_300,
      playbackRate: 1,
      isPlaying: true,
      frameMs: 1000 / 60,
    })

    expect(camera.shouldSeek).toBe(true)
    expect(audio.shouldSeek).toBe(false)
    expect(audio.playbackRate).toBe(1)
    expect(audio.preservesPitch).toBe(true)
    expect(largeAudioDrift.shouldSeek).toBe(true)
  })

  it("seeks paused media at sub-frame precision and pauses outside the clip", () => {
    const clip = makeState().tracks[0].clips[0]
    const paused = computePreviewMediaSync({
      kind: "audio",
      clip,
      playheadMs: 2_000,
      currentTimeMs: 2_005,
      playbackRate: 1,
      isPlaying: false,
      frameMs: 1000 / 60,
    })
    const outside = computePreviewMediaSync({
      kind: "camera",
      clip,
      playheadMs: 12_000,
      currentTimeMs: 10_000,
      playbackRate: 1,
      isPlaying: true,
      frameMs: 1000 / 60,
    })

    expect(paused.shouldSeek).toBe(true)
    expect(paused.shouldPause).toBe(true)
    expect(outside.shouldPlay).toBe(false)
    expect(outside.shouldPause).toBe(true)
  })
})
