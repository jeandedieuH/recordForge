import { describe, expect, it, vi } from "vitest"
import { renderOverlayDisplayList } from "./canvas-renderer"

if (typeof globalThis.Path2D === "undefined") {
  ;(globalThis as any).Path2D = class {
    addPath() {}
    closePath() {}
    moveTo() {}
    lineTo() {}
    bezierCurveTo() {}
    quadraticCurveTo() {}
    arc() {}
    arcTo() {}
    ellipse() {}
    rect() {}
    roundRect() {}
  }
}

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

  it("renders multiline titles and annotations across multiple fillText calls", () => {
    const fillText = vi.fn()
    const save = vi.fn()
    const restore = vi.fn()
    const fill = vi.fn()
    const stroke = vi.fn()
    const setLineDash = vi.fn()

    const context = {
      clearRect: vi.fn(),
      save,
      restore,
      fill,
      stroke,
      setLineDash,
      translate: vi.fn(),
      rotate: vi.fn(),
      fillText,
      canvas: { width: 1920, height: 1080 },
    }
    const canvas = {
      width: 1920,
      height: 1080,
      getContext: () => context,
    } as unknown as HTMLCanvasElement

    renderOverlayDisplayList(
      {
        timeMs: 100,
        items: [
          {
            kind: "text",
            id: "title-multiline",
            zIndex: 1,
            transform: { x: 100, y: 100, width: 400, height: 200, zIndex: 1, opacity: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
            animationProgress: 1,
            textProgress: 1,
            presetId: "title",
            category: "title",
            primaryText: "Line 1\nLine 2\nLine 3",
            secondaryText: "Sub 1\nSub 2",
            tagText: "TAG",
            alignment: "left",
            fontFamily: "sans",
            fontSize: 24,
            fontWeight: "700",
            textColor: "#ffffff",
            secondaryTextColor: "#94a3b8",
            accentColor: "#38bdf8",
            backdropStyle: "none",
            backdropColor: "#000000",
            backdropOpacity: 1,
            backdropBlur: 0,
            backdropBorderRadius: 0,
            backdropPaddingX: 0,
            backdropPaddingY: 0,
            shadowEnabled: false,
            shadowColor: "black",
            shadowBlur: 0,
          },
          {
            kind: "annotation",
            id: "callout-multiline",
            zIndex: 2,
            transform: { x: 500, y: 100, width: 200, height: 120, zIndex: 2, opacity: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
            animationProgress: 1,
            drawProgress: 1,
            annotationType: "callout",
            strokeColor: "#38bdf8",
            strokeWidth: 2,
            strokeStyle: "solid",
            fillColor: "#0f172a",
            fillOpacity: 0.9,
            cornerRadius: 8,
            arrowEndHead: "none",
            arrowStartHead: "none",
            shadowEnabled: false,
            shadowColor: "black",
            shadowBlur: 0,
            text: "Callout Line A\nCallout Line B",
            textColor: "#ffffff",
            fontSize: 14,
          },
        ],
      },
      canvas,
    )

    // Primary text: 3 lines; secondary: 2 lines; tag: 1 line; callout: 2 lines => total 8 calls
    expect(fillText).toHaveBeenCalledWith(expect.stringContaining("Line 1"), expect.any(Number), expect.any(Number))
    expect(fillText).toHaveBeenCalledWith(expect.stringContaining("Line 2"), expect.any(Number), expect.any(Number))
    expect(fillText).toHaveBeenCalledWith(expect.stringContaining("Line 3"), expect.any(Number), expect.any(Number))
    expect(fillText).toHaveBeenCalledWith(expect.stringContaining("Sub 1"), expect.any(Number), expect.any(Number))
    expect(fillText).toHaveBeenCalledWith(expect.stringContaining("Sub 2"), expect.any(Number), expect.any(Number))
    expect(fillText).toHaveBeenCalledWith(expect.stringContaining("TAG"), expect.any(Number), expect.any(Number))
    expect(fillText).toHaveBeenCalledWith(expect.stringContaining("Callout Line A"), expect.any(Number), expect.any(Number))
    expect(fillText).toHaveBeenCalledWith(expect.stringContaining("Callout Line B"), expect.any(Number), expect.any(Number))
  })
})
