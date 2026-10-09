import { describe, expect, it } from "vitest"
import type { TimelineCanvas } from "@recordforge/contracts"
import {
  exceedsGifDurationLimit,
  isPresetSupported,
  PRO_PRESETS,
  resolveExportRange,
} from "./export-view"

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

describe("PRO_PRESETS", () => {
  it("maps the 4K and social presets to their license feature keys", () => {
    expect(PRO_PRESETS["ultra-4k"]).toBe("high-res-export")
    expect(PRO_PRESETS["ultra-4k-60"]).toBe("high-res-export")
    expect(PRO_PRESETS.vertical).toBe("custom-aspect-ratio")
    expect(PRO_PRESETS.square).toBe("custom-aspect-ratio")
  })

  it("leaves the 1080p presets ungated", () => {
    expect(PRO_PRESETS.balanced).toBeUndefined()
    expect(PRO_PRESETS["default-mp4"]).toBeUndefined()
    expect(PRO_PRESETS["selected-range"]).toBeUndefined()
  })
})

describe("isPresetSupported", () => {
  const canvas1080 = {
    width: 1920,
    height: 1080,
  } as TimelineCanvas
  const canvas4k = { ...canvas1080, width: 3840, height: 2160 } as TimelineCanvas

  it("enables Ultra 4K presets only on a 2160p-tier canvas", () => {
    expect(isPresetSupported("ultra-4k", canvas4k, undefined)).toBe(true)
    expect(isPresetSupported("ultra-4k-60", canvas4k, undefined)).toBe(true)
    expect(isPresetSupported("ultra-4k", canvas1080, undefined)).toBe(false)
    expect(isPresetSupported("ultra-4k", undefined, undefined)).toBe(false)
  })

  it("treats 1440p canvases as below the Ultra tier", () => {
    const canvas1440 = { ...canvas1080, width: 2560, height: 1440 } as TimelineCanvas
    expect(isPresetSupported("ultra-4k", canvas1440, undefined)).toBe(false)
  })

  it("keeps ratio presets bound to canvas orientation", () => {
    const vertical = { ...canvas1080, width: 1080, height: 1920 } as TimelineCanvas
    expect(isPresetSupported("vertical", vertical, undefined)).toBe(true)
    expect(isPresetSupported("vertical", canvas1080, undefined)).toBe(false)
    expect(
      isPresetSupported("square", { ...canvas1080, height: 1080 } as TimelineCanvas, undefined),
    ).toBe(false)
    expect(
      isPresetSupported("square", { ...vertical, height: 1080 } as TimelineCanvas, undefined),
    ).toBe(true)
  })
})
