import type { AnnotationClip, AnnotationStrokeStyle } from "@recordforge/contracts"
import {
  ANNOTATION_PALETTES,
  applyPresetToAnnotationClip,
  createAnnotationClipFromPreset,
  getAnnotationShapePreset,
  type AnnotationShapePreset,
} from "@recordforge/editor-core"

export interface AnnotationDrawSettings {
  preset: AnnotationShapePreset
  strokeColor: string
  strokeWidth: number
  strokeStyle: AnnotationStrokeStyle
}

export const DEFAULT_ANNOTATION_DRAW_SETTINGS: AnnotationDrawSettings = {
  preset: getAnnotationShapePreset("rectangle"),
  strokeColor: ANNOTATION_PALETTES[0].color,
  strokeWidth: 4,
  strokeStyle: "solid",
}

export function annotationSettingsFromPreset(preset: AnnotationShapePreset): AnnotationDrawSettings {
  return {
    preset,
    strokeColor: preset.defaultStrokeColor,
    strokeWidth: preset.defaultStrokeWidth,
    strokeStyle: preset.defaultStrokeStyle,
  }
}

export function createAnnotationFromTool({
  settings,
  startMs,
  canvasWidth,
  canvasHeight,
}: {
  settings: AnnotationDrawSettings
  startMs: number
  canvasWidth: number
  canvasHeight: number
}): AnnotationClip {
  const width = Math.min(settings.preset.defaultWidth, canvasWidth)
  const height = Math.min(settings.preset.defaultHeight, canvasHeight)
  return {
    ...createAnnotationClipFromPreset(settings.preset, {
      startMs: Math.round(startMs),
      durationMs: 3_500,
      canvasWidth,
      canvasHeight,
      width,
      height,
      x: (canvasWidth - width) / 2,
      y: (canvasHeight - height) / 2,
      strokeColor: settings.strokeColor,
      strokeWidth: settings.strokeWidth,
    }),
    strokeStyle: settings.strokeStyle,
  }
}

export function applyAnnotationToolToClip({
  clip,
  settings,
}: {
  clip: AnnotationClip
  settings: AnnotationDrawSettings
}): AnnotationClip {
  const updated = applyPresetToAnnotationClip(clip, settings.preset)
  const isLine = updated.annotationType === "arrow" || updated.annotationType === "line"
  const wasLine = clip.annotationType === "arrow" || clip.annotationType === "line"

  // Restyling must not undo the user's placement, timing, or authored text.
  return {
    ...updated,
    width: clip.width,
    height: clip.height,
    rotation: clip.rotation,
    anchorX: clip.anchorX,
    anchorY: clip.anchorY,
    zIndex: clip.zIndex,
    endX: isLine ? (wasLine ? clip.endX : undefined) ?? clip.x + clip.width : undefined,
    endY: isLine ? (wasLine ? clip.endY : undefined) ?? clip.y + clip.height : undefined,
    text: clip.text || updated.text,
    strokeColor: settings.strokeColor,
    strokeWidth: settings.strokeWidth,
    strokeStyle: settings.strokeStyle,
  }
}
