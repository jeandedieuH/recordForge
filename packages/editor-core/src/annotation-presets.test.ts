import { describe, expect, it } from "vitest"
import {
  annotationCanvasScale,
  annotationPresetFromClip,
  applyPresetToAnnotationClip,
  createAnnotationClipFromPreset,
  getAnnotationShapePreset,
  migrateAnnotationPresetDesignScale,
  scaleAnnotationPresetForCanvas,
} from "./annotation-presets"

describe("annotation preset canvas scaling", () => {
  it("keeps the authored 1080p geometry unchanged at 1920x1080", () => {
    const preset = getAnnotationShapePreset("rectangle")
    const clip = createAnnotationClipFromPreset(preset, {
      canvasWidth: 1920,
      canvasHeight: 1080,
    })
    expect(annotationCanvasScale(1920, 1080)).toBe(1)
    expect(clip.width).toBe(preset.defaultWidth)
    expect(clip.height).toBe(preset.defaultHeight)
    expect(clip.strokeWidth).toBe(preset.defaultStrokeWidth)
  })

  it("scales geometry, stroke and text with a 4K canvas", () => {
    const preset = getAnnotationShapePreset("callout")
    const scaled = scaleAnnotationPresetForCanvas(preset, 3840, 2160)
    const clip = createAnnotationClipFromPreset(preset, {
      canvasWidth: 3840,
      canvasHeight: 2160,
    })
    expect(annotationCanvasScale(3840, 2160)).toBe(2)
    expect(clip.width).toBeCloseTo(preset.defaultWidth * 2)
    expect(clip.height).toBeCloseTo(preset.defaultHeight * 2)
    expect(clip.strokeWidth).toBeCloseTo(preset.defaultStrokeWidth * 2)
    expect(clip.fontSize).toBeCloseTo((preset.fontSize ?? 16) * 2)
    expect(scaled.defaultWidth).toBeCloseTo(preset.defaultWidth * 2)
  })

  it("uses the short edge on portrait canvases so the preset keeps its relative size", () => {
    expect(annotationCanvasScale(1080, 1920)).toBeCloseTo(0.5625)
  })

  it("scales preset dimensions when restyling an existing clip", () => {
    const clip = createAnnotationClipFromPreset(getAnnotationShapePreset("rectangle"), {
      canvasWidth: 3840,
      canvasHeight: 2160,
    })
    const badge = getAnnotationShapePreset("badge")
    const result = applyPresetToAnnotationClip(clip, badge, {
      canvasWidth: 3840,
      canvasHeight: 2160,
    })
    expect(result.width).toBeCloseTo(badge.defaultWidth * 2)
    expect(result.height).toBeCloseTo(badge.defaultHeight * 2)
  })

  it("allows explicit project-pixel values to bypass preset scaling", () => {
    const clip = createAnnotationClipFromPreset(getAnnotationShapePreset("rectangle"), {
      canvasWidth: 3840,
      canvasHeight: 2160,
      width: 640,
      height: 360,
      strokeWidth: 12,
    })
    expect(clip.width).toBe(640)
    expect(clip.height).toBe(360)
    expect(clip.strokeWidth).toBe(12)
  })

  it("does not double-scale a custom preset saved from a 4K canvas", () => {
    const clip = createAnnotationClipFromPreset(getAnnotationShapePreset("callout"), {
      canvasWidth: 3840,
      canvasHeight: 2160,
    })
    const record = annotationPresetFromClip(clip, {
      name: "4K callout",
      description: "Saved at 4K",
      designScale: 2,
    })
    const recreated = createAnnotationClipFromPreset(
      { ...record.definition, name: record.name, description: record.description },
      { canvasWidth: 3840, canvasHeight: 2160 },
    )
    expect(recreated.width).toBeCloseTo(clip.width)
    expect(recreated.fontSize).toBeCloseTo(clip.fontSize)
    const at1080 = createAnnotationClipFromPreset(
      { ...record.definition, name: record.name, description: record.description },
      { canvasWidth: 1920, canvasHeight: 1080 },
    )
    expect(at1080.width).toBeCloseTo(clip.width / 2)
  })

  it("migrates a legacy custom preset from its authored geometry once", () => {
    const clip = createAnnotationClipFromPreset(getAnnotationShapePreset("callout"), {
      canvasWidth: 3840,
      canvasHeight: 2160,
    })
    const record = annotationPresetFromClip(clip, {
      name: "Legacy 4K callout",
      description: "Saved before designScale existed",
    })
    const legacy = { ...record.definition }
    delete legacy.designScale

    const migrated = migrateAnnotationPresetDesignScale(legacy, "custom-legacy-callout")
    expect(migrated.designScale).toBe(2)
    // Already at 4K: reuse must be identity, not another 2x scale.
    const recreated = createAnnotationClipFromPreset(
      { ...migrated, name: record.name, description: record.description },
      { canvasWidth: 3840, canvasHeight: 2160 },
    )
    expect(recreated.width).toBeCloseTo(clip.width)
    expect(recreated.height).toBeCloseTo(clip.height)
  })
})
