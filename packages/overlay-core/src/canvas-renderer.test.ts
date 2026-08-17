import { describe, expect, it, vi } from "vitest"
import { renderOverlayDisplayList } from "./canvas-renderer"

function canvasWithContext(clearRect: () => void): HTMLCanvasElement {
  return {
    width: 1920,
    height: 1080,
    getContext: () => ({ clearRect }),
  } as unknown as HTMLCanvasElement
}

describe("overlay canvas renderer", () => {
  it("clears the target canvas before drawing a display list", () => {
    const clearRect = vi.fn()
    const canvas = canvasWithContext(clearRect)

    renderOverlayDisplayList({ timeMs: 250, items: [] }, canvas)

    expect(clearRect).toHaveBeenCalledWith(0, 0, 1920, 1080)
  })
})
