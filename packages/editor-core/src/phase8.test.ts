import { describe, expect, it } from "vitest"
import { defaultCursorSettings, type TimelineState } from "@recordforge/domain"
import {
  createAddCursorRangeCommand,
  createEngine,
  createUpdateCursorRangeCommand,
  executeCommand,
  undoCommand,
} from "./index"

function makeState(): TimelineState {
  const now = "2026-08-11T00:00:00.000Z"
  return {
    version: 1,
    id: "phase8-project",
    name: "Phase 8",
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
    ],
    markers: [],
    zoomSegments: [],
    createdAt: now,
    updatedAt: now,
  }
}

function findCursorRange(state: TimelineState) {
  const track = state.tracks.find((t) => t.kind === "cursor")
  return track?.clips.find((clip) => clip.kind === "cursor-effect")
}

describe("Phase 8 cursor/zoom workflow polish", () => {
  it("adds a cursor range that inherits the project profile", () => {
    const engine = createEngine(makeState())
    const added = executeCommand(
      engine,
      createAddCursorRangeCommand("cursor-events:recording", 1_000, 3_000),
    )
    expect(added.ok).toBe(true)
    if (!added.ok) return

    const range = findCursorRange(added.value.history.present)
    expect(range).toBeDefined()
    expect(range?.presetId).toBe(defaultCursorSettings.preset)
    expect(range?.scale).toBe(defaultCursorSettings.scale)
    expect(Object.keys(range?.settings ?? {})).toHaveLength(0)
  })

  it("merges partial cursor range settings by default", () => {
    const engine = createEngine(makeState())
    const added = executeCommand(
      engine,
      createAddCursorRangeCommand("cursor-events:recording", 1_000, 3_000, {
        settings: { fillColor: "#ff0000" },
      }),
    )
    expect(added.ok).toBe(true)
    if (!added.ok) return

    const merged = executeCommand(
      added.value,
      createUpdateCursorRangeCommand(
        added.value.history.present.tracks.find((t) => t.kind === "cursor")?.clips[0]?.id ?? "",
        { settings: { strokeColor: "#00ff00" } },
      ),
    )
    expect(merged.ok).toBe(true)
    if (!merged.ok) return

    const range = findCursorRange(merged.value.history.present)
    expect(range?.settings).toMatchObject({ fillColor: "#ff0000", strokeColor: "#00ff00" })
  })

  it("replaces cursor range settings when replaceSettings is true", () => {
    const engine = createEngine(makeState())
    const added = executeCommand(
      engine,
      createAddCursorRangeCommand("cursor-events:recording", 1_000, 3_000, {
        presetId: "sleek-dark",
        scale: 1.5,
        smoothing: "off",
        settings: { fillColor: "#ff0000", strokeColor: "#00ff00" },
      }),
    )
    expect(added.ok).toBe(true)
    if (!added.ok) return

    const rangeId =
      added.value.history.present.tracks.find((t) => t.kind === "cursor")?.clips[0]?.id ?? ""
    const reset = executeCommand(
      added.value,
      createUpdateCursorRangeCommand(rangeId, {
        presetId: defaultCursorSettings.preset,
        scale: defaultCursorSettings.scale,
        smoothing: defaultCursorSettings.smoothMovement ? "smooth" : "off",
        settings: {},
        replaceSettings: true,
      }),
    )
    expect(reset.ok).toBe(true)
    if (!reset.ok) return

    const range = findCursorRange(reset.value.history.present)
    expect(range?.presetId).toBe(defaultCursorSettings.preset)
    expect(range?.scale).toBe(defaultCursorSettings.scale)
    expect(Object.keys(range?.settings ?? {})).toHaveLength(0)

    const undone = undoCommand(reset.value)
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    const previous = findCursorRange(undone.value.history.present)
    expect(previous?.settings).toMatchObject({ fillColor: "#ff0000", strokeColor: "#00ff00" })
  })

  it("blocks non-unlock updates on locked cursor ranges", () => {
    const engine = createEngine(makeState())
    const added = executeCommand(
      engine,
      createAddCursorRangeCommand("cursor-events:recording", 1_000, 3_000),
    )
    expect(added.ok).toBe(true)
    if (!added.ok) return

    const rangeId =
      added.value.history.present.tracks.find((t) => t.kind === "cursor")?.clips[0]?.id ?? ""
    const locked = executeCommand(
      added.value,
      createUpdateCursorRangeCommand(rangeId, { locked: true }),
    )
    expect(locked.ok).toBe(true)
    if (!locked.ok) return

    const update = executeCommand(
      locked.value,
      createUpdateCursorRangeCommand(rangeId, { scale: 2 }),
    )
    expect(update.ok).toBe(false)
  })
})
