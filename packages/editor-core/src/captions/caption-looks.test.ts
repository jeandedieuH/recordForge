import { describe, expect, it } from "vitest"
import { captionStylePresetSchema } from "@recordforge/contracts"
import { CAPTION_ACCENT_PRESETS, CAPTION_LOOK_LIST, CAPTION_LOOKS } from "./caption-looks"

const HEX = /^#[0-9a-fA-F]{6}$/
const isHexOrAccent = (v: string) => HEX.test(v) || v === "accent"

describe("caption looks table", () => {
  it("covers every preset id exactly once", () => {
    const ids = CAPTION_LOOK_LIST.map((look) => look.id)
    expect(new Set(ids)).toEqual(new Set(captionStylePresetSchema.options))
    expect(CAPTION_LOOK_LIST[0].id).toBe("default")
    expect(Object.keys(CAPTION_LOOKS)).toHaveLength(6)
  })

  it("keeps tokens inside their valid ranges", () => {
    for (const look of Object.values(CAPTION_LOOKS)) {
      expect([600, 700, 800]).toContain(look.fontWeight)
      expect(HEX.test(look.textColor)).toBe(true)
      expect(HEX.test(look.accentDefault)).toBe(true)
      expect(look.letterSpacingEm).toBeGreaterThanOrEqual(0)
      expect(look.animation.inMs).toBeGreaterThanOrEqual(0)
      expect(look.animation.outMs).toBeGreaterThanOrEqual(0)
      expect(look.animation.fromScale).toBeGreaterThanOrEqual(0.5)
      expect(look.animation.fromScale).toBeLessThanOrEqual(1)
      if (look.chip) {
        expect(isHexOrAccent(look.chip.color)).toBe(true)
        expect(look.chip.opacity).toBeGreaterThanOrEqual(0)
        expect(look.chip.opacity).toBeLessThanOrEqual(1)
        expect(look.chip.radiusEm).toBeGreaterThanOrEqual(0)
        expect(look.chip.padXEm).toBeGreaterThanOrEqual(0)
        expect(look.chip.padYEm).toBeGreaterThanOrEqual(0)
      }
      if (look.outline) {
        expect(HEX.test(look.outline.color)).toBe(true)
        expect(look.outline.opacity).toBeGreaterThanOrEqual(0)
        expect(look.outline.opacity).toBeLessThanOrEqual(1)
        expect(look.outline.widthEm).toBeGreaterThan(0)
      }
      if (look.shadow) {
        expect(HEX.test(look.shadow.color)).toBe(true)
        expect(look.shadow.opacity).toBeGreaterThanOrEqual(0)
        expect(look.shadow.opacity).toBeLessThanOrEqual(1)
      }
      if (look.highlight) {
        expect(["word", "focus"]).toContain(look.highlight.mode)
        expect(isHexOrAccent(look.highlight.activeColor)).toBe(true)
        expect(look.highlight.inactiveOpacity).toBeGreaterThanOrEqual(0)
        expect(look.highlight.inactiveOpacity).toBeLessThanOrEqual(1)
      }
      // The accent placeholder must never ship unresolved.
      if (!look.usesAccent) {
        const usesAccentPlaceholder =
          look.chip?.color === "accent" || look.highlight?.activeColor === "accent"
        expect(usesAccentPlaceholder).toBe(false)
      }
    }
  })

  it("accent presets are valid hex", () => {
    for (const color of CAPTION_ACCENT_PRESETS) expect(HEX.test(color)).toBe(true)
  })
})
