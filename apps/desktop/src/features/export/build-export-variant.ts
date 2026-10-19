import type { AppError, CanvasAspectRatio, TimelineState } from "@recordforge/contracts"
import { canvasDimensionsForAspect } from "@recordforge/domain"
import { createEngine, createUpdateCanvasCommand, executeCommand } from "@recordforge/editor-core"
import type { CameraSourceSize } from "../editor/camera/camera-sources"

// Shared export-variant seam used by the processed preview now and the
// batch-export builder later: one canvas aspect per variant, built from a
// FROZEN timeline snapshot — the editor's engine/history is never touched.
export interface BuildExportVariantInput {
  readonly state: TimelineState
  readonly aspect: CanvasAspectRatio
  // Camera source sizes for the smart-layout reflow; pass the same
  // collectCameraSources output the live canvas switch uses.
  readonly cameraSources: Record<string, CameraSourceSize>
}

export type BuildExportVariantResult =
  { ok: true; value: TimelineState } | { ok: false; error: AppError }

/**
 * Produce the timeline state for one export aspect.
 *
 * IMPORTANT: when `aspect` is the current canvas aspect the state is
 * returned UNCHANGED — including odd or custom native canvas dimensions.
 * Normalizing "current" through `canvasDimensionsForAspect` would silently
 * re-crop a user's bespoke canvas, which is exactly what the existing batch
 * loop gets wrong.
 *
 * For an alternate aspect, the canvas switch reuses the tested
 * `createUpdateCanvasCommand` smart-layout reflow on a throwaway engine so
 * camera clips keep a correct source-space crop at the new frame size.
 */
export function buildExportVariant(input: BuildExportVariantInput): BuildExportVariantResult {
  const { state, aspect } = input
  const canvas = state.canvas
  const current = canvas.aspectRatio ?? "16:9"
  if (aspect === current) {
    return { ok: true, value: state }
  }
  const engine = createEngine(state)
  const result = executeCommand(
    engine,
    createUpdateCanvasCommand(
      {
        aspectRatio: aspect,
        ...canvasDimensionsForAspect(canvas, aspect),
      },
      { cameraSources: input.cameraSources },
    ),
  )
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, value: result.value.history.present }
}
