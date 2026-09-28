import { describe, expect, it } from "vitest"
import { exceedsGifDurationLimit, resolveExportRange } from "./export-view"

describe("resolveExportRange", () => {
  it("returns a rounded range when start and end are valid", () => {
    expect(resolveExportRange(10_000, 27_500, 60_000)).toEqual({
      startMs: 10_000,
      endMs: 27_500,
    })
  })

  it("rounds sub-millisecond values coming from second-based inputs", () => {
    expect(resolveExportRange(5_500.4, 10_000.6, 60_000)).toEqual({
      startMs: 5_500,
      endMs: 10_001,
    })
  })

  it("clamps the range to the recording bounds", () => {
    expect(resolveExportRange(-250, 999_999, 60_000)).toEqual({ startMs: 0, endMs: 60_000 })
  })

  it("returns undefined when the end is not after the start", () => {
    expect(resolveExportRange(5_000, 5_000, 60_000)).toBeUndefined()
    expect(resolveExportRange(6_000, 5_000, 60_000)).toBeUndefined()
  })

  it("returns undefined when the start is beyond the recording", () => {
    expect(resolveExportRange(61_000, 99_999, 60_000)).toBeUndefined()
  })

  it("returns undefined for empty recordings", () => {
    expect(resolveExportRange(0, 1_000, 0)).toBeUndefined()
  })
})

describe("exceedsGifDurationLimit", () => {
  it("blocks a full-length GIF over 60 seconds", () => {
    expect(exceedsGifDurationLimit("gif", "gif-balanced", 61_000, undefined)).toBe(true)
  })

  it("allows a GIF at exactly 60 seconds", () => {
    expect(exceedsGifDurationLimit("gif", "gif-balanced", 60_000, undefined)).toBe(false)
  })

  it("judges the selected range rather than the timeline", () => {
    const range = { startMs: 10_000, endMs: 40_000 }
    expect(exceedsGifDurationLimit("gif", "selected-range", 300_000, range)).toBe(false)
  })

  it("blocks a selected range over 60 seconds", () => {
    const range = { startMs: 0, endMs: 61_000 }
    expect(exceedsGifDurationLimit("gif", "selected-range", 300_000, range)).toBe(true)
  })

  it("never blocks mp4", () => {
    expect(exceedsGifDurationLimit("mp4", "balanced", 600_000, undefined)).toBe(false)
  })
})
