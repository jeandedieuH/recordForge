import { describe, expect, it } from "vitest"
import { defaultCursorSettings, type TimelineState } from "@recordforge/domain"
import {
  extendClipSelection,
  isClipSelection,
  isMarkerSelection,
  isRangeSelection,
  mergeClipIds,
  selectAllClipIds,
  selectClip,
  selectClips,
  selectMarker,
  selectRange,
  timelineSelectionSchema,
  toggleClipSelection,
} from "./index"

// Selection-fixture layout:
//   t1 (screen): [c1 0-4s] [c2 10-14s] [c3 20-24s]
//   t2 (audio):  [d1 2-6s]
// c1 and d1 share group "g1" to exercise expansion.
function makeState(): TimelineState {
  return {
    version: 1,
    id: "project-1",
    name: "Selection test",
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
        id: "t1",
        kind: "screen",
        name: "Screen",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "c1",
            kind: "screen",
            assetId: "rec-1",
            startMs: 0,
            durationMs: 4_000,
            sourceInMs: 0,
            sourceOutMs: 4_000,
            speed: 1,
            groupId: "g1",
          },
          {
            id: "c2",
            kind: "screen",
            assetId: "rec-1",
            startMs: 10_000,
            durationMs: 4_000,
            sourceInMs: 0,
            sourceOutMs: 4_000,
            speed: 1,
          },
          {
            id: "c3",
            kind: "screen",
            assetId: "rec-1",
            startMs: 20_000,
            durationMs: 4_000,
            sourceInMs: 0,
            sourceOutMs: 4_000,
            speed: 1,
          },
        ],
      },
      {
        id: "t2",
        kind: "audio",
        name: "Audio",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "d1",
            kind: "audio",
            assetId: "rec-1",
            startMs: 2_000,
            durationMs: 4_000,
            sourceInMs: 0,
            sourceOutMs: 4_000,
            speed: 1,
            volume: 1,
            fadeInMs: 0,
            fadeOutMs: 0,
            groupId: "g1",
          },
        ],
      },
    ],
    markers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

describe("timeline selection", () => {
  it("creates a single clip selection", () => {
    const selection = selectClip("clip-1", "track-1")
    expect(isClipSelection(selection)).toBe(true)
    expect(selection).toMatchObject({
      kind: "clip",
      primaryClipId: "clip-1",
      clipIds: ["clip-1"],
      trackId: "track-1",
    })
  })

  it("creates a multi-clip selection", () => {
    const selection = selectClips("clip-2", ["clip-1", "clip-2"], "track-1")
    expect(selection.primaryClipId).toBe("clip-2")
    expect(selection.clipIds).toEqual(["clip-1", "clip-2"])
  })

  it("creates a range selection", () => {
    const selection = selectRange(10_000, 50_000)
    expect(isRangeSelection(selection)).toBe(true)
    expect(selection).toMatchObject({ startMs: 10_000, endMs: 50_000 })
  })

  it("creates a marker selection", () => {
    const selection = selectMarker("marker-1")
    expect(isMarkerSelection(selection)).toBe(true)
    expect(selection.markerId).toBe("marker-1")
  })

  it("toggles clips in and out of a selection", () => {
    const current = selectClips("clip-1", ["clip-1", "clip-2"], "track-1")
    const added = toggleClipSelection(current, "clip-3")
    expect(added.clipIds).toEqual(["clip-1", "clip-2", "clip-3"])
    expect(added.primaryClipId).toBe("clip-3")

    const removed = toggleClipSelection(current, "clip-1")
    expect(removed.clipIds).toEqual(["clip-2"])
    expect(removed.primaryClipId).toBe("clip-2")
  })

  it("validates a selection through the schema", () => {
    const selection = selectClip("clip-1")
    const parsed = timelineSelectionSchema.parse(selection)
    expect(parsed).toMatchObject({
      kind: "clip",
      primaryClipId: "clip-1",
      clipIds: ["clip-1"],
    })
  })

  it("rejects an invalid selection", () => {
    expect(() =>
      timelineSelectionSchema.parse({
        kind: "clip",
        primaryClipId: 1,
        clipIds: ["clip-1"],
      }),
    ).toThrow()
  })
})

describe("flexible selection helpers", () => {
  it("toggles a whole group as one unit via memberIds", () => {
    const base = selectClip("c2", "t1")
    const grouped = toggleClipSelection(base, "c1", "t1", ["c1", "d1"])
    expect(grouped.clipIds).toEqual(["c2", "c1", "d1"])
    expect(grouped.primaryClipId).toBe("c1")

    const untoggled = toggleClipSelection(grouped, "c1", "t1", ["c1", "d1"])
    expect(untoggled.clipIds).toEqual(["c2"])
  })

  it("extends a same-track selection over a contiguous clip range", () => {
    const state = makeState()
    const next = extendClipSelection(state, selectClip("c1", "t1"), "c3")
    expect(next).not.toBeNull()
    // c1 and c3 endpoints plus c2 in between; d1 joins through the group.
    expect(next!.clipIds).toEqual(["c1", "c2", "c3", "d1"])
    expect(next!.primaryClipId).toBe("c3")
    expect(next!.trackId).toBe("t1")
  })

  it("extends a cross-track selection as a time-span block", () => {
    const state = makeState()
    const next = extendClipSelection(state, selectClip("c3", "t1"), "d1")
    expect(next).not.toBeNull()
    // Block spans 2s..24s: d1, c2, c3 — plus c1 pulled in through the group.
    expect(next!.clipIds).toEqual(["c1", "c2", "c3", "d1"])
    expect(next!.trackId).toBe("t2")
  })

  it("honours the group-bypass flag when extending", () => {
    const state = makeState()
    const next = extendClipSelection(state, selectClip("c1", "t1"), "c2", {
      expandGroups: false,
    })
    expect(next!.clipIds).toEqual(["c1", "c2"])
  })

  it("falls back to the clicked clip when no anchor exists", () => {
    const state = makeState()
    const next = extendClipSelection(state, null, "c2")
    expect(next!.clipIds).toEqual(["c2"])
  })

  it("merges ids without duplicates for additive marquees", () => {
    expect(mergeClipIds(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"])
    expect(mergeClipIds([], ["c"])).toEqual(["c"])
  })

  it("selects every clip in visual order", () => {
    expect(selectAllClipIds(makeState())).toEqual(["c1", "c2", "c3", "d1"])
  })
})
