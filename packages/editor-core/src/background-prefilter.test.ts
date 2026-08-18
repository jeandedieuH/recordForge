import { describe, expect, it } from "vitest"
import {
  computeBlurDownscaleFactor,
  createBackgroundFilterCacheKey,
  getEffectiveBackgroundFilterPlan,
} from "./background-prefilter"

describe("background-prefilter", () => {
  describe("computeBlurDownscaleFactor", () => {
    it("returns 1 when blur is zero", () => {
      expect(computeBlurDownscaleFactor(0, "performance")).toBe(1)
      expect(computeBlurDownscaleFactor(0, "quality")).toBe(1)
      expect(computeBlurDownscaleFactor(0, "power")).toBe(1)
    })

    it("scales down appropriately for performance mode", () => {
      expect(computeBlurDownscaleFactor(4, "performance")).toBe(1)
      expect(computeBlurDownscaleFactor(8, "performance")).toBe(2)
      expect(computeBlurDownscaleFactor(16, "performance")).toBe(2)
      expect(computeBlurDownscaleFactor(24, "performance")).toBe(4)
    })

    it("conserves quality in quality mode", () => {
      expect(computeBlurDownscaleFactor(16, "quality")).toBe(1)
      expect(computeBlurDownscaleFactor(24, "quality")).toBe(2)
    })

    it("aggressively downscales in power mode", () => {
      expect(computeBlurDownscaleFactor(16, "power")).toBe(4)
    })
  })

  describe("createBackgroundFilterCacheKey", () => {
    it("produces deterministic keys", () => {
      const key1 = createBackgroundFilterCacheKey("linear-gradient(#000,#fff)", 16, 0.4, 1920, 1080)
      const key2 = createBackgroundFilterCacheKey("linear-gradient(#000,#fff)", 16, 0.4, 1920, 1080)
      expect(key1).toBe(key2)
      expect(key1).toContain("b:16")
      expect(key1).toContain("d:0.40")
      expect(key1).toContain("1920x1080")
    })

    it("clamps values within safe bounds", () => {
      const key = createBackgroundFilterCacheKey("#111", 100, 2.0, 0, 0)
      expect(key).toContain("b:64")
      expect(key).toContain("d:0.90")
      expect(key).toContain("1x1")
    })
  })

  describe("getEffectiveBackgroundFilterPlan", () => {
    it("identifies when pre-rendered filtering is needed", () => {
      const planNoFilter = getEffectiveBackgroundFilterPlan("#111", 0, 0)
      expect(planNoFilter.usePreRenderedFilter).toBe(false)

      const planWithBlur = getEffectiveBackgroundFilterPlan("#111", 16, 0)
      expect(planWithBlur.usePreRenderedFilter).toBe(true)
      expect(planWithBlur.blurRadius).toBe(16)

      const planWithDim = getEffectiveBackgroundFilterPlan("#111", 0, 0.5)
      expect(planWithDim.usePreRenderedFilter).toBe(true)
      expect(planWithDim.dimFactor).toBe(0.5)
    })
  })
})
