import { describe, expect, it } from "vitest"
import { formatHexDisplay, hsvToRgb, parseColorToRgb, rgbToHex, rgbToHsv } from "./color-picker"

describe("Color utilities", () => {
  it("parses 6-digit hex color correctly", () => {
    const rgb = parseColorToRgb("#3b82f6")
    expect(rgb.r).toBe(59)
    expect(rgb.g).toBe(130)
    expect(rgb.b).toBe(246)
    expect(rgb.a).toBe(1)
  })

  it("parses 3-digit hex color correctly", () => {
    const rgb = parseColorToRgb("#fff")
    expect(rgb.r).toBe(255)
    expect(rgb.g).toBe(255)
    expect(rgb.b).toBe(255)
    expect(rgb.a).toBe(1)
  })

  it("parses named colors correctly", () => {
    const rgbBlack = parseColorToRgb("black")
    expect(rgbBlack.r).toBe(0)
    expect(rgbBlack.g).toBe(0)
    expect(rgbBlack.b).toBe(0)

    const rgbWhite = parseColorToRgb("white")
    expect(rgbWhite.r).toBe(255)
    expect(rgbWhite.g).toBe(255)
    expect(rgbWhite.b).toBe(255)
  })

  it("parses rgba strings correctly", () => {
    const rgb = parseColorToRgb("rgba(100, 150, 200, 0.5)")
    expect(rgb.r).toBe(100)
    expect(rgb.g).toBe(150)
    expect(rgb.b).toBe(200)
    expect(rgb.a).toBe(0.5)
  })

  it("roundtrips RGB to HSV and back to RGB", () => {
    const original = { r: 59, g: 130, b: 246, a: 1 }
    const hsv = rgbToHsv(original)
    const result = hsvToRgb(hsv)

    expect(Math.abs(result.r - original.r)).toBeLessThanOrEqual(1)
    expect(Math.abs(result.g - original.g)).toBeLessThanOrEqual(1)
    expect(Math.abs(result.b - original.b)).toBeLessThanOrEqual(1)
  })

  it("converts RGB to HEX accurately", () => {
    const hex = rgbToHex({ r: 0, g: 0, b: 0, a: 1 })
    expect(hex).toBe("#000000")

    const hexWhite = rgbToHex({ r: 255, g: 255, b: 255, a: 1 })
    expect(hexWhite).toBe("#ffffff")

    const hexAlpha = rgbToHex({ r: 255, g: 0, b: 0, a: 0.5 }, true)
    expect(hexAlpha.startsWith("#ff0000")).toBe(true)
  })

  it("formats hex for display as uppercase", () => {
    expect(formatHexDisplay("#094db2")).toBe("#094DB2")
    expect(formatHexDisplay("#ffffff")).toBe("#FFFFFF")
  })
})
