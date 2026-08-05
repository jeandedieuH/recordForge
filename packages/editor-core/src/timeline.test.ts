import { describe, expect, it } from "vitest"
import { defaultCursorSettings, type TimelineState } from "@recordforge/domain"
import {
  createDeleteClipCommand,
  createEngine,
  createMoveClipCommand,
  createRippleDeleteClipCommand,
  createSplitClipCommand,
  createTrimClipCommand,
  createUpdateClipAudioCommand,
  createUpdateTrackCommand,
  executeCommand,
  redoCommand,
  undoCommand,
} from "./index"

function makeTestState(): TimelineState {
  return {
    version: 1,
    id: "project-1",
    name: "Test project",
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

function findClip(state: TimelineState, clipId: string) {
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      if (clip.id === clipId) return clip
    }
  }
  return undefined
}

describe("timeline command engine", () => {
  it("splits a clip into two adjacent clips", () => {
    const engine = createEngine(makeTestState())
    const result = executeCommand(engine, createSplitClipCommand("clip-1", 20_000))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const track = result.value.history.present.tracks[0]
    expect(track.clips).toHaveLength(2)

    const left = track.clips[0]
    const right = track.clips[1]
    expect(left.startMs).toBe(0)
    expect(left.durationMs).toBe(20_000)
    expect(left.sourceInMs).toBe(0)
    expect(left.sourceOutMs).toBe(20_000)

    expect(right.startMs).toBe(20_000)
    expect(right.durationMs).toBe(40_000)
    expect(right.sourceInMs).toBe(20_000)
    expect(right.sourceOutMs).toBe(60_000)
  })

  it("trims a clip source range", () => {
    const engine = createEngine(makeTestState())
    const result = executeCommand(engine, createTrimClipCommand("clip-1", 5_000, 55_000))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const clip = findClip(result.value.history.present, "clip-1")
    expect(clip).toBeDefined()
    expect(clip?.sourceInMs).toBe(5_000)
    expect(clip?.sourceOutMs).toBe(55_000)
    expect(clip?.durationMs).toBe(50_000)
    expect(clip?.startMs).toBe(0)
  })

  it("moves a clip and prevents overlaps", () => {
    const engine = createEngine(makeTestState())
    const split = executeCommand(engine, createSplitClipCommand("clip-1", 30_000))
    expect(split.ok).toBe(true)
    if (!split.ok) return

    const right = split.value.history.present.tracks[0].clips[1]
    const move = executeCommand(split.value, createMoveClipCommand(right.id, 25_000))
    expect(move.ok).toBe(false)
  })

  it("deletes a clip", () => {
    const engine = createEngine(makeTestState())
    const result = executeCommand(engine, createDeleteClipCommand("clip-1"))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.history.present.tracks[0].clips).toHaveLength(0)
  })

  it("ripple deletes a clip and shifts later clips", () => {
    const engine = createEngine(makeTestState())
    const split = executeCommand(engine, createSplitClipCommand("clip-1", 20_000))
    expect(split.ok).toBe(true)
    if (!split.ok) return

    const left = split.value.history.present.tracks[0].clips[0]
    const ripple = executeCommand(split.value, createRippleDeleteClipCommand(left.id))
    expect(ripple.ok).toBe(true)
    if (!ripple.ok) return

    const remaining = ripple.value.history.present.tracks[0].clips
    expect(remaining).toHaveLength(1)
    expect(remaining[0].startMs).toBe(0)
    expect(remaining[0].sourceInMs).toBe(20_000)
    expect(remaining[0].sourceOutMs).toBe(60_000)
  })

  it("ripple deletes the same time range from aligned audio tracks", () => {
    const state = makeTestState()
    state.tracks.push({
      id: "audio-track",
      kind: "audio",
      name: "System Audio",
      muted: false,
      locked: false,
      solo: false,
      volume: 1,
      clips: [
        {
          id: "audio-clip",
          kind: "audio",
          assetId: "rec-1",
          streamIndex: 2,
          startMs: 0,
          durationMs: 60_000,
          sourceInMs: 0,
          sourceOutMs: 60_000,
          speed: 1,
          volume: 1,
          fadeInMs: 0,
          fadeOutMs: 0,
        },
      ],
    })

    const engine = createEngine(state)
    const split = executeCommand(engine, createSplitClipCommand("clip-1", 20_000))
    expect(split.ok).toBe(true)
    if (!split.ok) return

    const ripple = executeCommand(
      split.value,
      createRippleDeleteClipCommand(split.value.history.present.tracks[0].clips[0].id),
    )
    expect(ripple.ok).toBe(true)
    if (!ripple.ok) return

    const audioClips = ripple.value.history.present.tracks[1].clips
    expect(audioClips).toHaveLength(1)
    expect(audioClips[0]).toMatchObject({
      startMs: 0,
      durationMs: 40_000,
      sourceInMs: 20_000,
      sourceOutMs: 60_000,
    })
  })

  it("undoes and redoes commands", () => {
    const engine = createEngine(makeTestState())
    const trimmed = executeCommand(engine, createTrimClipCommand("clip-1", 10_000, 50_000))
    expect(trimmed.ok).toBe(true)
    if (!trimmed.ok) return

    const undo = undoCommand(trimmed.value)
    expect(undo.ok).toBe(true)
    if (!undo.ok) return
    expect(undo.value.history.present.tracks[0].clips[0].sourceInMs).toBe(0)

    const redo = redoCommand(undo.value)
    expect(redo.ok).toBe(true)
    if (!redo.ok) return
    expect(redo.value.history.present.tracks[0].clips[0].sourceInMs).toBe(10_000)
  })

  it("updates track controls", () => {
    const engine = createEngine(makeTestState())
    const result = executeCommand(
      engine,
      createUpdateTrackCommand("track-1", { muted: true, volume: 0.5 }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.history.present.tracks[0].muted).toBe(true)
    expect(result.value.history.present.tracks[0].volume).toBe(0.5)
  })

  it("updates an individual audio clip without changing its timing", () => {
    const state = makeTestState()
    state.tracks.push({
      id: "audio-track",
      kind: "audio",
      name: "Microphone",
      muted: false,
      locked: false,
      solo: false,
      volume: 1,
      clips: [
        {
          id: "audio-clip",
          kind: "audio",
          assetId: "rec-1",
          streamIndex: 1,
          startMs: 0,
          durationMs: 60_000,
          sourceInMs: 0,
          sourceOutMs: 60_000,
          speed: 1,
          volume: 1,
          fadeInMs: 0,
          fadeOutMs: 0,
        },
      ],
    })

    const engine = createEngine(state)
    const result = executeCommand(
      engine,
      createUpdateClipAudioCommand("audio-clip", { volume: 0.4 }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const clip = result.value.history.present.tracks[1].clips[0]
    expect(clip).toMatchObject({ volume: 0.4, startMs: 0, durationMs: 60_000 })
  })
})
