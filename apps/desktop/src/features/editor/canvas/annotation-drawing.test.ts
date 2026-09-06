import { describe, expect, it } from "vitest"
import { annotationClipSchema, overlayDisplayAnnotationSchema } from "@recordforge/contracts"
import { ANNOTATION_SHAPES, createAnnotationClipFromPreset } from "@recordforge/editor-core"
import {
  createAnnotationDrawingClip,
  getAnnotationDrawingGeometry,
  getAnnotationDrawingPreview,
} from "./annotation-drawing"

const bounds = { width: 1920, height: 1080 }
const start = { x: 200, y: 200 }

describe("annotation drawing geometry", () => {
  it.each(["line", "arrow"] as const)("keeps axis-aligned %s bounds schema-positive", (type) => {
    for (const end of [
      { x: 500, y: 200 },
      { x: 200, y: 500 },
      { x: 50, y: 200 },
      { x: 200, y: 50 },
    ]) {
      const geometry = getAnnotationDrawingGeometry(type, start, end, bounds)
      expect(geometry).toMatchObject({ x: 200, y: 200, endX: end.x, endY: end.y })
      expect(geometry!.width).toBeGreaterThan(0)
      expect(geometry!.height).toBeGreaterThan(0)
      const preset = ANNOTATION_SHAPES.find((shape) => shape.type === type)!
      const clip = createAnnotationDrawingClip(
        { preset, strokeColor: "red", strokeWidth: 4, strokeStyle: "solid" },
        0,
        bounds,
      )
      expect(annotationClipSchema.safeParse({ ...clip, ...geometry }).success).toBe(true)
    }
  })

  it("retains reversed arrow endpoints rather than normalizing its origin", () => {
    expect(getAnnotationDrawingGeometry("arrow", start, { x: 50, y: 80 }, bounds)).toEqual({
      x: 200,
      y: 200,
      width: 150,
      height: 120,
      endX: 50,
      endY: 80,
    })
  })

  it.each(["rectangle", "rounded-rect", "circle", "callout", "badge", "spotlight"] as const)(
    "normalizes reversed %s boxes",
    (type) => {
      expect(getAnnotationDrawingGeometry(type, start, { x: 50, y: 80 }, bounds)).toEqual({
        x: 50,
        y: 80,
        width: 150,
        height: 120,
      })
    },
  )

  it("rejects clicks, tiny drags and flat boxes", () => {
    expect(getAnnotationDrawingGeometry("line", start, start, bounds)).toBeNull()
    expect(getAnnotationDrawingGeometry("arrow", start, { x: 203, y: 202 }, bounds)).toBeNull()
    expect(getAnnotationDrawingGeometry("rectangle", start, { x: 400, y: 202 }, bounds)).toBeNull()
    expect(getAnnotationDrawingGeometry("circle", start, { x: 400, y: 200 }, bounds)).toBeNull()
    expect(
      getAnnotationDrawingGeometry(
        "line",
        start,
        { x: 219, y: 200 },
        { ...bounds, minimumWidth: 20 },
      ),
    ).toBeNull()
  })

  it("constrains shapes to a square in every drag direction", () => {
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) {
        const geometry = getAnnotationDrawingGeometry(
          "circle",
          start,
          { x: 200 + sx * 80, y: 200 + sy * 40 },
          bounds,
          true,
        )!
        expect(geometry.width).toBe(80)
        expect(geometry.height).toBe(80)
        expect(geometry.x).toBe(sx < 0 ? 120 : 200)
        expect(geometry.y).toBe(sy < 0 ? 120 : 200)
      }
  })

  it("snaps lines to 45-degree increments and keeps constraints at edges", () => {
    const diagonal = getAnnotationDrawingGeometry("line", start, { x: 280, y: 250 }, bounds, true)!
    expect(diagonal.endX! - start.x).toBeCloseTo(diagonal.endY! - start.y)
    const horizontal = getAnnotationDrawingGeometry(
      "line",
      start,
      { x: 280, y: 210 },
      bounds,
      true,
    )!
    expect(horizontal.endY).toBe(start.y)
    const edge = getAnnotationDrawingGeometry(
      "rectangle",
      { x: 1900, y: 1000 },
      { x: 1920, y: 1080 },
      bounds,
      true,
    )!
    expect(edge).toEqual({ x: 1900, y: 1000, width: 20, height: 20 })
    const edgeLine = getAnnotationDrawingGeometry(
      "arrow",
      { x: 1900, y: 1000 },
      { x: 1920, y: 1030 },
      bounds,
      true,
    )!
    expect(edgeLine.endX).toBeCloseTo(1920)
    expect(edgeLine.endY).toBeCloseTo(1020)
  })

  it("clamps captured pointers outside the canvas and rejects invalid coordinates", () => {
    expect(getAnnotationDrawingGeometry("rectangle", start, { x: -20, y: -30 }, bounds)).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 200,
    })
    expect(getAnnotationDrawingGeometry("line", start, { x: NaN, y: 20 }, bounds)).toBeNull()
  })
})

describe("annotation drawing preset and preview", () => {
  it.each(ANNOTATION_SHAPES)("preserves the full $name preset with stroke overrides", (preset) => {
    const settings = { preset, strokeColor: "red", strokeWidth: 7, strokeStyle: "dotted" as const }
    const clip = createAnnotationDrawingClip(settings, 1234.6, bounds)
    const expected = createAnnotationClipFromPreset(preset, {
      id: clip.id,
      startMs: 1235,
      durationMs: 3500,
      strokeColor: "red",
      strokeWidth: 7,
      canvasWidth: bounds.width,
      canvasHeight: bounds.height,
    })
    expect(clip).toEqual({ ...expected, strokeStyle: "dotted" })
    const geometry = getAnnotationDrawingGeometry(preset.type, start, { x: 450, y: 360 }, bounds)!
    const drawn = { ...clip, ...geometry }
    expect(annotationClipSchema.safeParse(drawn).success).toBe(true)
    const preview = getAnnotationDrawingPreview(drawn)
    expect(overlayDisplayAnnotationSchema.safeParse(preview).success).toBe(true)
    expect(preview).toMatchObject({
      annotationType: preset.type,
      strokeColor: "red",
      strokeWidth: 7,
      strokeStyle: "dotted",
      arrowStartHead: preset.defaultArrowStartHead,
      arrowEndHead: preset.defaultArrowEndHead,
      cornerRadius: preset.defaultCornerRadius,
      fillColor: preset.defaultFillColor,
      fillOpacity: preset.defaultFillOpacity,
      drawProgress: 1,
      animationProgress: 1,
      transform: { x: drawn.x, y: drawn.y, width: drawn.width, height: drawn.height },
    })
  })
})
