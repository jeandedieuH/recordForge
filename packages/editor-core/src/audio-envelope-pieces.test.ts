import { describe, expect, it } from "vitest"
import type { AudioClip, TimelineState, TimelineTrack } from "@recordforge/contracts"
import {
  createEngine,
  createRippleDeleteRangeCommand,
  createSplitClipCommand,
  executeCommand,
} from "./index"

function audioClip(partial: Partial<AudioClip> = {}): AudioClip {
  return {
    id: "audio-1",
    assetId: "mic",
    kind: "audio",
    startMs: 0,
    durationMs: 5_000,
    sourceInMs: 0,
    sourceOutMs: 5_000,
    speed: 1,
    volume: 1,
    fadeInMs: 500,
    fadeOutMs: 400,
    volumeKeyframes: [
      { id: "k1", timeMs: 0, volume: 0.2 },
      { id: "k2", timeMs: 2_000, volume: 1 },
      { id: "k3", timeMs: 4_000, volume: 0.4 },
    ],
    ...partial,
  } as AudioClip
}

function stateWith(clip: AudioClip): TimelineState {
  const track: TimelineTrack = {
    id: "track-audio",
    kind: "audio",
    name: "Microphone",
    muted: false,
    locked: false,
    solo: false,
    volume: 1,
    clips: [clip],
  }
  return {
    version: 1,
    id: "timeline",
    name: "Timeline",
    recordingId: "recording",
    canvas: { width: 1920, height: 1080, fps: 30 } as TimelineState["canvas"],
    tracks: [track],
    markers: [],
    zoomSegments: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  } as TimelineState
}

function audioPieces(state: TimelineState): AudioClip[] {
  const track = state.tracks.find((candidate) => candidate.kind === "audio")
  return (track?.clips ?? []) as AudioClip[]
}

describe("audio envelope partitioning", () => {
  it("keeps only the real edge fade on each split half", () => {
    const result = executeCommand(
      createEngine(stateWith(audioClip())),
      createSplitClipCommand("audio-1", 2_000, { leftClipId: "left", rightClipId: "right" }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const pieces = audioPieces(result.value.history.present)
    const left = pieces.find((piece) => piece.id === "left")!
    const right = pieces.find((piece) => piece.id === "right")!

    expect(left.fadeInMs).toBe(500)
    expect(left.fadeOutMs).toBe(0)
    expect(right.fadeInMs).toBe(0)
    expect(right.fadeOutMs).toBe(400)
  })

  it("rebases keyframes onto each piece and interpolates the new edges", () => {
    const result = executeCommand(
      createEngine(stateWith(audioClip())),
      createSplitClipCommand("audio-1", 2_000, { leftClipId: "left", rightClipId: "right" }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const pieces = audioPieces(result.value.history.present)
    const left = pieces.find((piece) => piece.id === "left")!
    const right = pieces.find((piece) => piece.id === "right")!

    expect(left.volumeKeyframes?.map((keyframe) => keyframe.timeMs)).toEqual([0, 2_000])
    expect(left.volumeKeyframes?.map((keyframe) => keyframe.volume)).toEqual([0.2, 1])
    // Right half covers source 2000..5000: k2 sits at 0, k3 at 2000, plus the
    // interpolated tail at 3000.
    expect(right.volumeKeyframes?.map((keyframe) => keyframe.timeMs)).toEqual([0, 2_000, 3_000])
    expect(right.volumeKeyframes?.map((keyframe) => keyframe.volume)).toEqual([1, 0.4, 0.4])
  })

  it("gives the right piece after a range delete zero fade-in and a continuous ramp", () => {
    const result = executeCommand(
      createEngine(stateWith(audioClip())),
      createRippleDeleteRangeCommand(2_000, 3_000),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const pieces = audioPieces(result.value.history.present)
    const right = pieces.find((piece) => piece.startMs === 2_000)!
    // It resumes at source 3000 on a 0.7-downward ramp.
    expect(right.fadeInMs).toBe(0)
    expect(right.fadeOutMs).toBe(400)
    expect(right.volumeKeyframes?.map((keyframe) => keyframe.timeMs)).toEqual([0, 1_000, 2_000])
    expect(right.volumeKeyframes?.map((keyframe) => keyframe.volume)).toEqual([0.7, 0.4, 0.4])
  })
})
