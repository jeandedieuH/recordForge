import { describe, expect, it } from "vitest"
import {
  GRADIENT_PRESETS,
  IMAGE_BACKGROUND_PRESETS,
  SOLID_COLOR_PRESETS,
  buildLinearGradient,
  buildRadialGradient,
  computeBackgroundImageLayerStyle,
  extractDominantColor,
  getBackgroundKind,
  normalizeBackgroundCss,
  parseGradientColors,
} from "./background-presets"

describe("background-presets", () => {
  it("defines solid color presets correctly", () => {
    expect(SOLID_COLOR_PRESETS.length).toBeGreaterThan(10)
    for (const preset of SOLID_COLOR_PRESETS) {
      expect(preset.id).toBeTruthy()
      expect(preset.name).toBeTruthy()
      expect(preset.color).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })

  it("defines gradient presets with valid gradient syntax and dominant colors", () => {
    expect(GRADIENT_PRESETS.length).toBeGreaterThan(15)
    for (const preset of GRADIENT_PRESETS) {
      expect(preset.id).toBeTruthy()
      expect(preset.name).toBeTruthy()
      expect(preset.gradient).toMatch(/gradient\(/)
      expect(preset.dominantColor).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })

  it("defines all 24 image background presets correctly", () => {
    expect(IMAGE_BACKGROUND_PRESETS.length).toBe(24)
    for (const preset of IMAGE_BACKGROUND_PRESETS) {
      expect(preset.id).toMatch(/^bg-\d+$/)
      expect(preset.name).toBeTruthy()
      expect(preset.src).toMatch(/^\/backgrounds\/bg-\d+\.jpg$/)
      expect(preset.dominantColor).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })

  describe("getBackgroundKind", () => {
    it("identifies solid colors", () => {
      expect(getBackgroundKind("#070b14")).toBe("solid")
      expect(getBackgroundKind("#ffffff")).toBe("solid")
      expect(getBackgroundKind(undefined)).toBe("solid")
      expect(getBackgroundKind("")).toBe("solid")
    })

    it("identifies gradient strings", () => {
      expect(getBackgroundKind("linear-gradient(135deg, #ff6b6b 0%, #cc5de8 100%)")).toBe(
        "gradient",
      )
      expect(getBackgroundKind("radial-gradient(circle, #ff0000, #000000)")).toBe("gradient")
    })

    it("identifies image sources", () => {
      expect(getBackgroundKind("/backgrounds/bg-1.jpg")).toBe("image")
      expect(getBackgroundKind("url(/backgrounds/bg-5.jpg)")).toBe("image")
      expect(getBackgroundKind("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...")).toBe("image")
      expect(getBackgroundKind("https://example.com/image.png")).toBe("image")
    })
  })

  describe("normalizeBackgroundCss", () => {
    it("wraps image paths in url()", () => {
      expect(normalizeBackgroundCss("/backgrounds/bg-1.jpg")).toBe('url("/backgrounds/bg-1.jpg")')
      expect(normalizeBackgroundCss("url(/backgrounds/bg-1.jpg)")).toBe(
        "url(/backgrounds/bg-1.jpg)",
      )
    })

    it("leaves gradients and solid colors as is", () => {
      const grad = "linear-gradient(135deg, #000, #fff)"
      expect(normalizeBackgroundCss(grad)).toBe(grad)
      expect(normalizeBackgroundCss("#123456")).toBe("#123456")
    })

    it("provides fallback for empty string", () => {
      expect(normalizeBackgroundCss("")).toBe("#070b14")
      expect(normalizeBackgroundCss(undefined)).toBe("#070b14")
    })
  })

  describe("gradient builders", () => {
    it("builds 2-color linear gradients", () => {
      expect(buildLinearGradient("#ff0000", "#0000ff", 90)).toBe(
        "linear-gradient(90deg, #ff0000 0%, #0000ff 100%)",
      )
    })

    it("builds 3-color linear gradients", () => {
      expect(buildLinearGradient("#ff0000", "#00ff00", 180, "#0000ff")).toBe(
        "linear-gradient(180deg, #ff0000 0%, #00ff00 50%, #0000ff 100%)",
      )
    })

    it("builds radial gradients", () => {
      expect(buildRadialGradient("#ff0000", "#000000", "#070b14")).toBe(
        "radial-gradient(at 50% 50%, #ff0000 0%, #000000 70%), #070b14",
      )
    })

    it("parses gradient colors and angle", () => {
      const result = parseGradientColors("linear-gradient(45deg, #112233 0%, #445566 100%)")
      expect(result.angle).toBe(45)
      expect(result.colors).toEqual(["#112233", "#445566"])
    })
  })

  describe("extractDominantColor", () => {
    it("extracts solid color directly", () => {
      expect(extractDominantColor("#1e1b4b")).toBe("#1e1b4b")
    })

    it("extracts first color stop from gradient", () => {
      expect(extractDominantColor("linear-gradient(135deg, #6366f1 0%, #a855f7 100%)")).toBe(
        "#6366f1",
      )
    })

    it("extracts dominant color from known image preset", () => {
      expect(extractDominantColor("/backgrounds/bg-1.jpg")).toBe("#1e1b4b")
      expect(extractDominantColor("url('/backgrounds/bg-6.jpg')")).toBe("#059669")
    })
  })

  describe("computeBackgroundImageLayerStyle", () => {
    it("returns empty style for 0 blur and 0 dim", () => {
      const style = computeBackgroundImageLayerStyle(0, 0)
      expect(style.filter).toBeUndefined()
      expect(style.transform).toBeUndefined()
      expect(style.overlayOpacity).toBeUndefined()
    })

    it("applies blur filter and scale transform when blur > 0", () => {
      const style = computeBackgroundImageLayerStyle(16, 0)
      expect(style.filter).toBe("blur(16px)")
      expect(style.transform).toBe("scale(1.08)")
      expect(style.overlayOpacity).toBeUndefined()
    })

    it("applies overlay opacity when dim > 0", () => {
      const style = computeBackgroundImageLayerStyle(0, 0.4)
      expect(style.filter).toBeUndefined()
      expect(style.overlayOpacity).toBe(0.4)
    })

    it("clamps extreme blur and dim values", () => {
      const style = computeBackgroundImageLayerStyle(150, 2.5)
      expect(style.filter).toBe("blur(64px)")
      expect(style.overlayOpacity).toBe(0.9)
    })
  })
})

