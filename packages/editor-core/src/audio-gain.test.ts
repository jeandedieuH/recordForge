import { describe, expect, it } from "vitest"
import type { AudioClip, TimelineState, TimelineTrack } from "@recordforge/contracts"
import {
  clampAudioGain,
  evaluateAudioGain,
  evaluatePlayheadGain,
  evaluateVolumeEnvelope,
  foldTrackGainIntoTimeline,
} from "./audio-envelope"

function audioClip(partial: Partial<AudioClip> = {}): AudioClip {
  return {
    id: "audio-1",
    assetId: "mic",
    kind: "audio",
    startMs: 0,
    durationMs: 10_000,
    sourceInMs: 0,
    sourceOutMs: 10_000,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    ...partial,
  } as AudioClip
}

function audioTrack(clip: AudioClip, volume = 1): TimelineTrack {
  return {
    id: "track-audio",
    kind: "audio",
    name: "Microphone",
    muted: false,
    locked: false,
    solo: false,
    volume,
    clips: [clip],
  }
}

function stateWith(tracks: TimelineTrack[]): TimelineState {
  return {
    version: 1,
    id: "timeline",
    name: "Timeline",
    recordingId: "recording",
    canvas: { width: 1920, height: 1080, fps: 30 } as TimelineState["canvas"],
    tracks,
    markers: [],
    zoomSegments: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  } as TimelineState
}

describe("evaluateVolumeEnvelope with the clip master gain", () => {
  it("scales keyframe automation by the clip volume", () => {
    const clip = audioClip({
      volume: 0.5,
      volumeKeyframes: [
        { id: "k1", timeMs: 2_000, volume: 0.4 },
        { id: "k2", timeMs: 6_000, volume: 1.6 },
      ],
    })

    expect(evaluateVolumeEnvelope(clip, 2_000)).toBeCloseTo(0.2, 5)
    expect(evaluateVolumeEnvelope(clip, 4_000)).toBeCloseTo(0.5, 5)
    expect(evaluateVolumeEnvelope(clip, 6_000)).toBeCloseTo(0.8, 5)
  })

  it("matches the render plan's keyframe gain expression", () => {
    // The render plan bakes clip volume into each keyframe point
    // (`kf.volume * clip.volume`), so the preview envelope must scale too.
    const clip = audioClip({
      volume: 0.5,
      volumeKeyframes: [{ id: "k1", timeMs: 0, volume: 1.5 }],
    })

    expect(evaluateVolumeEnvelope(clip, 5_000)).toBeCloseTo(0.75, 5)
  })
})

describe("evaluateAudioGain", () => {
  it("multiplies the track fader by the clip envelope", () => {
    const clip = audioClip({ volume: 0.5 })
    expect(evaluateAudioGain(clip, 1_000, 1)).toBeCloseTo(0.5, 5)
    expect(evaluateAudioGain(clip, 1_000, 0.5)).toBeCloseTo(0.25, 5)
    expect(evaluateAudioGain(clip, 1_000, 4)).toBeCloseTo(1.0, 5)
  })

  it("clamps the combined gain to the export ceiling", () => {
    const clip = audioClip({ volume: 2 })
    expect(evaluateAudioGain(clip, 1_000, 2)).toBe(2)
    expect(clampAudioGain(Number.NaN)).toBe(0)
    expect(clampAudioGain(-1)).toBe(0)
  })
})

describe("evaluatePlayheadGain", () => {
  it("attenuates the preview instead of cancelling the clip gain", () => {
    // Regression: the preview used to divide the envelope by clip.volume, so
    // every value except 0 played at full volume.
    const clip = audioClip({ startMs: 2_000, volume: 0.5 })

    expect(evaluatePlayheadGain(clip, 5_000)).toBeCloseTo(0.5, 5)
    expect(evaluatePlayheadGain(clip, 5_000, 0.5)).toBeCloseTo(0.25, 5)
    expect(evaluatePlayheadGain(clip, 5_000, 0)).toBe(0)
  })

  it("caps the preview at 100%", () => {
    const clip = audioClip({ volume: 2 })
    expect(evaluatePlayheadGain(clip, 1_000, 1)).toBe(1)
  })

  it("applies fades on the clip-local clock", () => {
    const clip = audioClip({ startMs: 2_000, durationMs: 4_000, fadeInMs: 1_000, volume: 0.8 })
    // Halfway through the fade-in.
    expect(evaluatePlayheadGain(clip, 2_500)).toBeCloseTo(0.4, 5)
    // Outside the clip.
    expect(evaluatePlayheadGain(clip, 1_000)).toBe(0)
  })
})

describe("foldTrackGainIntoTimeline", () => {
  it("preserves the effective gain while removing the second stage", () => {
    const clip = audioClip({ volume: 0.8, fadeInMs: 500 })
    const timeline = stateWith([audioTrack(clip, 0.5)])
    const before = evaluateAudioGain(clip, 2_000, 0.5)

    const { timeline: folded, changed } = foldTrackGainIntoTimeline(timeline)
    const track = folded.tracks[0] as TimelineTrack
    const foldedClip = track.clips[0] as AudioClip

    expect(changed).toBe(true)
    expect(track.volume).toBe(1)
    expect(foldedClip.volume).toBeCloseTo(0.4, 5)
    expect(evaluateAudioGain(foldedClip, 2_000, track.volume)).toBeCloseTo(before, 5)
  })

  it("keeps keyframed automation intact", () => {
    const clip = audioClip({
      volume: 0.5,
      volumeKeyframes: [
        { id: "k1", timeMs: 0, volume: 0.5 },
        { id: "k2", timeMs: 8_000, volume: 1.5 },
      ],
    })
    const timeline = stateWith([audioTrack(clip, 0.5)])
    const before = evaluateAudioGain(clip, 4_000, 0.5)

    const { timeline: folded } = foldTrackGainIntoTimeline(timeline)
    const track = folded.tracks[0] as TimelineTrack
    const foldedClip = track.clips[0] as AudioClip

    expect(foldedClip.volume).toBeCloseTo(0.25, 5)
    expect(foldedClip.volumeKeyframes).toEqual(clip.volumeKeyframes)
    expect(evaluateAudioGain(foldedClip, 4_000, track.volume)).toBeCloseTo(before, 5)
  })

  it("leaves an already-normalized timeline untouched", () => {
    const clip = audioClip({ volume: 0.8 })
    const timeline = stateWith([audioTrack(clip, 1)])

    const result = foldTrackGainIntoTimeline(timeline)

    expect(result.changed).toBe(false)
    expect(result.timeline).toBe(timeline)
  })

  it("ignores non-audio tracks", () => {
    const screenTrack: TimelineTrack = {
      id: "track-screen",
      kind: "screen",
      name: "Screen",
      muted: false,
      locked: false,
      solo: false,
      volume: 0.5,
      clips: [],
    }
    const timeline = stateWith([screenTrack])

    const result = foldTrackGainIntoTimeline(timeline)

    expect(result.changed).toBe(false)
    expect(result.timeline.tracks[0]?.volume).toBe(0.5)
  })
})
