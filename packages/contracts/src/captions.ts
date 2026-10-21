import { z } from "zod"

// Caption files are normalized before they enter the timeline so preview and export
// share one timing model regardless of the source format.
export const captionFormatSchema = z.enum(["srt", "vtt"])
export type CaptionFormat = z.infer<typeof captionFormatSchema>

// Per-display-token timing carried by AI/imported cues. Times are RELATIVE
// to the containing cue's startMs (0-based) — the same base the layout
// engine's `input.words` contract uses.
export const captionWordTimingSchema = z.object({
  text: z.string().min(1),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
})
export type CaptionWordTiming = z.infer<typeof captionWordTimingSchema>

export const captionCueSchema = z.object({
  id: z.string().min(1),
  startMs: z.number().int().min(0),
  endMs: z.number().int().positive(),
  text: z.string().min(1).max(10_000),
  // Optional measured word timings (AI transcripts). Absent → the layout
  // engine derives highlight windows proportionally by character weight.
  words: z.array(captionWordTimingSchema).optional(),
  // Container-time provenance for each display token (absolute ms in the
  // recording asset — the coordinates each token was transcribed from, NOT
  // cue-relative). Present iff the cue is an unedited AI-derived caption;
  // Resync re-maps these through the current audio coverage without a
  // whisper re-run. Cleared together with `words` on text edits.
  sourceWords: z.array(captionWordTimingSchema).optional(),
  // Absolute ffprobe stream index of the audio stream the cue was
  // transcribed from — the resync coverage key.
  sourceStreamIndex: z.number().int().min(0).nullish(),
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
  vadReady: z.boolean(),
})
export type AiCaptionsStatus = z.infer<typeof aiCaptionsStatusSchema>

export const aiCaptionsSetupProgressSchema = z.object({
  stage: z.enum(["binary", "model"]),
  downloadedBytes: z.number().min(0),
  totalBytes: z.number().min(0),
})
export type AiCaptionsSetupProgress = z.infer<typeof aiCaptionsSetupProgressSchema>
export const AI_CAPTIONS_SETUP_EVENT = "ai-captions-setup"

// Word-level transcription (`transcribe_audio`) — times are in the recording
// asset's container timeline (the same base AudioClip.sourceInMs/sourceOutMs
// use), so words can be mapped onto the timeline without resampling.
export const transcriptWordSchema = z.object({
  text: z.string().min(1),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  spaceBefore: z.boolean(),
  confidence: z.number().min(0).max(1).optional(),
})
export type TranscriptWord = z.infer<typeof transcriptWordSchema>

export const transcriptSchema = z.object({
  language: z.string().min(1),
  model: z.string().min(1),
  streamIndex: z.number().int().min(0),
  durationMs: z.number().int().min(0),
  words: z.array(transcriptWordSchema),
  cached: z.boolean(),
})
export type Transcript = z.infer<typeof transcriptSchema>

export const transcribeRequestSchema = z.object({
  jobId: z.string().min(1),
  recordingId: z.string().min(1),
  model: z.string().min(1),
  language: z.string().regex(/^(auto|[a-z]{2,3})$/),
  streamIndex: z.number().int().min(0).optional(),
  force: z.boolean(),
})
export type TranscribeRequest = z.infer<typeof transcribeRequestSchema>

export const aiCaptionsProgressSchema = z.object({
  jobId: z.string().min(1),
  phase: z.enum(["preparing", "transcribing", "finalizing"]),
  percent: z.number().min(0).max(100),
})
export type AiCaptionsProgress = z.infer<typeof aiCaptionsProgressSchema>
export const AI_CAPTIONS_PROGRESS_EVENT = "ai-captions-progress"

// Preset ids are persisted on captions tracks — the four legacy ids keep
// working; their visuals are redesigned by the look catalogue in editor-core.
export const captionStylePresetSchema = z.enum([
  "default",
  "minimal",
  "boxed",
  "highlight",
  "pop",
  "focus",
])
export type CaptionStylePreset = z.infer<typeof captionStylePresetSchema>

export const captionPlacementSchema = z.enum(["top", "center", "bottom"])
export type CaptionPlacement = z.infer<typeof captionPlacementSchema>

// Track-level caption look: the shared layout engine (editor-core) resolves
// this into the px-level `CaptionLayout` consumed identically by the preview
// and the Rust ASS writer.
export const captionDesignSchema = z.object({
  preset: captionStylePresetSchema.default("default"),
  sizeScale: z.number().min(0.6).max(1.8).default(1),
  placement: captionPlacementSchema.default("bottom"),
  // Fraction of canvas height; positive moves captions down.
  offsetY: z.number().min(-0.4).max(0.4).default(0),
  // undefined = follow the look's default casing.
  uppercase: z.boolean().optional(),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
})
export type CaptionDesign = z.infer<typeof captionDesignSchema>
export const DEFAULT_CAPTION_DESIGN: CaptionDesign = {
  preset: "default",
  sizeScale: 1,
  placement: "bottom",
  offsetY: 0,
}

export const renderCaptionModeSchema = z.enum(["burn-in", "sidecar", "none"])
export type RenderCaptionMode = z.infer<typeof renderCaptionModeSchema>
