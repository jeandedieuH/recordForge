import { describe, expect, it } from "vitest"
import { defaultCursorSettings, type TimelineState } from "@recordforge/domain"
import {
  clampZoomTarget,
  createAddZoomSegmentCommand,
  createEngine,
  createSplitZoomSegmentCommand,
  createUpdateCanvasCommand,
  createUpdateClipAudioCommand,
  createUpdateZoomSegmentCommand,
  executeCommand,
  resolveZoomTransform,
  undoCommand,
} from "./index"

function makeState(): TimelineState {
  const now = "2026-08-09T00:00:00.000Z"
  return {
    version: 1,
    id: "phase6-project",
    name: "Phase 6",
    recordingId: "recording",
    canvas: {
      width: 1920,
      height: 1080,
      fps: 30,
      background: "#000000",
      padding: 48,
      borderRadius: 24,
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
        id: "audio",
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
            assetId: "recording",
            streamIndex: 1,
            role: "microphone",
            startMs: 0,
            durationMs: 10_000,
            sourceInMs: 0,
            sourceOutMs: 10_000,
            speed: 1,
            volume: 1,
            fadeInMs: 0,
            fadeOutMs: 0,
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

describe("Phase 6 composition and editing", () => {
  it("clamps zoom targets to the video canvas safe area", () => {
    expect(
      clampZoomTarget({ x: -100, y: -50, width: 4_000, height: 2_000 }, makeState().canvas),
    ).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
  })

  it("resolves an eased zoom transform from the full canvas to its target", () => {
    const state = makeState()
    const segment = {
      id: "zoom-1",
      startMs: 1_000,
      durationMs: 2_000,
      target: { x: 480, y: 270, width: 960, height: 540 },
      scale: 1,
      easing: "linear" as const,
      enabled: true,
      locked: false,
    }
    const start = resolveZoomTransform(segment, 1_000, state.canvas)
    const hold = resolveZoomTransform(segment, 2_000, state.canvas)
    const end = resolveZoomTransform(segment, 3_000, state.canvas)

    expect(start).toMatchObject({ progress: 0, scale: 1 })
    expect(hold.progress).toBe(1)
    expect(hold.crop).toEqual({ x: 480, y: 270, width: 960, height: 540 })
    expect(hold.scale).toBe(2)
    expect(end.progress).toBe(0)
    expect(end.scale).toBe(1)
  })

  it("supports add, split, lock, and undo for manual zoom ranges", () => {
    const added = executeCommand(
      createEngine(makeState()),
      createAddZoomSegmentCommand(
        1_000,
        5_000,
        {
          x: 400,
          y: 200,
          width: 1_000,
          height: 600,
        },
        { segmentId: "zoom-1" },
      ),
    )
    expect(added.ok).toBe(true)
    if (!added.ok) return

    const split = executeCommand(added.value, createSplitZoomSegmentCommand("zoom-1", 3_000))
    expect(split.ok).toBe(true)
    if (!split.ok) return
    expect(split.value.history.present.zoomSegments).toHaveLength(2)

    const leftId = split.value.history.present.zoomSegments?.[0].id ?? ""
    const locked = executeCommand(
      split.value,
      createUpdateZoomSegmentCommand(leftId, { locked: true }),
    )
    expect(locked.ok).toBe(true)
    if (!locked.ok) return
    const blocked = executeCommand(
      locked.value,
      createUpdateZoomSegmentCommand(leftId, { scale: 2 }),
    )
    expect(blocked.ok).toBe(false)

    const undone = undoCommand(locked.value)
    expect(undone.ok).toBe(true)
    if (undone.ok) expect(undone.value.history.present.zoomSegments?.[0].locked).toBe(false)
  })

  it("applies canvas aspect presets and rejects fades longer than an audio clip", () => {
    const canvas = executeCommand(
      createEngine(makeState()),
      createUpdateCanvasCommand({ aspectRatio: "1:1" }),
    )
    expect(canvas.ok).toBe(true)
    if (!canvas.ok) return
    expect(canvas.value.history.present.canvas).toMatchObject({ width: 1080, height: 1080 })

    const invalidFade = executeCommand(
      createEngine(makeState()),
      createUpdateClipAudioCommand("audio-clip", { fadeInMs: 8_000, fadeOutMs: 4_000 }),
    )
    expect(invalidFade.ok).toBe(false)
  })
})
