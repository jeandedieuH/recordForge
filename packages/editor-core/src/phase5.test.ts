import { describe, expect, it } from "vitest"
import { defaultCursorSettings, type TimelineState } from "@recordforge/domain"
import {
  createDeleteCursorRangeCommand,
  createEngine,
  createResizeCursorRangeCommand,
  createSplitCursorRangeCommand,
  createUpdateCursorRangeCommand,
  executeCommand,
} from "./index"

function makeState(): TimelineState {
  const now = "2026-01-01T00:00:00Z"
  return {
    version: 1,
    id: "project",
    name: "Phase 5",
    recordingId: "recording",
    canvas: {
      width: 1024,
      height: 768,
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
            id: "screen-clip",
            kind: "screen",
            assetId: "recording",
            startMs: 0,
            durationMs: 10_000,
            sourceInMs: 0,
            sourceOutMs: 10_000,
            speed: 1,
          },
        ],
      },
      {
        id: "cursor",
        kind: "cursor",
        name: "Cursor",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "cursor-range",
            kind: "cursor-effect",
            assetId: "cursor-events:recording",
            startMs: 0,
            durationMs: 10_000,
            sourceInMs: 0,
            sourceOutMs: 0,
            speed: 1,
            presetId: "modern-neon",
            scale: 1,
            smoothing: "smooth",
            settings: {},
            enabled: true,
            locked: false,
          },
        ],
      },
    ],
    markers: [],
    createdAt: now,
    updatedAt: now,
  }
}

function cursorRanges(state: TimelineState) {
  return state.tracks.find((track) => track.kind === "cursor")?.clips ?? []
}

describe("Phase 5 cursor range commands", () => {
  it("splits and resizes ranges without changing telemetry asset identity", () => {
    const split = executeCommand(
      createEngine(makeState()),
      createSplitCursorRangeCommand("cursor-range", 4_000),
    )
    expect(split.ok).toBe(true)
    if (!split.ok) return
    expect(cursorRanges(split.value.history.present)).toMatchObject([
      { startMs: 0, durationMs: 4_000, assetId: "cursor-events:recording" },
      { startMs: 4_000, durationMs: 6_000, assetId: "cursor-events:recording" },
    ])

    const rightId = cursorRanges(split.value.history.present)[1].id
    const resized = executeCommand(
      split.value,
      createResizeCursorRangeCommand(rightId, { endMs: 7_000 }),
    )
    expect(resized.ok).toBe(true)
    if (!resized.ok) return
    expect(cursorRanges(resized.value.history.present)[1]).toMatchObject({
      startMs: 4_000,
      durationMs: 3_000,
    })
  })

  it("keeps range settings independent and enforces range locks", () => {
    const updated = executeCommand(
      createEngine(makeState()),
      createUpdateCursorRangeCommand("cursor-range", {
        presetId: "cyberpunk",
        scale: 1.8,
        locked: true,
      }),
    )
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect(cursorRanges(updated.value.history.present)[0]).toMatchObject({
      presetId: "cyberpunk",
      scale: 1.8,
      locked: true,
    })

    const blocked = executeCommand(
      updated.value,
      createResizeCursorRangeCommand("cursor-range", { endMs: 8_000 }),
    )
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.error.code).toBe("cursor_range_locked")
  })

  it("deletes a range without deleting the registered telemetry asset", () => {
    const result = executeCommand(
      createEngine(makeState()),
      createDeleteCursorRangeCommand("cursor-range"),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(cursorRanges(result.value.history.present)).toHaveLength(0)
  })
})
