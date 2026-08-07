import { describe, expect, it } from "vitest"
import {
  isClipSelection,
  isMarkerSelection,
  isRangeSelection,
  selectClip,
  selectClips,
  selectMarker,
  selectRange,
  timelineSelectionSchema,
  toggleClipSelection,
} from "./index"

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
