import { describe, expect, it } from "vitest"
import { defaultCursorSettings, type TimelineState } from "@recordforge/domain"
import {
  createDeleteClipCommand,
  createEngine,
  createMoveClipCommand,
  createRippleDeleteClipCommand,
  createSplitClipCommand,
  createTrimClipCommand,
  createUpdateTrackCommand,
  executeCommand,
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
      {
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
      },
    ],
    markers: [
      { id: "marker-1", timeMs: 5_000, label: "Start", color: "#f59e0b" },
      { id: "marker-2", timeMs: 25_000, label: "Middle", color: "#f59e0b" },
      { id: "marker-3", timeMs: 45_000, label: "End", color: "#f59e0b" },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

describe("track lock semantics", () => {
  it("rejects trimming a clip on a locked track", () => {
    const state = makeTestState()
    state.tracks[0].locked = true
    const engine = createEngine(state)
    const result = executeCommand(engine, createTrimClipCommand("clip-1", 10_000, 50_000))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("track_locked")
  })

  it("rejects splitting a clip on a locked track", () => {
    const state = makeTestState()
    state.tracks[0].locked = true
    const engine = createEngine(state)
    const result = executeCommand(engine, createSplitClipCommand("clip-1", 20_000))
    expect(result.ok).toBe(false)
  })

  it("rejects deleting a clip on a locked track", () => {
    const state = makeTestState()
    state.tracks[0].locked = true
    const engine = createEngine(state)
    const result = executeCommand(engine, createDeleteClipCommand("clip-1"))
    expect(result.ok).toBe(false)
  })

  it("rejects ripple-deleting a clip on a locked track", () => {
    const state = makeTestState()
    state.tracks[0].locked = true
    const engine = createEngine(state)
    const result = executeCommand(engine, createRippleDeleteClipCommand("clip-1"))
    expect(result.ok).toBe(false)
  })

  it("rejects moving a clip onto a locked track", () => {
    const state = makeTestState()
    state.tracks[0].clips = [
      {
        ...state.tracks[0].clips[0],
        id: "clip-a",
        startMs: 0,
        durationMs: 10_000,
        sourceInMs: 0,
        sourceOutMs: 10_000,
      },
      {
        ...state.tracks[0].clips[0],
        id: "clip-b",
        startMs: 10_000,
        durationMs: 10_000,
        sourceInMs: 10_000,
        sourceOutMs: 20_000,
      },
    ]
    state.tracks[1].locked = true
    const engine = createEngine(state)
    const result = executeCommand(
      engine,
      createMoveClipCommand("clip-a", 100_000, state.tracks[1].id),
    )
    expect(result.ok).toBe(false)
  })

  it("allows unlocking a locked track", () => {
    const state = makeTestState()
    state.tracks[0].locked = true
    const engine = createEngine(state)
    const result = executeCommand(engine, createUpdateTrackCommand("track-1", { locked: false }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.history.present.tracks[0].locked).toBe(false)
  })

  it("rejects other track updates while locked", () => {
    const state = makeTestState()
    state.tracks[0].locked = true
    const engine = createEngine(state)
    const result = executeCommand(engine, createUpdateTrackCommand("track-1", { volume: 0.5 }))
    expect(result.ok).toBe(false)
  })
})

describe("marker behavior under edits", () => {
  it("shifts markers after a ripple-deleted range", () => {
    const state = makeTestState()
    const engine = createEngine(state)
    const result = executeCommand(engine, createRippleDeleteClipCommand("clip-1"))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const markers = result.value.history.present.markers
    const byId = (id: string) => markers.find((m) => m.id === id)

    // Marker in the deleted range (0-60s) is removed.
    expect(byId("marker-1")).toBeUndefined()
    expect(byId("marker-2")).toBeUndefined()
    expect(byId("marker-3")).toBeUndefined()

    // All top-level markers after the deleted range shift back by the deleted duration.
    expect(markers).toHaveLength(0)
  })

  it("shifts later markers after a partial ripple delete", () => {
    const state = makeTestState()
    const engine = createEngine(state)
    const split = executeCommand(engine, createSplitClipCommand("clip-1", 30_000))
    expect(split.ok).toBe(true)
    if (!split.ok) return

    const left = split.value.history.present.tracks[0].clips[0]
    const ripple = executeCommand(split.value, createRippleDeleteClipCommand(left.id))
    expect(ripple.ok).toBe(true)
    if (!ripple.ok) return

    const markers = ripple.value.history.present.markers
    const byId = (id: string) => markers.find((m) => m.id === id)

    // 30-second range deleted; markers at 5 and 25 are removed, 45 shifts to 15.
    expect(byId("marker-1")).toBeUndefined()
    expect(byId("marker-2")).toBeUndefined()
    expect(byId("marker-3")?.timeMs).toBe(15_000)
  })

  it("keeps markers in place after a simple delete", () => {
    const state = makeTestState()
    const engine = createEngine(state)
    const result = executeCommand(engine, createDeleteClipCommand("clip-1"))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const markers = result.value.history.present.markers
    expect(markers[0].timeMs).toBe(5_000)
    expect(markers[1].timeMs).toBe(25_000)
    expect(markers[2].timeMs).toBe(45_000)
  })
})

describe("ripple delete with locked tracks", () => {
  it("skips locked tracks but still ripples from the source track", () => {
    const state = makeTestState()
    const engine = createEngine(state)

    const splitScreen = executeCommand(engine, createSplitClipCommand("clip-1", 30_000))
    expect(splitScreen.ok).toBe(true)
    if (!splitScreen.ok) return

    const splitAudio = executeCommand(
      splitScreen.value,
      createSplitClipCommand("audio-clip", 30_000),
    )
    expect(splitAudio.ok).toBe(true)
    if (!splitAudio.ok) return

    // Lock the audio track before the ripple so it should not shift.
    const lockedAudio = executeCommand(
      splitAudio.value,
      createUpdateTrackCommand("audio-track", { locked: true }),
    )
    expect(lockedAudio.ok).toBe(true)
    if (!lockedAudio.ok) return

    const left = lockedAudio.value.history.present.tracks[0].clips[0]
    const ripple = executeCommand(lockedAudio.value, createRippleDeleteClipCommand(left.id))
    expect(ripple.ok).toBe(true)
    if (!ripple.ok) return

    // Screen track shifted because it was not locked.
    expect(ripple.value.history.present.tracks[0].clips).toHaveLength(1)
    expect(ripple.value.history.present.tracks[0].clips[0].startMs).toBe(0)

    // Audio track is locked, so it keeps both clips from the split.
    expect(ripple.value.history.present.tracks[1].clips).toHaveLength(2)
  })
})
