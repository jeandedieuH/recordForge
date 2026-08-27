import { describe, expect, it } from "vitest"
import { buildCameraPresetTransform } from "./camera-presets"

const canvas = { width: 1920, height: 1080 }
const source = { width: 1280, height: 720 }

describe("buildCameraPresetTransform", () => {
  it("creates a full-bleed locked transform for camera-only", () => {
    const transform = buildCameraPresetTransform("camera-only", { canvas, source })

    expect(transform.x).toBe(0)
    expect(transform.y).toBe(0)
    expect(transform.width).toBe(canvas.width)
    expect(transform.height).toBe(canvas.height)
    expect(transform.locked).toBe(true)
    expect(transform.borderWidth).toBe(0)
    expect(transform.shadowEnabled).toBe(false)
    expect(transform.preset).toBe("camera-only")
  })

  it("places the vertical PiP in the bottom-right with 5:7 ratio and max 240 width", () => {
    const transform = buildCameraPresetTransform("vertical-pip", { canvas, source })

    expect(transform.width).toBe(240)
    expect(transform.height).toBe(336)
    expect(transform.width / transform.height).toBeCloseTo(5 / 7, 2)
    expect(transform.x).toBe(canvas.width - transform.width - 24)
    expect(transform.y).toBe(canvas.height - transform.height - 24)
    expect(transform.crop).toBeDefined()
    expect(transform.crop!.width).toBeGreaterThan(0)
    expect(transform.crop!.height).toBeGreaterThan(0)
    expect(transform.preset).toBe("vertical-pip")
    expect(transform.locked).toBe(false)
  })

  it("scales down vertical PiP width on smaller canvas while preserving 5:7 ratio", () => {
    const smallCanvas = { width: 800, height: 600 }
    const transform = buildCameraPresetTransform("vertical-pip", { canvas: smallCanvas, source })

    const expectedWidth = Math.round(800 * 0.22) // 176 <= 240
    const expectedHeight = Math.round(expectedWidth * (7 / 5)) // 246
    expect(transform.width).toBe(expectedWidth)
    expect(transform.height).toBe(expectedHeight)
    expect(transform.width).toBeLessThanOrEqual(240)
    expect(transform.width / transform.height).toBeCloseTo(5 / 7, 2)
    expect(transform.x).toBe(800 - expectedWidth - 24)
    expect(transform.y).toBe(600 - expectedHeight - 24)
  })

  it("creates a perfect circle overlay with a square source crop", () => {
    const transform = buildCameraPresetTransform("circle-pip", { canvas, source })

    expect(transform.width).toBe(transform.height)
    expect(transform.shape).toBe("circle")
    expect(transform.crop).toBeDefined()
    expect(transform.crop!.width).toBe(transform.crop!.height)
    expect(transform.preset).toBe("circle-pip")
  })

  it("creates a robust side-by-side layout with 76% screen, 5:7 camera ratio, and vertical centering", () => {
    const transform = buildCameraPresetTransform("side-by-side", { canvas, source })

    const screenWidth = Math.round(canvas.width * 0.76)
    const gap = Math.round(canvas.width * 0.02)
    const expectedWidth = canvas.width - screenWidth - gap
    const expectedHeight = Math.round(expectedWidth * (7 / 5))
    expect(transform.width).toBe(expectedWidth)
    expect(transform.height).toBe(expectedHeight)
    // Verify 5:7 aspect ratio
    expect(transform.width / transform.height).toBeCloseTo(5 / 7, 2)
    expect(transform.x).toBe(screenWidth + gap)
    // Vertically centered
    expect(transform.y).toBe(Math.round((canvas.height - expectedHeight) / 2))
    expect(transform.y).toBeGreaterThan(0)
    expect(transform.y + transform.height).toBeLessThanOrEqual(canvas.height)
    expect(transform.crop).toBeDefined()
    expect(transform.preset).toBe("side-by-side")
    expect(transform.locked).toBe(true)
  })

  it("respects canvas padding for side-by-side layout", () => {
    const paddedCanvas = { width: 1920, height: 1080, padding: 40 }
    const transform = buildCameraPresetTransform("side-by-side", { canvas: paddedCanvas, source })

    const usableWidth = 1920 - 80
    const usableHeight = 1080 - 80
    const screenWidth = Math.round(usableWidth * 0.76)
    const gap = Math.round(usableWidth * 0.02)
    const expectedWidth = usableWidth - screenWidth - gap
    const expectedHeight = Math.round(expectedWidth * (7 / 5))

    expect(transform.width).toBe(expectedWidth)
    expect(transform.height).toBe(expectedHeight)
    expect(transform.x).toBe(40 + screenWidth + gap)
    expect(transform.y).toBe(40 + Math.round((usableHeight - expectedHeight) / 2))
    expect(transform.x + transform.width).toBe(1920 - 40)
    expect(transform.locked).toBe(true)
  })
})
