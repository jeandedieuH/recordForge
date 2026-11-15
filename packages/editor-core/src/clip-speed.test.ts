import { describe, expect, it } from "vitest"
import {
  captionClipSchema,
  timelineClipSchema,
  timelineStateSchema,
  type TimelineState,
} from "@recordforge/contracts"
import {
  createEngine,
  createSetClipSpeedCommand,
  executeCommand,
  getManualZoomSegments,
  undoCommand,
} from "./index"

/**
 * Screen clip A [0, 10s) with a camera + mic sibling on the same span, a
 * following screen clip B, a zoom inside A, a marker after A, and an AI caption
 * cue with provenance.
 */
function makeState(): TimelineState {
  const screenA = timelineClipSchema.parse({
    id: "screen-a",
    assetId: "screen-asset",
    kind: "screen",
    startMs: 0,
    durationMs: 10_000,
    sourceInMs: 0,
    sourceOutMs: 10_000,
  })
  const screenB = timelineClipSchema.parse({
    id: "screen-b",
    assetId: "screen-asset",
    kind: "screen",
    startMs: 10_000,
    durationMs: 5_000,
    sourceInMs: 10_000,
    sourceOutMs: 15_000,
  })
  const camera = timelineClipSchema.parse({
    id: "cam-a",
    assetId: "cam-asset",
    kind: "camera",
    startMs: 0,
    durationMs: 10_000,
    sourceInMs: 0,
    sourceOutMs: 10_000,
  })
  const mic = timelineClipSchema.parse({
    id: "mic-a",
    assetId: "mic-asset",
    kind: "audio",
    role: "microphone",
    startMs: 0,
    durationMs: 10_000,
    sourceInMs: 0,
    sourceOutMs: 10_000,
  })
  const caption = captionClipSchema.parse({
    id: "cap-a",
    assetId: "screen-asset",
    kind: "caption",
    startMs: 0,
    durationMs: 10_000,
    sourceInMs: 0,
    sourceOutMs: 10_000,
    text: "hello there",
    words: [
      { text: "hello", startMs: 0, endMs: 4_000 },
      { text: "there", startMs: 4_000, endMs: 9_000 },
    ],
    sourceWords: [
      { text: "hello", startMs: 100, endMs: 4_100 },
      { text: "there", startMs: 4_100, endMs: 9_100 },
    ],
    sourceStreamIndex: 1,
  })

  return timelineStateSchema.parse({
    version: 1,
    id: "tl",
    name: "Speed test",
    recordingId: "rec",
    canvas: { width: 1920, height: 1080, fps: 30 },
    tracks: [
      { id: "t-screen", kind: "screen", name: "Screen", clips: [screenA, screenB] },
      { id: "t-camera", kind: "camera", name: "Camera", clips: [camera] },
      { id: "t-audio", kind: "audio", name: "Mic", clips: [mic] },
      { id: "t-caption", kind: "captions", name: "Captions", clips: [caption] },
    ],
    markers: [{ id: "m1", timeMs: 12_000, label: "Later", color: "#f59e0b" }],
    zoomSegments: [
      {
        id: "z1",
        startMs: 2_000,
        durationMs: 6_000,
        target: { x: 100, y: 50, width: 200, height: 120 },
      },
    ],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  })
}

function clip(state: TimelineState, trackId: string, clipId: string) {
  const found = state.tracks
    .find((track) => track.id === trackId)
    ?.clips.find((candidate) => candidate.id === clipId)
  if (!found) throw new Error(`clip ${clipId} not found`)
  return found
}

describe("set-clip-speed", () => {
  it("retimes the clip, its span-aligned siblings, and remaps every lane", () => {
    const engine = createEngine(makeState())
    const result = executeCommand(engine, createSetClipSpeedCommand(["screen-a"], 2))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const state = result.value.history.present

    const a = clip(state, "t-screen", "screen-a")
    expect(a.speed).toBe(2)
    expect(a.durationMs).toBe(5_000)
    // Source range is untouched — the speed change is what shortens it.
    expect(a.sourceInMs).toBe(0)
    expect(a.sourceOutMs).toBe(10_000)

    // Ripple: the following clip closes the gap.
    expect(clip(state, "t-screen", "screen-b").startMs).toBe(5_000)
    // Recorded siblings retime together.
    expect(clip(state, "t-camera", "cam-a").durationMs).toBe(5_000)
    expect(clip(state, "t-camera", "cam-a").speed).toBe(2)
    expect(clip(state, "t-audio", "mic-a").durationMs).toBe(5_000)

    // A zoom designed over the clip stretches with it.
    expect(getManualZoomSegments(state)[0]).toMatchObject({
      startMs: 1_000,
      durationMs: 3_000,
    })
    // Markers after the range shift left by the 5 s delta.
    expect(state.markers[0].timeMs).toBe(7_000)

    // Caption cue + display words scale; container provenance is untouched.
    const caption = clip(state, "t-caption", "cap-a")
    expect(caption.durationMs).toBe(5_000)
    if (caption.kind !== "caption") throw new Error("expected a caption clip")
    expect(caption.words?.map((word) => word.startMs)).toEqual([0, 2_000])
    expect(caption.sourceWords?.map((word) => word.startMs)).toEqual([100, 4_100])
  })

  it("rejects a non-ripple slow-down that would overlap the next clip", () => {
    const engine = createEngine(makeState())
    const result = executeCommand(
      engine,
      createSetClipSpeedCommand(["screen-a"], 0.5, { ripple: false }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("clip_overlap")
  })

  it("undoes back to the original timeline", () => {
    const engine = createEngine(makeState())
    const result = executeCommand(engine, createSetClipSpeedCommand(["screen-a"], 2))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const undone = undoCommand(result.value)
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    const restored = undone.value.history.present
    expect(clip(restored, "t-screen", "screen-a")).toMatchObject({
      speed: 1,
      durationMs: 10_000,
    })
    expect(clip(restored, "t-screen", "screen-b").startMs).toBe(10_000)
    expect(restored.markers[0].timeMs).toBe(12_000)
  })

  it("retimes grouped members even when their span differs", () => {
    const state = makeState()
    const grouped: TimelineState = {
      ...state,
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => {
          if (clip.id === "screen-a") return { ...clip, groupId: "grp-1" }
          if (clip.id === "cam-a") {
            return {
              ...clip,
              groupId: "grp-1",
              startMs: 1_000,
              durationMs: 4_000,
              sourceInMs: 0,
              sourceOutMs: 4_000,
            }
          }
          return clip
        }),
      })),
    }
    const engine = createEngine(grouped)
    const result = executeCommand(engine, createSetClipSpeedCommand(["screen-a"], 2))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const next = result.value.history.present
    expect(clip(next, "t-screen", "screen-a").durationMs).toBe(5_000)
    // The group member keeps its own placement and gets its own length.
    expect(clip(next, "t-camera", "cam-a")).toMatchObject({
      startMs: 1_000,
      durationMs: 2_000,
      speed: 2,
    })
  })

  it("refuses clips that do not share a span", () => {
    const engine = createEngine(makeState())
    const result = executeCommand(engine, createSetClipSpeedCommand(["screen-a", "screen-b"], 2))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("clip_speed_span")
  })
})
