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
    ? applyTextPresetToClip(previewClip, definition, options)
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
