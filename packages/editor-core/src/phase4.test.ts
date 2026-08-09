import { describe, expect, it } from "vitest"
import { defaultCursorSettings, type TimelineState } from "@recordforge/domain"
import {
  buildSnapTargets,
  createDeleteClipsCommand,
  createDeleteRangeCommand,
  createEngine,
  createMoveClipCommand,
  createMoveClipsCommand,
  createRippleDeleteRangeCommand,
  createTrimClipCommand,
  createUpdateMarkerCommand,
  executeCommand,
  validateCommandRecord,
  snapClipStart,
  snapTime,
} from "./index"

function makeState(): TimelineState {
  const now = new Date().toISOString()
  return {
    version: 1,
    id: "project-1",
    name: "Phase 4 fixture",
    recordingId: "recording-1",
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
            id: "screen-a",
            kind: "screen",
            assetId: "recording-1",
            startMs: 0,
            durationMs: 10_000,
            sourceInMs: 0,
            sourceOutMs: 10_000,
            speed: 1,
          },
          {
            id: "screen-b",
            kind: "screen",
            assetId: "recording-1",
            startMs: 15_000,
            durationMs: 5_000,
            sourceInMs: 10_000,
            sourceOutMs: 15_000,
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
            id: "audio-a",
            kind: "audio",
            assetId: "recording-1",
            streamIndex: 1,
            startMs: 0,
            durationMs: 20_000,
            sourceInMs: 0,
            sourceOutMs: 20_000,
            speed: 1,
            volume: 1,
            fadeInMs: 0,
            fadeOutMs: 0,
          },
        ],
      },
      {
        id: "captions",
        kind: "captions",
        name: "Captions",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "caption-a",
            kind: "caption",
            assetId: "captions",
            startMs: 8_000,
            durationMs: 2_000,
            sourceInMs: 8_000,
            sourceOutMs: 10_000,
            speed: 1,
            text: "Hello",
            style: "default",
          },
        ],
      },
      {
        id: "locked",
        kind: "screen",
        name: "Locked screen",
        muted: false,
        locked: true,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "locked-a",
            kind: "screen",
            assetId: "recording-1",
            startMs: 0,
            durationMs: 20_000,
            sourceInMs: 0,
            sourceOutMs: 20_000,
            speed: 1,
          },
        ],
      },
    ],
    markers: [
      { id: "marker-inside", timeMs: 5_000, label: "Inside", color: "#f59e0b" },
      { id: "marker-later", timeMs: 12_000, label: "Later", color: "#f59e0b" },
    ],
    createdAt: now,
    updatedAt: now,
  }
}

function clipAt(state: TimelineState, trackId: string, clipId: string) {
  return state.tracks
    .find((track) => track.id === trackId)
    ?.clips.find((clip) => clip.id === clipId)
}

describe("Phase 4 editing commands", () => {
  it("trims each edge while preserving the opposite timeline edge", () => {
    const leftTrim = executeCommand(
      createEngine(makeState()),
      createTrimClipCommand("screen-a", 2_000, 10_000, { startMs: 2_000 }),
    )
    expect(leftTrim.ok).toBe(true)
    if (!leftTrim.ok) return
    expect(clipAt(leftTrim.value.history.present, "screen", "screen-a")).toMatchObject({
      startMs: 2_000,
      durationMs: 8_000,
      sourceInMs: 2_000,
      sourceOutMs: 10_000,
    })

    const rightTrim = executeCommand(
      createEngine(makeState()),
      createTrimClipCommand("screen-a", 0, 7_000),
    )
    expect(rightTrim.ok).toBe(true)
    if (!rightTrim.ok) return
    expect(clipAt(rightTrim.value.history.present, "screen", "screen-a")).toMatchObject({
      startMs: 0,
      durationMs: 7_000,
      sourceInMs: 0,
      sourceOutMs: 7_000,
    })
  })

  it("rejects a move that would collide on any track", () => {
    const result = executeCommand(
      createEngine(makeState()),
      createMoveClipCommand("screen-b", 5_000),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("clip_overlap")
  })

  it("deletes a range without shifting the remaining timeline", () => {
    const result = executeCommand(createEngine(makeState()), createDeleteRangeCommand(4_000, 6_000))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const screen = result.value.history.present.tracks[0]
    expect(screen.clips).toMatchObject([
      { id: "screen-a", startMs: 0, durationMs: 4_000, sourceOutMs: 4_000 },
      { startMs: 6_000, durationMs: 4_000, sourceInMs: 6_000, sourceOutMs: 10_000 },
      { id: "screen-b", startMs: 15_000, durationMs: 5_000 },
    ])
    expect(result.value.history.present.markers.map((marker) => marker.id)).toEqual([
      "marker-later",
    ])
  })

  it("ripple-deletes a range across unlocked tracks and preserves locked tracks", () => {
    const result = executeCommand(
      createEngine(makeState()),
      createRippleDeleteRangeCommand(5_000, 10_000),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const state = result.value.history.present
    expect(state.tracks[0].clips).toMatchObject([
      { id: "screen-a", startMs: 0, durationMs: 5_000 },
      { id: "screen-b", startMs: 10_000, durationMs: 5_000, sourceInMs: 10_000 },
    ])
    expect(state.tracks[1].clips).toMatchObject([
      { startMs: 0, durationMs: 5_000, sourceInMs: 0, sourceOutMs: 5_000 },
      { startMs: 5_000, durationMs: 10_000, sourceInMs: 10_000, sourceOutMs: 20_000 },
    ])
    expect(state.tracks[3].clips[0]).toMatchObject({ startMs: 0, durationMs: 20_000 })
    expect(state.markers).toEqual([
      { id: "marker-later", timeMs: 7_000, label: "Later", color: "#f59e0b" },
    ])
  })

  it("moves multiple selected clips by one deterministic delta", () => {
    const result = executeCommand(
      createEngine(makeState()),
      createMoveClipsCommand(["screen-a", "screen-b"], 2_000),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.history.present.tracks[0].clips).toMatchObject([
      { id: "screen-a", startMs: 2_000 },
      { id: "screen-b", startMs: 17_000 },
    ])
  })

  it("deletes multiple selected clips as one command", () => {
    const result = executeCommand(
      createEngine(makeState()),
      createDeleteClipsCommand(["screen-a", "caption-a"]),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(clipAt(result.value.history.present, "screen", "screen-a")).toBeUndefined()
    expect(clipAt(result.value.history.present, "captions", "caption-a")).toBeUndefined()
  })

  it("round-trips serialized edit commands", () => {
    const commands = [
      createTrimClipCommand("screen-a", 1_000, 9_000, { startMs: 1_000 }),
      createDeleteRangeCommand(2_000, 3_000),
      createRippleDeleteRangeCommand(4_000, 5_000),
    ]
    expect(
      commands.map((command) => validateCommandRecord(JSON.parse(JSON.stringify(command)))),
    ).toEqual(commands)
  })

  it("updates marker metadata and keeps marker ordering deterministic", () => {
    const result = executeCommand(
      createEngine(makeState()),
      createUpdateMarkerCommand("marker-inside", { label: "Updated", timeMs: 14_000 }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.history.present.markers).toEqual([
      { id: "marker-later", timeMs: 12_000, label: "Later", color: "#f59e0b" },
      { id: "marker-inside", timeMs: 14_000, label: "Updated", color: "#f59e0b" },
    ])
  })
})

describe("Phase 4 snapping", () => {
  it("collects clip edges, markers, captions, playhead, and cursor clicks", () => {
    const targets = buildSnapTargets(makeState(), {
      playheadMs: 1_000,
      cursorClickTimesMs: [2_000],
    })
    expect(targets.some((target) => target.kind === "clip-edge")).toBe(true)
    expect(targets.some((target) => target.kind === "marker")).toBe(true)
    expect(targets.some((target) => target.kind === "caption-boundary")).toBe(true)
    expect(targets.some((target) => target.kind === "playhead")).toBe(true)
    expect(targets.some((target) => target.kind === "cursor-click")).toBe(true)
  })

  it("respects the threshold, disabled state, and deterministic priority", () => {
    const targets = buildSnapTargets(makeState(), { playheadMs: 1_000 })
    const snapped = snapTime(1_008, targets, { thresholdMs: 20 })
    expect(snapped.snapped).toBe(true)
    expect(snapped.target?.kind).toBe("playhead")

    expect(snapTime(1_008, targets, { enabled: false, thresholdMs: 20 }).snapped).toBe(false)
    expect(snapTime(1_050, targets, { thresholdMs: 20 }).snapped).toBe(false)
  })

  it("snaps either edge of a moving clip without moving it beyond zero", () => {
    const targets = buildSnapTargets(makeState(), { playheadMs: 12_000 })
    const result = snapClipStart(10_080, 1_960, targets, { thresholdMs: 100 })
    expect(result.snapped).toBe(true)
    expect(result.timeMs).toBe(10_040)
    expect(result.edge).toBe("end")
  })
})
