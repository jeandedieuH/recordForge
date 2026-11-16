import { describe, expect, it } from "vitest"
import {
  FULL_FRAME_CROP,
  backgroundCoverUv,
  centerCoverCrop,
  cutoutBlurUv,
  matteShrinkShift,
  parseCutoutColor,
} from "./camera-cutout"

describe("camera cutout preview geometry", () => {
  it("cover-crops a wider source to the target aspect", () => {
    const crop = centerCoverCrop(16 / 9, 4 / 3)
    expect(crop.height).toBe(1)
    expect(crop.width).toBeCloseTo(0.75)
    expect(crop.x).toBeCloseTo(0.125)
    expect(crop.y).toBe(0)
  })

  it("cover-crops a taller source to the target aspect", () => {
    const crop = centerCoverCrop(4 / 3, 16 / 9)
    expect(crop.width).toBe(1)
    expect(crop.height).toBeCloseTo(0.75)
    expect(crop.x).toBe(0)
    expect(crop.y).toBeCloseTo(0.125)
  })

  it("falls back to the full frame for unknown aspects", () => {
    expect(centerCoverCrop(0, 16 / 9)).toEqual(FULL_FRAME_CROP)
    expect(centerCoverCrop(Number.NaN, 1)).toEqual(FULL_FRAME_CROP)
  })

  it("matches the renderer's matte shrink step", () => {
    expect(matteShrinkShift(0)).toBe(0)
    expect(matteShrinkShift(2)).toBeCloseTo(24 / 255)
    expect(matteShrinkShift(-1)).toBeCloseTo(-12 / 255)
    // Clamped to the contract's -8..8 range.
    expect(matteShrinkShift(99)).toBeCloseTo(96 / 255)
  })

  it("scales the blur radius from bubble pixels to source UV", () => {
    const crop = { x: 0.1, y: 0.2, width: 0.5, height: 0.4 }
    expect(cutoutBlurUv(18, crop, 300, 200)).toEqual([(18 * 0.5) / 300, (18 * 0.4) / 200])
    expect(cutoutBlurUv(Number.NaN, crop, 300, 200)).toEqual([0, 0])
    expect(cutoutBlurUv(18, crop, 0, 0)).toEqual([0, 0])
  })

  it("parses the colour picker's hex formats", () => {
    const [r, g, b] = parseCutoutColor("#0f172a")
    expect(r).toBeCloseTo(15 / 255)
    expect(g).toBeCloseTo(23 / 255)
    expect(b).toBeCloseTo(42 / 255)
    expect(parseCutoutColor("#fff")).toEqual([1, 1, 1])
    expect(parseCutoutColor("not-a-colour")).toEqual(parseCutoutColor(undefined))
  })

  it("cover-fits background images in UV space", () => {
    expect(backgroundCoverUv(16 / 9, 4 / 3)).toEqual([0.75, 1, 0.125, 0])
    expect(backgroundCoverUv(4 / 3, 16 / 9)).toEqual([1, 0.75, 0, 0.125])
    expect(backgroundCoverUv(16 / 9, 16 / 9)).toEqual([1, 1, 0, 0])
    expect(backgroundCoverUv(0, 1)).toEqual([1, 1, 0, 0])
  })
})
