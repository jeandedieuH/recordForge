import { describe, expect, it } from "vitest"
import { defaultCursorSettings, type TimelineState } from "@recordforge/domain"
import {
  createDuplicateClipCommand,
  createDuplicateClipsCommand,
  createEngine,
  executeCommand,
} from "./index"

function makeState(): TimelineState {
  return {
    version: 1,
    id: "project-1",
    name: "Duplicate test",
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
        id: "screen",
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
            durationMs: 10_000,
            sourceInMs: 0,
            sourceOutMs: 10_000,
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

function makeMultiClipState(): TimelineState {
  return {
    ...makeState(),
    tracks: [
      {
        ...makeState().tracks[0],
        clips: [
          {
            id: "clip-1",
            kind: "screen",
            assetId: "rec-1",
            startMs: 0,
            durationMs: 10_000,
            sourceInMs: 0,
            sourceOutMs: 10_000,
            speed: 1,
          },
          {
            id: "clip-2",
            kind: "screen",
            assetId: "rec-1",
            startMs: 15_000,
            durationMs: 5_000,
            sourceInMs: 10_000,
            sourceOutMs: 15_000,
            speed: 1,
          },
        ],
      },
    ],
  }
}

describe("duplicate commands", () => {
  it("duplicates a clip one frame after the original", () => {
    const engine = createEngine(makeState())
    const result = executeCommand(engine, createDuplicateClipCommand("clip-1"))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const clips = result.value.history.present.tracks[0].clips
    expect(clips).toHaveLength(2)

    const original = clips[0]
    const duplicate = clips[1]
    expect(duplicate.startMs).toBe(10_033)
    expect(duplicate.durationMs).toBe(original.durationMs)
    expect(duplicate.sourceInMs).toBe(original.sourceInMs)
    expect(duplicate.sourceOutMs).toBe(original.sourceOutMs)
    expect(duplicate.assetId).toBe(original.assetId)
    expect(duplicate.id).not.toBe(original.id)
  })

  it("duplicates a clip at an explicit start time", () => {
    const engine = createEngine(makeState())
    const result = executeCommand(
      engine,
      createDuplicateClipCommand("clip-1", { newStartMs: 20_000 }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const clips = result.value.history.present.tracks[0].clips
    const duplicate = clips.find((clip) => clip.id !== "clip-1" && clip.id !== "clip-2")
    expect(duplicate?.startMs).toBe(20_000)
  })

  it("rejects a duplicate that would overlap another clip", () => {
    const engine = createEngine(makeMultiClipState())
    const result = executeCommand(
      engine,
      createDuplicateClipCommand("clip-1", { newStartMs: 12_000 }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("clip_overlap")
  })

  it("rejects duplicating a clip on a locked track", () => {
    const engine = createEngine(makeState())
    const state = engine.history.present
    state.tracks[0].locked = true
    const result = executeCommand(engine, createDuplicateClipCommand("clip-1"))
    expect(result.ok).toBe(false)
  })

  it("duplicates multiple clips as a group", () => {
    const engine = createEngine(makeMultiClipState())
    const result = executeCommand(engine, createDuplicateClipsCommand(["clip-1", "clip-2"]))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const clips = result.value.history.present.tracks[0].clips
    expect(clips).toHaveLength(4)

    const d1 = clips.find((clip) => clip.id.startsWith("clip-1:dup"))
    const d2 = clips.find((clip) => clip.id.startsWith("clip-2:dup"))
    expect(d1).toBeDefined()
    expect(d2).toBeDefined()
    expect(d1?.startMs).toBe(20_033)
    expect(d2?.startMs).toBe(35_033)
  })

  it("rejects an overlapping multi-clip duplicate", () => {
    const engine = createEngine(makeMultiClipState())
    const result = executeCommand(
      engine,
      createDuplicateClipsCommand(["clip-1", "clip-2"], { deltaMs: 100 }),
    )
    expect(result.ok).toBe(false)
  })
})
