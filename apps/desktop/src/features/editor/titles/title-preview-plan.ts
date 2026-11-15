import { overlayRenderPlanSchema, type OverlayRenderPlan } from "@recordforge/contracts"
import {
  applyTextPresetToClip,
  createTextClipFromDefinition,
  textPresetToDefinition,
  type TextClip,
  type TextPresetRecord,
} from "@recordforge/editor-core"

export interface TitleReplaceOptions {
  preserveLayout?: boolean
  preserveStyle?: boolean
}

export const TITLE_PREVIEW_DURATION_MS = 4000
export const TITLE_PREVIEW_STILL_MS = 1600

/**
 * A point inside the clip where the title is actually visible. Designed titles
 * choreograph their entrance from zero opacity, so adding or replacing one at
 * the playhead's exact start can otherwise look like nothing happened.
 */
export function getTitleEditTime(clip: TextClip): number {
  const design = clip.titleDesign
  const designIntro = design && design.motion !== "none" ? 720 / design.tempo : 0
  const overlayIntro =
    clip.overlayAnimation.inType === "none" ? 0 : clip.overlayAnimation.inDurationMs
  const intro = Math.max(designIntro, overlayIntro)
  return clip.startMs + Math.min(Math.ceil(intro), Math.floor(clip.durationMs / 2))
}

/** Keep the full project coordinate space; only the output canvas is downsampled. */
export function createTitlePreviewPlan({
  preset,
  previewClip,
  canvasWidth = 1920,
  canvasHeight = 1080,
  options,
}: {
  preset: TextPresetRecord
  previewClip?: TextClip
  canvasWidth?: number
  canvasHeight?: number
  options?: TitleReplaceOptions
}): OverlayRenderPlan {
  const definition = textPresetToDefinition(preset)
  const clip = previewClip
    ? applyTextPresetToClip(previewClip, definition, {
        ...options,
        canvasWidth,
        canvasHeight,
      })
    : createTextClipFromDefinition(definition, {
        id: `preview-${preset.id}`,
        canvasWidth,
        canvasHeight,
        durationMs: TITLE_PREVIEW_DURATION_MS,
      })

  return overlayRenderPlanSchema.parse({
    canvas: { width: canvasWidth, height: canvasHeight },
    items: [
      {
        ...clip,
        startMs: 0,
        endMs: previewClip?.durationMs ?? TITLE_PREVIEW_DURATION_MS,
        enabled: true,
        animation: clip.overlayAnimation,
        transform: {
          x: clip.x,
          y: clip.y,
          width: clip.width,
          height: clip.height,
          rotation: clip.rotation,
          anchorX: clip.anchorX,
          anchorY: clip.anchorY,
          zIndex: clip.zIndex,
          opacity: clip.opacity,
        },
      },
    ],
  })
}
