import { z } from "zod"

// Caption files are normalized before they enter the timeline so preview and export
// share one timing model regardless of the source format.
export const captionFormatSchema = z.enum(["srt", "vtt"])
export type CaptionFormat = z.infer<typeof captionFormatSchema>

export const captionCueSchema = z.object({
  id: z.string().min(1),
  startMs: z.number().int().min(0),
  endMs: z.number().int().positive(),
  text: z.string().min(1).max(10_000),
})

export type CaptionCue = z.infer<typeof captionCueSchema>

export const captionStylePresetSchema = z.enum(["default", "minimal", "boxed", "highlight"])
export type CaptionStylePreset = z.infer<typeof captionStylePresetSchema>

export const captionPlacementSchema = z.enum(["top", "center", "bottom"])
export type CaptionPlacement = z.infer<typeof captionPlacementSchema>

export const renderCaptionModeSchema = z.enum(["burn-in", "sidecar", "none"])
export type RenderCaptionMode = z.infer<typeof renderCaptionModeSchema>
