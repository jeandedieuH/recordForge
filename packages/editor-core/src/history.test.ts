import { describe, expect, it } from "vitest"
import { defaultCursorSettings, type TimelineState } from "@recordforge/domain"
import { createTrimClipCommand, createUpdateClipAudioCommand } from "./commands"
import { apply, canRedo, canUndo, createHistory, getUndoName, redo, undo } from "./history"

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
      {
        id: "track-2",
        kind: "audio",
        name: "Microphone",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "audio-1",
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
    markers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

describe("history", () => {
  it("applies a command and can undo/redo", () => {
    const state = makeTestState()
    const history = createHistory(state)
    const command = createTrimClipCommand("clip-1", 10_000, 50_000)
    const next = { ...state, tracks: state.tracks, updatedAt: new Date().toISOString() }
    const afterApply = apply(history, next, command, { timestamp: 0 })

    expect(afterApply.past).toHaveLength(1)
    expect(afterApply.present).toBe(next)
    expect(canUndo(afterApply)).toBe(true)

    const afterUndo = undo(afterApply)
    expect(afterUndo.present).toBe(state)
    expect(canRedo(afterUndo)).toBe(true)

    const afterRedo = redo(afterUndo)
    expect(afterRedo.present).toBe(next)
    expect(canRedo(afterRedo)).toBe(false)
  })

  it("coalesces commands with the same key within the window", () => {
    const state = makeTestState()
    const history = createHistory(state)

    const first = createUpdateClipAudioCommand("audio-1", { volume: 0.5 })
    const second = createUpdateClipAudioCommand("audio-1", { volume: 0.4 })
    const third = createUpdateClipAudioCommand("audio-1", { volume: 0.3 })

    const next1 = { ...state, updatedAt: new Date().toISOString() }
    const h1 = apply(history, next1, first, { timestamp: 0 })
    expect(h1.past).toHaveLength(1)

    const next2 = { ...next1, updatedAt: new Date().toISOString() }
    const h2 = apply(h1, next2, second, { timestamp: 10 })
    expect(h2.past).toHaveLength(1)
    expect(h2.past[0].state).toBe(state)

    const next3 = { ...next2, updatedAt: new Date().toISOString() }
    const h3 = apply(h2, next3, third, { timestamp: 20 })
    expect(h3.past).toHaveLength(1)
    expect(h3.past[0].state).toBe(state)

    const undone = undo(h3)
    expect(undone.present).toBe(state)
  })

  it("does not coalesce commands outside the window", () => {
    const state = makeTestState()
    const history = createHistory(state)

    const first = createUpdateClipAudioCommand("audio-1", { volume: 0.5 })
    const second = createUpdateClipAudioCommand("audio-1", { volume: 0.4 })

    const next1 = { ...state, updatedAt: new Date().toISOString() }
    const h1 = apply(history, next1, first, { timestamp: 0 })

    const next2 = { ...next1, updatedAt: new Date().toISOString() }
    const h2 = apply(h1, next2, second, { timestamp: 500, coalesceWindowMs: 250 })

    expect(h2.past).toHaveLength(2)
  })

  it("caps the past at the configured limit", () => {
    const state = makeTestState()
    let history = createHistory(state)

    for (let i = 0; i < 10; i++) {
      const command = createTrimClipCommand("clip-1", i * 1_000, 60_000)
      const next = { ...state, updatedAt: new Date().toISOString() }
      history = apply(history, next, command, { timestamp: i, cap: 5, coalesceWindowMs: 0 })
    }

    expect(history.past.length).toBe(5)
    expect(history.past[0].timestamp).toBe(5)
  })

  it("reports the undo name", () => {
    const state = makeTestState()
    const command = createTrimClipCommand("clip-1", 10_000, 50_000)
    const history = apply(
      createHistory(state),
      { ...state, updatedAt: new Date().toISOString() },
      command,
      { timestamp: 0 },
    )
    expect(getUndoName(history)).toBe("Trim clip")
  })
})
