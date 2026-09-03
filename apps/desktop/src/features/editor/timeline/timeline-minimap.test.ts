import { describe, expect, it } from "vitest"

describe("timeline minimap viewport and coordinate calculations", () => {
  function computeLensGeometry(durationMs: number, visibleStartMs: number, visibleEndMs: number) {
    const effectiveDuration = Math.max(1, durationMs)
    const lensLeftPercent = Math.max(0, Math.min(100, (visibleStartMs / effectiveDuration) * 100))
    const visibleSpanMs = Math.max(1, visibleEndMs - visibleStartMs)
    const lensWidthPercent = Math.max(
      2,
      Math.min(100 - lensLeftPercent, (visibleSpanMs / effectiveDuration) * 100),
    )
    return { lensLeftPercent, lensWidthPercent }
  }

  it("calculates 0 to 100% when entire timeline is visible", () => {
    const { lensLeftPercent, lensWidthPercent } = computeLensGeometry(60000, 0, 60000)
    expect(lensLeftPercent).toBe(0)
    expect(lensWidthPercent).toBe(100)
  })

  it("calculates correct percentage window when zoomed into middle", () => {
    const { lensLeftPercent, lensWidthPercent } = computeLensGeometry(100000, 25000, 75000)
    expect(lensLeftPercent).toBe(25)
    expect(lensWidthPercent).toBe(50)
  })

  it("clamps minimum lens width to 2% for usability on deep zooms", () => {
    const { lensLeftPercent, lensWidthPercent } = computeLensGeometry(1000000, 50000, 50100)
    expect(lensLeftPercent).toBe(5)
    expect(lensWidthPercent).toBeGreaterThanOrEqual(2)
  })
})
