import { describe, expect, it, vi } from "vitest"
import { getAnnotationShapePreset } from "@recordforge/editor-core"
import { renderOverlayDisplayList } from "@recordforge/overlay-core"
import {
  createAnnotationDrawingClip,
  getAnnotationDrawingGeometry,
  getAnnotationDrawingPreview,
} from "./annotation-drawing"

function setupCanvas() {
  const path = {
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    closePath: vi.fn(),
    ellipse: vi.fn(),
  }
  const originalPath2D = (globalThis as unknown as { Path2D?: unknown }).Path2D
  ;(globalThis as unknown as { Path2D: unknown }).Path2D = vi.fn(function () {
    return path
  })
  const cleanup = () => {
    ;(globalThis as unknown as { Path2D?: unknown }).Path2D = originalPath2D
  }
  const context = {
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    setLineDash: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillRect: vi.fn(),
    globalAlpha: 1,
    lineWidth: 0,
  }
  const canvas = {
    width: 1920,
    height: 1080,
    getContext: () => context,
  } as unknown as HTMLCanvasElement
  return { canvas, context, path, cleanup }
}

describe("annotation drawing preview renderer", () => {
  it.each(["line", "arrow", "circle", "rectangle", "rounded-rect"] as const)(
    "renders a %s draft using its actual shape and stroke settings",
    (type) => {
      const { canvas, context, path, cleanup } = setupCanvas()
      const preset = getAnnotationShapePreset(type)
      const bounds = { width: 1920, height: 1080 }
      const clip = createAnnotationDrawingClip(
        {
          preset,
          strokeColor: "red",
          strokeWidth: 6,
          strokeStyle: "dashed",
          arrowStyle: "straight",
        },
        0,
        bounds,
      )
      const geometry = getAnnotationDrawingGeometry(
        type,
        { x: 100, y: 100 },
        { x: 300, y: 200 },
        bounds,
      )!
      const preview = getAnnotationDrawingPreview({ ...clip, ...geometry })
      renderOverlayDisplayList({ timeMs: 0, items: [preview] }, canvas)

      expect(context.clearRect).toHaveBeenCalledWith(0, 0, 1920, 1080)
      expect(context.lineWidth).toBe(6)
      expect(context.setLineDash).toHaveBeenCalledWith([24, 18])
      expect(context.fillRect).not.toHaveBeenCalled()
      if (type === "line" || type === "arrow") {
        expect(context.lineTo).toHaveBeenCalled()
        expect(path.quadraticCurveTo).not.toHaveBeenCalled()
        expect(path.ellipse).not.toHaveBeenCalled()
        if (type === "arrow") expect(context.fill).toHaveBeenCalled()
      } else if (type === "circle") {
        expect(path.ellipse).toHaveBeenCalledWith(200, 150, 100, 50, 0, 0, Math.PI * 2)
        expect(path.quadraticCurveTo).not.toHaveBeenCalled()
      } else {
        const radius = type === "rounded-rect" ? Math.min(preset.defaultCornerRadius, 50) : 0
        expect(path.moveTo).toHaveBeenCalledWith(100 + radius, 100)
        expect(path.quadraticCurveTo).toHaveBeenCalledWith(300, 100, 300, 100 + radius)
        expect(path.ellipse).not.toHaveBeenCalled()
      }
      cleanup()
    },
  )
})
