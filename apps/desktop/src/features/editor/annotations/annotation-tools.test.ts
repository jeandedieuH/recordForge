import { describe, expect, it } from "vitest"
import { annotationClipSchema } from "@recordforge/contracts"
import {
  ANNOTATION_PRESETS,
  annotationPresetToShapePreset,
  createAnnotationClip,
  getAnnotationShapePreset,
} from "@recordforge/editor-core"
import {
  DEFAULT_ANNOTATION_DRAW_SETTINGS,
  annotationSettingsFromPreset,
  applyAnnotationToolToClip,
  createAnnotationFromTool,
  getAnnotationEditTime,
} from "./annotation-tools"

const canvas = { startMs: 1_234.6, canvasWidth: 1920, canvasHeight: 1080 }

describe("annotation tool creation", () => {
  it.each(ANNOTATION_PRESETS)("retains the complete $name preset when inserting", (record) => {
    const preset = annotationPresetToShapePreset(record)
    const settings = annotationSettingsFromPreset(preset)
    const clip = createAnnotationFromTool({ settings, ...canvas })
    expect(annotationClipSchema.safeParse(clip).success).toBe(true)
    expect(clip).toMatchObject({
      presetId: preset.presetId,
      annotationType: preset.type,
      strokeColor: preset.defaultStrokeColor,
      strokeStyle: preset.defaultStrokeStyle,
      strokeWidth: preset.defaultStrokeWidth,
      fillColor: preset.defaultFillColor,
      fillOpacity: preset.defaultFillOpacity,
      arrowStartHead: preset.defaultArrowStartHead,
      arrowEndHead: preset.defaultArrowEndHead,
      startMs: 1235,
      durationMs: 3500,
    })
    if (preset.overlayAnimation)
      expect(clip.overlayAnimation).toMatchObject(preset.overlayAnimation)
  })

  it("keeps the chosen shape when changing stroke settings", () => {
    const settings = {
      ...DEFAULT_ANNOTATION_DRAW_SETTINGS,
      preset: getAnnotationShapePreset("arrow"),
      strokeColor: "rebeccapurple",
      strokeWidth: 8,
      strokeStyle: "dotted" as const,
    }
    const clip = createAnnotationFromTool({ settings, ...canvas })
    expect(clip).toMatchObject({
      annotationType: "arrow",
      strokeColor: settings.strokeColor,
      strokeWidth: 8,
      strokeStyle: "dotted",
    })
    expect(clip.endX).toBe(clip.x + clip.width)
    expect(clip.endY).toBe(clip.y + clip.height)
  })

  it("reveals the placed annotation after its intro without changing clip timing", () => {
    const clip = createAnnotationFromTool({ settings: DEFAULT_ANNOTATION_DRAW_SETTINGS, ...canvas })
    expect(getAnnotationEditTime(clip)).toBe(clip.startMs + clip.overlayAnimation.inDurationMs)
    expect(clip.startMs).toBe(1235)
    expect(getAnnotationEditTime({ ...clip, durationMs: 100 })).toBe(clip.startMs + 50)
    expect(
      getAnnotationEditTime({
        ...clip,
        overlayAnimation: { ...clip.overlayAnimation, inType: "none" },
      }),
    ).toBe(clip.startMs)
  })

  it("fits a small canvas and gives repeated insertions independent identities", () => {
    const options = {
      settings: DEFAULT_ANNOTATION_DRAW_SETTINGS,
      startMs: 0,
      canvasWidth: 100,
      canvasHeight: 60,
    }
    const first = createAnnotationFromTool(options)
    const second = createAnnotationFromTool(options)
    expect(first.id).not.toBe(second.id)
    expect(first.x).toBeGreaterThanOrEqual(0)
    expect(first.y).toBeGreaterThanOrEqual(0)
    expect(first.x + first.width).toBeLessThanOrEqual(100)
    expect(first.y + first.height).toBeLessThanOrEqual(60)
  })
})

describe("explicit annotation restyling", () => {
  it("preserves authored placement, timing and text without mutating the original", () => {
    const clip = {
      ...createAnnotationClip("callout", { x: 120, y: 85, width: 210, height: 90 }),
      text: "My note",
      rotation: 25,
      zIndex: 4,
      startMs: 2000,
    }
    const original = structuredClone(clip)
    const settings = annotationSettingsFromPreset(getAnnotationShapePreset("badge"))
    const result = applyAnnotationToolToClip({ clip, settings })
    expect(result).toMatchObject({
      id: clip.id,
      annotationType: "badge",
      x: 120,
      y: 85,
      width: 210,
      height: 90,
      rotation: 25,
      zIndex: 4,
      startMs: 2000,
      durationMs: clip.durationMs,
      text: "My note",
    })
    expect(clip).toEqual(original)
  })

  it("keeps backward arrow endpoints when applying an arrow preset", () => {
    const clip = createAnnotationClip("arrow", {
      x: 500,
      y: 300,
      endX: 200,
      endY: 100,
      width: 300,
      height: 200,
    })
    const settings = annotationSettingsFromPreset(getAnnotationShapePreset("arrow"))
    const result = applyAnnotationToolToClip({ clip, settings })
    expect(result.endX).toBe(200)
    expect(result.endY).toBe(100)
  })

  it("initializes endpoints when converting to an arrow and removes them for shapes", () => {
    const clip = createAnnotationClip("rectangle", { x: 50, y: 75, width: 100, height: 80 })
    const arrow = applyAnnotationToolToClip({
      clip,
      settings: annotationSettingsFromPreset(getAnnotationShapePreset("arrow")),
    })
    expect(arrow.endX).toBe(150)
    expect(arrow.endY).toBe(155)
    expect(arrow.arrowEndHead).toBe("arrow")
    const shape = applyAnnotationToolToClip({
      clip: arrow,
      settings: DEFAULT_ANNOTATION_DRAW_SETTINGS,
    })
    expect(shape.endX).toBeUndefined()
    expect(shape.endY).toBeUndefined()
  })
})
