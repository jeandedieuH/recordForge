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

// AI Captions (Pro) — whisper.cpp engine readiness + setup progress.
// Models are multilingual ggml weights downloaded on demand; several can
// coexist so the status reports each one's availability.
export const aiCaptionsModelSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  sizeBytes: z.number().min(0),
  downloaded: z.boolean(),
})
export type AiCaptionsModel = z.infer<typeof aiCaptionsModelSchema>

export const aiCaptionsStatusSchema = z.object({
  supported: z.boolean(),
  binaryReady: z.boolean(),
  models: z.array(aiCaptionsModelSchema),
  ready: z.boolean(),
})
export type AiCaptionsStatus = z.infer<typeof aiCaptionsStatusSchema>

export const aiCaptionsSetupProgressSchema = z.object({
  stage: z.enum(["binary", "model"]),
  downloadedBytes: z.number().min(0),
  totalBytes: z.number().min(0),
})
export type AiCaptionsSetupProgress = z.infer<typeof aiCaptionsSetupProgressSchema>
export const AI_CAPTIONS_SETUP_EVENT = "ai-captions-setup"

/** Virtual-background segmentation model status (export-side). */
export const virtualBackgroundStatusSchema = z.object({
  supported: z.boolean(),
  modelReady: z.boolean(),
})
export type VirtualBackgroundStatus = z.infer<typeof virtualBackgroundStatusSchema>

export const virtualBackgroundDownloadProgressSchema = z.object({
  downloadedBytes: z.number().min(0),
  totalBytes: z.number().min(0),
})
export type VirtualBackgroundDownloadProgress = z.infer<
  typeof virtualBackgroundDownloadProgressSchema
>
export const VIRTUAL_BACKGROUND_DOWNLOAD_EVENT = "virtual-background-download"

export const captionStylePresetSchema = z.enum(["default", "minimal", "boxed", "highlight"])
export type CaptionStylePreset = z.infer<typeof captionStylePresetSchema>

export const captionPlacementSchema = z.enum(["top", "center", "bottom"])
export type CaptionPlacement = z.infer<typeof captionPlacementSchema>

export const renderCaptionModeSchema = z.enum(["burn-in", "sidecar", "none"])
export type RenderCaptionMode = z.infer<typeof renderCaptionModeSchema>
