import { describe, expect, it, vi } from "vitest"
import type { OverlayDisplayAnnotation } from "@recordforge/contracts"
import { renderOverlayDisplayList } from "./canvas-renderer"

if (typeof globalThis.Path2D === "undefined") {
  const globalWithPath2D = globalThis as unknown as { Path2D?: new () => Path2D }
  globalWithPath2D.Path2D = class {
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
  } as unknown as new () => Path2D
}

function canvasWithContext(clearRect: () => void): HTMLCanvasElement {
  return {
    width: 1920,
    height: 1080,
    getContext: () => ({ clearRect }),
  } as unknown as HTMLCanvasElement
}

function recordingCanvas(): { canvas: HTMLCanvasElement; calls: string[] } {
  const calls: string[] = []
  const n = (value: number) => Math.round(value * 100) / 100
  const record =
    (name: string) =>
    (...args: number[]) =>
      calls.push(`${name}(${args.map(n).join(",")})`)
  const context = {
    clearRect: () => {},
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    beginPath: () => calls.push("beginPath"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    quadraticCurveTo: record("quad"),
    arc: record("arc"),
    closePath: () => calls.push("closePath"),
    fill: () => calls.push("fill"),
    stroke: () => calls.push("stroke"),
    clip: () => {},
    setLineDash: () => {},
    translate: () => {},
    rotate: () => {},
    fillText: () => calls.push("fillText"),
    measureText: () => ({ width: 0 }),
    canvas: { width: 1920, height: 1080 },
  }
  const canvas = {
    width: 1920,
    height: 1080,
    getContext: () => context,
  } as unknown as HTMLCanvasElement
  return { canvas, calls }
}

function annotationItem(overrides: Partial<OverlayDisplayAnnotation>): OverlayDisplayAnnotation {
  return {
    kind: "annotation" as const,
    id: "annot-1",
    zIndex: 0,
    transform: {
      x: 100,
      y: 100,
      width: 200,
      height: 100,
      zIndex: 0,
      opacity: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    animationProgress: 1,
    drawProgress: 1,
    annotationType: "arrow",
    endX: 400,
    endY: 300,
    strokeColor: "#f43f5e",
    strokeWidth: 4,
    strokeStyle: "solid",
    fillColor: "#f43f5e",
    fillOpacity: 0,
    cornerRadius: 0,
    arrowEndHead: "arrow",
    arrowStartHead: "none",
    arrowStyle: "straight",
    shadowEnabled: false,
    shadowColor: "black",
    shadowBlur: 0,
    textColor: "#ffffff",
    fontSize: 16,
    ...overrides,
  }
}

describe("overlay canvas renderer", () => {
  it("routes an elbow arrow through a corner", () => {
    const { canvas, calls } = recordingCanvas()
    renderOverlayDisplayList(
      { timeMs: 100, items: [annotationItem({ arrowStyle: "elbow" })] },
      canvas,
    )

    // dx=300 > dy=200 → the connector runs horizontally first, then turns down.
    // The end segment is shortened 9.8px for the arrowhead (14px * 0.7).
    const start = calls.indexOf("moveTo(100,100)")
    expect(calls.slice(start, start + 4)).toEqual([
      "moveTo(100,100)",
      "lineTo(400,100)",
      "lineTo(400,290.2)",
      "stroke",
    ])
  })

  it("routes a curved arrow through a quadratic segment", () => {
    const { canvas, calls } = recordingCanvas()
    renderOverlayDisplayList(
      {
        timeMs: 100,
        items: [annotationItem({ arrowStyle: "curved", arrowEndHead: "none" })],
      },
      canvas,
    )

    const start = calls.indexOf("moveTo(100,100)")
    expect(calls.slice(start, start + 3)).toEqual([
      "moveTo(100,100)",
      "quad(400,100,400,300)",
      "stroke",
    ])
  })

  it("draws a callout leader to its target instead of the speech tail", () => {
    const { canvas, calls } = recordingCanvas()
    renderOverlayDisplayList(
      {
        timeMs: 100,
        items: [
          annotationItem({
            annotationType: "callout",
            arrowEndHead: "arrow",
            // Box 100,100 200x100; target below-right of the box.
            endX: 500,
            endY: 400,
          }),
        ],
      },
      canvas,
    )

    // The leader leaves the bubble's bottom edge at the border point (260,200)
    // and stops 9.8px short of the (500,400) tip for the arrowhead.
    const start = calls.indexOf("moveTo(260,200)")
    expect(start).toBeGreaterThanOrEqual(0)
    expect(calls[start + 1]).toBe("lineTo(492.47,393.73)")
  })

  it("keeps the speech tail for callouts without a target", () => {
    const { canvas, calls } = recordingCanvas()
    renderOverlayDisplayList(
      {
        timeMs: 100,
        items: [
          annotationItem({
            annotationType: "callout",
            arrowEndHead: "none",
            endX: undefined,
            endY: undefined,
          }),
        ],
      },
      canvas,
    )

    // Bubble and tail draw through Path2D fills; no connector path ops on ctx.
    expect(calls.filter((call) => call.startsWith("moveTo"))).toHaveLength(0)
    expect(calls.filter((call) => call === "fill")).toHaveLength(2)
  })

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
      clip: vi.fn(),
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
            transform: {
              x: 100,
              y: 100,
              width: 400,
              height: 200,
              zIndex: 1,
              opacity: 1,
              rotation: 0,
              anchorX: 0.5,
              anchorY: 0.5,
            },
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
            autoScaleText: true,
          },
          {
            kind: "annotation",
            id: "callout-multiline",
            zIndex: 2,
            transform: {
              x: 500,
              y: 100,
              width: 200,
              height: 120,
              zIndex: 2,
              opacity: 1,
              rotation: 0,
              anchorX: 0.5,
              anchorY: 0.5,
            },
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
            arrowStyle: "straight",
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
    expect(fillText).toHaveBeenCalledWith(
      expect.stringContaining("Line 1"),
      expect.any(Number),
      expect.any(Number),
    )
    expect(fillText).toHaveBeenCalledWith(
      expect.stringContaining("Line 2"),
      expect.any(Number),
      expect.any(Number),
    )
    expect(fillText).toHaveBeenCalledWith(
      expect.stringContaining("Line 3"),
      expect.any(Number),
      expect.any(Number),
    )
    expect(fillText).toHaveBeenCalledWith(
      expect.stringContaining("Sub 1"),
      expect.any(Number),
      expect.any(Number),
    )
    expect(fillText).toHaveBeenCalledWith(
      expect.stringContaining("Sub 2"),
      expect.any(Number),
      expect.any(Number),
    )
    expect(fillText).toHaveBeenCalledWith(
      expect.stringContaining("TAG"),
      expect.any(Number),
      expect.any(Number),
    )
    expect(fillText).toHaveBeenCalledWith(
      expect.stringContaining("Callout Line A"),
      expect.any(Number),
      expect.any(Number),
    )
    expect(fillText).toHaveBeenCalledWith(
      expect.stringContaining("Callout Line B"),
      expect.any(Number),
      expect.any(Number),
    )
  })
})
