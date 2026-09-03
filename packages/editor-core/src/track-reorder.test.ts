import { describe, expect, it } from "vitest"
import { defaultCursorSettings, type AudioClip, type TimelineState, type TimelineTrack } from "@recordforge/contracts"
import {
  applyCommand,
  createMoveTrackCommand,
  createReorderTracksCommand,
  createUpdateClipAudioCommand,
} from "./commands"

function createTestState(): TimelineState {
  const tracks: TimelineTrack[] = [
    {
      id: "track-screen",
      kind: "screen",
      name: "Screen",
      muted: false,
      locked: false,
      solo: false,
      volume: 1,
      clips: [],
    },
    {
      id: "track-camera",
      kind: "camera",
      name: "Camera",
      muted: false,
      locked: false,
      solo: false,
      volume: 1,
      clips: [],
    },
    {
      id: "track-mic",
      kind: "audio",
      name: "Microphone",
      muted: false,
      locked: false,
      solo: false,
      volume: 1,
      clips: [
        {
          id: "audio-clip-1",
          kind: "audio",
          assetId: "asset-1",
          startMs: 0,
          durationMs: 10000,
          sourceInMs: 0,
          sourceOutMs: 10000,
          speed: 1,
          volume: 1,
          fadeInMs: 500,
          fadeOutMs: 1000,
        } as AudioClip,
      ],
    },
  ]

  return {
    version: 1,
    id: "project-1",
    name: "Test",
    recordingId: "rec-1",
    canvas: {
      width: 1920,
      height: 1080,
      fps: 60,
      borderRadius: 0,
      background: "#000000",
      padding: 0,
      shadow: false,
      cursorSettings: defaultCursorSettings,
    },
    tracks,
    markers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

describe("Track Reordering Commands", () => {
  it("moves a track to a new index correctly", () => {
    const state = createTestState()
    expect(state.tracks.map((t) => t.id)).toEqual(["track-screen", "track-camera", "track-mic"])

    // Move microphone (index 2) to the top (index 0)
    const command = createMoveTrackCommand("track-mic", 0)
    const result = applyCommand(state, command)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tracks.map((t) => t.id)).toEqual([
        "track-mic",
        "track-screen",
        "track-camera",
      ])
    }
  })

  it("handles moving track down to the end", () => {
    const state = createTestState()
    // Move screen (index 0) to end (index 2)
    const command = createMoveTrackCommand("track-screen", 2)
    const result = applyCommand(state, command)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tracks.map((t) => t.id)).toEqual([
        "track-camera",
        "track-mic",
        "track-screen",
      ])
    }
  })

  it("reorders tracks matching an array of track IDs", () => {
    const state = createTestState()
    const command = createReorderTracksCommand(["track-camera", "track-screen", "track-mic"])
    const result = applyCommand(state, command)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tracks.map((t) => t.id)).toEqual([
        "track-camera",
        "track-screen",
        "track-mic",
      ])
    }
  })

  it("fails when moving a non-existent track", () => {
    const state = createTestState()
    const command = createMoveTrackCommand("non-existent", 1)
    const result = applyCommand(state, command)
    expect(result.ok).toBe(false)
  })
})

describe("Audio Volume Keyframes Command", () => {
  it("updates audio clip with custom volume keyframes", () => {
    const state = createTestState()
    const keyframes = [
      { id: "kf-1", timeMs: 1000, volume: 1.5 },
      { id: "kf-2", timeMs: 4000, volume: 0.3 },
    ]
    const command = createUpdateClipAudioCommand("audio-clip-1", {
      volume: 1.2,
      fadeInMs: 800,
      fadeOutMs: 1200,
      volumeKeyframes: keyframes,
    })

    const result = applyCommand(state, command)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const audioTrack = result.value.tracks.find((t) => t.id === "track-mic")
      const clip = audioTrack?.clips[0] as AudioClip
      expect(clip.volume).toBe(1.2)
      expect(clip.fadeInMs).toBe(800)
      expect(clip.fadeOutMs).toBe(1200)
      expect(clip.volumeKeyframes).toEqual(keyframes)
    }
  })
})
