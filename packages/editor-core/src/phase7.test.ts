import { describe, expect, it } from "vitest"
import { defaultCursorSettings, timelineStateSchema, type TimelineState } from "@recordforge/domain"
import {
  createAddMaskClipCommand,
  createEngine,
  createImportCaptionCuesCommand,
  createSplitClipCommand,
  createUpdateCaptionClipCommand,
  createUpdateMaskClipCommand,
  executeCommand,
  undoCommand,
} from "./index"

function makeState(): TimelineState {
  const now = "2026-08-10T00:00:00.000Z"
  return {
    version: 1,
    id: "phase7-project",
    name: "Phase 7",
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

describe("Phase 7 caption and privacy editing", () => {
  it("imports captions into one editable track and undoes the import as one command", () => {
    const imported = executeCommand(
      createEngine(makeState()),
      createImportCaptionCuesCommand([
        { id: "one", startMs: 500, endMs: 1_500, text: "First" },
        { id: "two", startMs: 2_000, endMs: 3_250, text: "Second" },
      ]),
    )
    expect(imported.ok).toBe(true)
    if (!imported.ok) return

    const captions = imported.value.history.present.tracks.find(
      (track) => track.kind === "captions",
    )
    expect(captions?.clips).toMatchObject([
      { kind: "caption", startMs: 500, durationMs: 1_000, text: "First" },
      { kind: "caption", startMs: 2_000, durationMs: 1_250, text: "Second" },
    ])

    const undone = undoCommand(imported.value)
    expect(undone.ok).toBe(true)
    if (undone.ok) expect(undone.value.history.present.tracks).toHaveLength(1)
  })

  it("splits imported caption timing without changing cue text", () => {
    const imported = executeCommand(
      createEngine(makeState()),
      createImportCaptionCuesCommand([{ id: "one", startMs: 500, endMs: 1_500, text: "First" }]),
    )
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    const clip = imported.value.history.present.tracks.find((track) => track.kind === "captions")
      ?.clips[0]
    if (!clip) return

    const split = executeCommand(imported.value, createSplitClipCommand(clip.id, 1_000))
    expect(split.ok).toBe(true)
    if (split.ok) {
      expect(split.value.history.present.tracks[1].clips).toMatchObject([
        { text: "First", startMs: 500, durationMs: 500 },
        { text: "First", startMs: 1_000, durationMs: 500 },
      ])
    }
  })

  it("updates caption text and placement while preserving normalized timing", () => {
    const imported = executeCommand(
      createEngine(makeState()),
      createImportCaptionCuesCommand([{ id: "one", startMs: 500, endMs: 1_500, text: "First" }]),
    )
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    const clip = imported.value.history.present.tracks.find((track) => track.kind === "captions")
      ?.clips[0]
    if (!clip) return

    const updated = executeCommand(
      imported.value,
      createUpdateCaptionClipCommand(clip.id, { text: "Updated", placement: "top" }),
    )
    expect(updated.ok).toBe(true)
    if (updated.ok)
      expect(updated.value.history.present.tracks[1].clips[0]).toMatchObject({
        text: "Updated",
        placement: "top",
        startMs: 500,
        durationMs: 1_000,
      })
  })

  it("allows overlapping static masks and clamps their rectangle to the canvas", () => {
    const first = executeCommand(
      createEngine(makeState()),
      createAddMaskClipCommand(
        "recording",
        0,
        4_000,
        "blur",
        { x: 1_800, y: 1_000, width: 500, height: 300 },
        { clipId: "mask-1" },
      ),
    )
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const second = executeCommand(
      first.value,
      createAddMaskClipCommand(
        "recording",
        1_000,
        5_000,
        "pixelate",
        { x: 0, y: 0, width: 640, height: 360 },
        { clipId: "mask-2" },
      ),
    )
    expect(second.ok).toBe(true)
    if (!second.ok) return
    const effects = second.value.history.present.tracks.find((track) => track.kind === "effects")
    expect(effects?.clips).toHaveLength(2)
    expect(effects?.clips[0]).toMatchObject({ rect: { x: 1420, y: 780, width: 500, height: 300 } })

    const moved = executeCommand(
      second.value,
      createUpdateMaskClipCommand("mask-1", { rect: { x: 120, y: 80 } }),
    )
    expect(moved.ok).toBe(true)
    if (moved.ok)
      expect(moved.value.history.present.tracks[1].clips[0]).toMatchObject({
        rect: { x: 120, y: 80 },
      })
  })

  it("rounds fractional mask times to integers so the timeline state stays valid", () => {
    const result = executeCommand(
      createEngine(makeState()),
      createAddMaskClipCommand(
        "recording",
        1000.7,
        3000.3,
        "blur",
        { x: 100, y: 100, width: 200, height: 150 },
        { clipId: "mask-float" },
      ),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // The state must parse against the contract schema without float rejections.
    expect(() => timelineStateSchema.parse(result.value.history.present)).not.toThrow()

    const effects = result.value.history.present.tracks.find((track) => track.kind === "effects")
    expect(effects?.clips[0]).toMatchObject({
      id: "mask-float",
      startMs: 1001,
      durationMs: 1999,
      sourceOutMs: 1999,
    })
  })
})
