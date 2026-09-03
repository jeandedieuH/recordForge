import { describe, expect, it } from "vitest"
import type { MaskClip } from "@recordforge/contracts"
import {
  clampRect,
  computeNextMaskRect,
  isActive,
  maskFallbackVisual,
  resolveRedactColor,
} from "./mask-preview"

describe("resolveRedactColor", () => {
  it("resolves black to pure #000000", () => {
    expect(resolveRedactColor("black")).toBe("#000000")
    expect(resolveRedactColor("BLACK")).toBe("#000000")
    expect(resolveRedactColor(undefined)).toBe("#000000")
    expect(resolveRedactColor("")).toBe("#000000")
  })

  it("resolves standard color keywords to consistent hex codes", () => {
    expect(resolveRedactColor("white")).toBe("#ffffff")
    expect(resolveRedactColor("red")).toBe("#ef4444")
    expect(resolveRedactColor("blue")).toBe("#3b82f6")
    expect(resolveRedactColor("green")).toBe("#10b981")
    expect(resolveRedactColor("yellow")).toBe("#f59e0b")
    expect(resolveRedactColor("gray")).toBe("#6b7280")
  })

  it("preserves custom hex strings", () => {
    expect(resolveRedactColor("#334455")).toBe("#334455")
  })
})

describe("maskFallbackVisual", () => {
  const baseClip: MaskClip = {
    id: "test-clip",
    kind: "mask",
    assetId: "mask-asset",
    speed: 1,
    sourceInMs: 0,
    sourceOutMs: 3000,
    startMs: 1000,
    durationMs: 3000,
    mode: "redact",
    rect: { x: 10, y: 20, width: 100, height: 50 },
    blurRadius: 28,
    pixelSize: 14,
    redactColor: "black",
    enabled: true,
  }

  it("renders redact with full opacity and resolved color", () => {
    const visual = maskFallbackVisual({ ...baseClip, mode: "redact", redactColor: "black" })
    expect(visual.backgroundColor).toBe("#000000")
    expect(visual.opacity).toBe(1)
  })

  it("renders blur without dark background tint", () => {
    const visual = maskFallbackVisual({ ...baseClip, mode: "blur", blurRadius: 32 })
    expect(visual.backdropFilter).toBe("blur(32px)")
    expect(visual.WebkitBackdropFilter).toBe("blur(32px)")
    expect(visual.backgroundColor).toBeUndefined()
  })

  it("renders pixelate with fallback blur", () => {
    const visual = maskFallbackVisual({ ...baseClip, mode: "pixelate", pixelSize: 16 })
    expect(visual.backdropFilter).toBe("blur(8px)")
  })
})

describe("clampRect", () => {
  it("clamps out-of-bounds coordinates and rounds to integers", () => {
    const clamped = clampRect({ x: -10.4, y: -5.7, width: 50.2, height: 40.8 }, 1920, 1080)
    expect(clamped).toEqual({
      x: 0,
      y: 0,
      width: 50,
      height: 41,
    })
  })

  it("prevents masks from exceeding canvas boundaries", () => {
    const clamped = clampRect({ x: 1900, y: 1050, width: 100, height: 100 }, 1920, 1080)
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(1920)
    expect(clamped.y + clamped.height).toBeLessThanOrEqual(1080)
  })
})

describe("computeNextMaskRect", () => {
  const rect = { x: 100, y: 100, width: 200, height: 150 }

  it("moves mask rect by integer deltas", () => {
    const next = computeNextMaskRect(
      {
        clipId: "clip-1",
        pointerId: 1,
        mode: "move",
        startX: 0,
        startY: 0,
        rect,
        moved: true,
      },
      15.6,
      -10.2,
    )
    expect(next).toEqual({
      x: 116,
      y: 90,
      width: 200,
      height: 150,
    })
  })

  it("resizes southeast handle with minimum dimension constraints", () => {
    const next = computeNextMaskRect(
      {
        clipId: "clip-1",
        pointerId: 1,
        mode: "resize",
        handle: "se",
        startX: 0,
        startY: 0,
        rect,
        moved: true,
      },
      50,
      -200, // attempting to shrink height below 20
    )
    expect(next.width).toBe(250)
    expect(next.height).toBe(20) // clamped to minimum 20
  })

  it("resizes northwest handle updating origin and dimensions", () => {
    const next = computeNextMaskRect(
      {
        clipId: "clip-1",
        pointerId: 1,
        mode: "resize",
        handle: "nw",
        startX: 0,
        startY: 0,
        rect,
        moved: true,
      },
      20,
      30,
    )
    expect(next.x).toBe(120)
    expect(next.y).toBe(130)
    expect(next.width).toBe(180)
    expect(next.height).toBe(120)
  })
})

describe("isActive", () => {
  const clip: MaskClip = {
    id: "clip-1",
    kind: "mask",
    assetId: "mask-asset",
    speed: 1,
    sourceInMs: 0,
    sourceOutMs: 2000,
    startMs: 1000,
    durationMs: 2000,
    mode: "blur",
    rect: { x: 0, y: 0, width: 100, height: 100 },
    blurRadius: 24,
    pixelSize: 12,
    redactColor: "black",
    enabled: true,
  }

  it("correctly determines active state based on playhead and enabled flag", () => {
    expect(isActive(clip, 500)).toBe(false)
    expect(isActive(clip, 1000)).toBe(true)
    expect(isActive(clip, 2500)).toBe(true)
    expect(isActive(clip, 3000)).toBe(false)
    expect(isActive({ ...clip, enabled: false }, 1500)).toBe(false)
  })
})
