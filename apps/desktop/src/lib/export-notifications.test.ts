import { describe, expect, it } from "vitest"
import {
  isLengthyExport,
  isWindowInBackground,
  LENGTHY_EXPORT_THRESHOLD_MS,
} from "./export-notifications"

describe("export-notifications", () => {
  describe("LENGTHY_EXPORT_THRESHOLD_MS", () => {
    it("is 5000 milliseconds", () => {
      expect(LENGTHY_EXPORT_THRESHOLD_MS).toBe(5000)
    })
  })

  describe("isLengthyExport", () => {
    it("returns false if startedAt is missing", () => {
      expect(isLengthyExport({ startedAt: null, completedAt: "2026-09-04T10:00:10Z" })).toBe(false)
    })

    it("returns false for short exports under 5 seconds", () => {
      const startedAt = "2026-09-04T10:00:00.000Z"
      const completedAt = "2026-09-04T10:00:04.200Z"
      expect(isLengthyExport({ startedAt, completedAt })).toBe(false)
    })

    it("returns true for exports taking 5 seconds or longer", () => {
      const startedAt = "2026-09-04T10:00:00.000Z"
      const completedAt = "2026-09-04T10:00:05.000Z"
      expect(isLengthyExport({ startedAt, completedAt })).toBe(true)

      const longerCompletedAt = "2026-09-04T10:00:25.000Z"
      expect(isLengthyExport({ startedAt, completedAt: longerCompletedAt })).toBe(true)
    })

    it("handles invalid date strings safely", () => {
      expect(isLengthyExport({ startedAt: "invalid", completedAt: "invalid" })).toBe(false)
    })

    it("handles completedAt before startedAt safely", () => {
      const startedAt = "2026-09-04T10:00:10.000Z"
      const completedAt = "2026-09-04T10:00:05.000Z"
      expect(isLengthyExport({ startedAt, completedAt })).toBe(false)
    })
  })

  describe("isWindowInBackground", () => {
    it("returns boolean in test environment", () => {
      const result = isWindowInBackground()
      expect(typeof result).toBe("boolean")
    })
  })
})
