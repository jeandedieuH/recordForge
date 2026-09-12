import type {
  AnnotationArrowStyle,
  AnnotationClip,
  AnnotationStrokeStyle,
} from "@recordforge/contracts"
import {
  ANNOTATION_PALETTES,
  applyPresetToAnnotationClip,
  calloutDefaultTarget,
  createAnnotationClipFromPreset,
  getAnnotationShapePreset,
  type AnnotationShapePreset,
} from "@recordforge/editor-core"

export interface AnnotationDrawSettings {
  preset: AnnotationShapePreset
  strokeColor: string
  strokeWidth: number
  strokeStyle: AnnotationStrokeStyle
  arrowStyle: AnnotationArrowStyle
}

export const DEFAULT_ANNOTATION_DRAW_SETTINGS: AnnotationDrawSettings = {
  preset: getAnnotationShapePreset("rectangle"),
  strokeColor: ANNOTATION_PALETTES[0].color,
  strokeWidth: 4,
  strokeStyle: "solid",
  arrowStyle: "straight",
}

export function annotationSettingsFromPreset(
  preset: AnnotationShapePreset,
): AnnotationDrawSettings {
  return {
    preset,
    strokeColor: preset.defaultStrokeColor,
    strokeWidth: preset.defaultStrokeWidth,
    strokeStyle: preset.defaultStrokeStyle,
    arrowStyle: preset.defaultArrowStyle ?? "straight",
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
      arrowStyle: settings.arrowStyle,
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
  const isCallout = updated.annotationType === "callout"
  const wasLine = clip.annotationType === "arrow" || clip.annotationType === "line"

  const endX = clip.endX ?? clip.x + clip.width
  const endY = clip.endY ?? clip.y + clip.height
  const becomesBox = wasLine && !isLine
  const { preset } = settings
  const outro =
    preset.animationOut === "draw" || preset.animationOut === "scale-up"
      ? "scale-down"
      : preset.animationOut

  const nextX = becomesBox ? Math.min(clip.x, endX) : clip.x
  const nextY = becomesBox ? Math.min(clip.y, endY) : clip.y
  const nextWidth = becomesBox ? Math.max(10, Math.abs(endX - clip.x)) : clip.width
  const nextHeight = becomesBox ? Math.max(10, Math.abs(endY - clip.y)) : clip.height
  // Callouts keep an authored leader target, or gain a default one below the box.
  const calloutTarget = isCallout
    ? calloutDefaultTarget(nextX, nextY, nextWidth, nextHeight)
    : undefined

  // Restyling must not undo the user's placement, timing, or authored text.
  return {
    ...updated,
    x: nextX,
    y: nextY,
    width: nextWidth,
    height: nextHeight,
    rotation: clip.rotation,
    anchorX: clip.anchorX,
    anchorY: clip.anchorY,
    zIndex: clip.zIndex,
    endX: isLine
      ? wasLine
        ? endX
        : clip.x + clip.width
      : isCallout
        ? (clip.endX ?? calloutTarget?.x)
        : undefined,
    endY: isLine
      ? wasLine
        ? endY
        : clip.y + clip.height
      : isCallout
        ? (clip.endY ?? calloutTarget?.y)
        : undefined,
    text: clip.text ?? updated.text,
    strokeColor: settings.strokeColor,
    strokeWidth: settings.strokeWidth,
    strokeStyle: settings.strokeStyle,
    arrowStyle: settings.arrowStyle,
    overlayAnimation: {
      ...clip.overlayAnimation,
      ...(preset.animationIn !== undefined ? { inType: preset.animationIn } : {}),
      ...(outro !== undefined ? { outType: outro } : {}),
      ...preset.overlayAnimation,
    },
  }
}

export function getAnnotationEditTime(clip: AnnotationClip): number {
  // Reveal the placed shape instead of leaving it on the transparent first intro frame.
  const intro = clip.overlayAnimation.inType === "none" ? 0 : clip.overlayAnimation.inDurationMs
  return clip.startMs + Math.min(intro, Math.floor(clip.durationMs / 2))
}
