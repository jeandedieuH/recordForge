import { describe, expect, it } from "vitest"
import {
  formatEta,
  formatPresetLabel,
  formatTime,
  resolvePipelineStage,
  STAGE_TITLES,
} from "./export-progress-card"

describe("ExportProgressCard helpers", () => {
  describe("resolvePipelineStage", () => {
    it("maps initial stages to prepare", () => {
      expect(resolvePipelineStage("running", "starting")).toBe("prepare")
      expect(resolvePipelineStage("pending", "queued")).toBe("prepare")
      expect(resolvePipelineStage("running", "resolving-assets")).toBe("prepare")
    })

    it("maps rendering to render", () => {
      expect(resolvePipelineStage("running", "rendering")).toBe("render")
      expect(resolvePipelineStage("running", "cursor")).toBe("render")
    })

    it("maps post-render stages to finalize", () => {
      expect(resolvePipelineStage("running", "captions")).toBe("finalize")
      expect(resolvePipelineStage("running", "chapters")).toBe("finalize")
      expect(resolvePipelineStage("running", "validating")).toBe("finalize")
    })

    it("maps completed status to ready regardless of stage", () => {
      expect(resolvePipelineStage("completed", "validating")).toBe("ready")
      expect(resolvePipelineStage("completed", "completed")).toBe("ready")
    })
  })

  describe("formatTime", () => {
    it("formats 0 seconds as 00:00", () => {
      expect(formatTime(0)).toBe("00:00")
    })

    it("formats seconds under a minute with zero padding", () => {
      expect(formatTime(9)).toBe("00:09")
      expect(formatTime(45)).toBe("00:45")
    })

    it("formats minutes and seconds cleanly", () => {
      expect(formatTime(65)).toBe("01:05")
      expect(formatTime(600)).toBe("10:00")
      expect(formatTime(3665)).toBe("61:05")
    })
  })

  describe("formatEta", () => {
    it("handles null as estimating", () => {
      expect(formatEta(null)).toBe("Estimating…")
    })

    it("handles 0 or negative as finishing", () => {
      expect(formatEta(0)).toBe("Finishing…")
      expect(formatEta(-5)).toBe("Finishing…")
    })

    it("formats seconds under a minute", () => {
      expect(formatEta(15)).toBe("~15s left")
      expect(formatEta(59)).toBe("~59s left")
    })

    it("formats minutes and seconds", () => {
      expect(formatEta(60)).toBe("~1m left")
      expect(formatEta(85)).toBe("~1m 25s left")
      expect(formatEta(180)).toBe("~3m left")
    })
  })

  describe("formatPresetLabel", () => {
    it("handles undefined as null", () => {
      expect(formatPresetLabel(undefined)).toBeNull()
    })

    it("formats single word presets with capitalization", () => {
      expect(formatPresetLabel("balanced" as any)).toBe("Balanced")
      expect(formatPresetLabel("vertical" as any)).toBe("Vertical")
      expect(formatPresetLabel("square" as any)).toBe("Square")
    })

    it("formats hyphenated presets with clean spaces and words capitalized", () => {
      expect(formatPresetLabel("fast-share" as any)).toBe("Fast Share")
      expect(formatPresetLabel("smooth-60fps" as any)).toBe("Smooth 60fps")
      expect(formatPresetLabel("high-quality" as any)).toBe("High Quality")
      expect(formatPresetLabel("ultra-4k" as any)).toBe("Ultra 4k")
      expect(formatPresetLabel("ultra-4k-60" as any)).toBe("Ultra 4k 60")
    })
  })

  describe("STAGE_TITLES", () => {
    it("has descriptive titles for all key stages", () => {
      expect(STAGE_TITLES["rendering"]).toContain("Rendering")
      expect(STAGE_TITLES["validating"]).toContain("Validating")
      expect(STAGE_TITLES["completed"]).toContain("completed")
      expect(STAGE_TITLES["failed"]).toContain("failed")
    })
  })
})
