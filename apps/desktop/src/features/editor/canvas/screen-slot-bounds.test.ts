import { describe, expect, it } from "vitest"
import {
  contentRect,
  fitScreenDefault,
  fitScreenInSlot,
  sameScreenSlot,
} from "./screen-slot-bounds"

describe("fitScreenInSlot", () => {
  it("reproduces the legacy 0.76 side-by-side rect on a padded 16:9 canvas", () => {
    // Old arithmetic at 1920x1080 padding 48: usable 1824x984, target
    // round(1824*0.76)=1386, round(1386/1920*1080)=780 — the resolver emits
    // the un-rounded slot, so use the exact slot rect it produces.
    const slot = { x: 48, y: 48 + (984 - 780) / 2, width: 1386, height: 780 }
    const bounds = fitScreenInSlot({
      slot,
      canvasWidth: 1920,
      sourceWidth: 1920,
      sourceHeight: 1080,
      canvasScale: 0.5,
      positionY: 0.5,
    })
    // 1386*0.5 = 693 css wide, fits exactly; centred in the slot.
    expect(bounds).toEqual({
      left: 24,
      top: (48 + (984 - 780) / 2) * 0.5 + (780 * 0.5 - 693 * (1080 / 1920)) * 0.5,
      width: 693,
      height: 693 * (1080 / 1920),
      scale: 0.5 * (1386 / 1920),
    })
  })

  it("places the video with positionY on a 9:16 canvas slot", () => {
    const slot = { x: 0, y: 0, width: 1080, height: 1920 }
    const bounds = fitScreenInSlot({
      slot,
      canvasWidth: 1080,
      sourceWidth: 1920,
      sourceHeight: 1080,
      canvasScale: 0.4,
      positionY: 0.2,
    })
    // Width-fit: 1080*0.4=432 css wide, 243 tall; top at 20% of the free 525.
    expect(bounds.width).toBe(432)
    expect(bounds.height).toBeCloseTo(432 * (1080 / 1920), 6)
    expect(bounds.left).toBe(0)
    expect(bounds.top).toBeCloseTo((768 - 243) * 0.2, 6)
  })

  it("centres inside a lane 50/50 slot anchored at the canvas edge", () => {
    // Lane side-by-side: left half of the full canvas, no padding inset.
    const slot = { x: 0, y: 0, width: 960, height: 1080 }
    const bounds = fitScreenInSlot({
      slot,
      canvasWidth: 1920,
      sourceWidth: 1920,
      sourceHeight: 1080,
      canvasScale: 0.5,
      positionY: 0.5,
    })
    expect(bounds).toEqual({
      left: 0,
      top: (1080 * 0.5 - 480 * (1080 / 1920)) * 0.5,
      width: 480,
      height: 480 * (1080 / 1920),
      scale: 0.5 * (960 / 1920),
    })
  })
})

describe("fitScreenDefault", () => {
  it("centres the video in the content rect and keeps scale = canvasScale", () => {
    const bounds = fitScreenDefault({
      canvas: { width: 1920, height: 1080, padding: 48 },
      sourceWidth: 1920,
      sourceHeight: 1080,
      canvasScale: 0.5,
      canvasCssWidth: 960,
      positionY: 0.5,
    })
    // Content 1824x984 css 912x492; the 16:9 source is height-limited here:
    // scale = 492/1080 → 874.667x492 css, centred horizontally.
    expect(bounds).toEqual({
      left: (960 - 1920 * (492 / 1080)) / 2,
      top: 24,
      width: 1920 * (492 / 1080),
      height: 492,
      scale: 0.5,
    })
  })
})

describe("sameScreenSlot / contentRect", () => {
  it("treats a slot within the lerp drift of the content rect as default", () => {
    const content = contentRect({ width: 1920, height: 1080, padding: 48 })
    expect(sameScreenSlot(content, { x: 48.4, y: 48.2, width: 1824.4, height: 983.8 })).toBe(true)
    expect(sameScreenSlot(content, { x: 0, y: 0, width: 960, height: 1080 })).toBe(false)
    expect(sameScreenSlot(null, content)).toBe(false)
    expect(sameScreenSlot(null, null)).toBe(true)
  })
})
