import { describe, expect, it } from "vitest"
import {
  DEFAULT_TELEPROMPTER_SETTINGS,
  FONT_SIZE_LIMIT,
  OPACITY_LIMIT,
  sanitizeSettings,
  WPM_LIMIT,
} from "./teleprompter-settings"

describe("sanitizeSettings", () => {
  it("returns defaults for non-objects", () => {
    for (const raw of [undefined, null, 5, "x", true, []]) {
      expect(sanitizeSettings(raw)).toEqual(DEFAULT_TELEPROMPTER_SETTINGS)
    }
  })

  it("keeps valid fields and applies per-field defaults", () => {
    expect(sanitizeSettings({ wpm: 200, mirror: true })).toEqual({
      wpm: 200,
      fontSize: DEFAULT_TELEPROMPTER_SETTINGS.fontSize,
      opacity: DEFAULT_TELEPROMPTER_SETTINGS.opacity,
      mirror: true,
    })
  })

  it("clamps numbers to their limits without snapping to steps", () => {
    expect(sanitizeSettings({ wpm: 10 }).wpm).toBe(WPM_LIMIT.min)
    expect(sanitizeSettings({ wpm: 9999 }).wpm).toBe(WPM_LIMIT.max)
    expect(sanitizeSettings({ wpm: 137 }).wpm).toBe(137)
    expect(sanitizeSettings({ fontSize: 1 }).fontSize).toBe(FONT_SIZE_LIMIT.min)
    expect(sanitizeSettings({ fontSize: 500 }).fontSize).toBe(FONT_SIZE_LIMIT.max)
    expect(sanitizeSettings({ opacity: 0 }).opacity).toBe(OPACITY_LIMIT.min)
    expect(sanitizeSettings({ opacity: 140 }).opacity).toBe(OPACITY_LIMIT.max)
  })

  it("replaces wrong-type, NaN, and non-finite values with defaults", () => {
    const result = sanitizeSettings({
      wpm: Number.NaN,
      fontSize: "big",
      opacity: Number.POSITIVE_INFINITY,
      mirror: "yes",
    })
    expect(result).toEqual(DEFAULT_TELEPROMPTER_SETTINGS)
  })

  it("migrates the legacy shape: speed is ignored, other fields kept", () => {
    const result = sanitizeSettings({ speed: 170, fontSize: 34, mirror: false })
    expect(result.wpm).toBe(DEFAULT_TELEPROMPTER_SETTINGS.wpm)
    expect(result.fontSize).toBe(34)
    expect(result.mirror).toBe(false)
    expect(result.opacity).toBe(DEFAULT_TELEPROMPTER_SETTINGS.opacity)
    expect("speed" in result).toBe(false)
  })
})
