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

  it("places the vertical PiP in the bottom-right and crops the source", () => {
    const transform = buildCameraPresetTransform("vertical-pip", { canvas, source })

    expect(transform.width).toBe(Math.round(canvas.width * 0.22))
    expect(transform.height).toBe(Math.round(canvas.height * 0.42))
    expect(transform.x).toBe(canvas.width - transform.width - 24)
    expect(transform.y).toBe(canvas.height - transform.height - 24)
    expect(transform.crop).toBeDefined()
    expect(transform.crop!.width).toBeGreaterThan(0)
    expect(transform.crop!.height).toBeGreaterThan(0)
    expect(transform.preset).toBe("vertical-pip")
    expect(transform.locked).toBe(false)
  })

  it("creates a perfect circle overlay with a square source crop", () => {
    const transform = buildCameraPresetTransform("circle-pip", { canvas, source })

    expect(transform.width).toBe(transform.height)
    expect(transform.shape).toBe("circle")
    expect(transform.crop).toBeDefined()
    expect(transform.crop!.width).toBe(transform.crop!.height)
    expect(transform.preset).toBe("circle-pip")
  })

  it("creates a side-by-side layout with 68/30/2% and top/bottom gap", () => {
    const transform = buildCameraPresetTransform("side-by-side", { canvas, source })

    const screenWidth = Math.round(canvas.width * 0.68)
    const gap = Math.round(canvas.width * 0.02)
    expect(transform.width).toBe(Math.round(canvas.width * 0.3))
    expect(transform.x).toBe(screenWidth + gap)
    expect(transform.y).toBeGreaterThan(0)
    expect(transform.height).toBeLessThan(canvas.height)
    expect(transform.y + transform.height).toBeLessThanOrEqual(canvas.height)
    expect(transform.crop).toBeDefined()
    expect(transform.preset).toBe("side-by-side")
  })
})
