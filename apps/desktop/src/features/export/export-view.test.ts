import { describe, expect, it } from "vitest"
import { resolveExportRange } from "./export-view"

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
