import { z } from "zod"

// Stream kind reported by FFprobe.
export const mediaStreamKindSchema = z.enum(["video", "audio", "subtitle", "data", "attachment"])
export type MediaStreamKind = z.infer<typeof mediaStreamKindSchema>

// Individual media stream from FFprobe.
export const mediaStreamSchema = z.object({
  index: z.number().int().min(0),
  kind: mediaStreamKindSchema,
  codec: z.string(),
  codecLongName: z.string().optional(),
  width: z.number().int().min(0).optional(),
  height: z.number().int().min(0).optional(),
  fps: z.number().min(0).optional(),
  bitrateKbps: z.number().min(0).optional(),
  sampleRate: z.number().int().min(0).optional(),
  channels: z.number().int().min(0).optional(),
  channelLayout: z.string().optional(),
  language: z.string().optional(),
})

export type MediaStream = z.infer<typeof mediaStreamSchema>

// Container format metadata from FFprobe.
export const mediaFormatSchema = z.object({
  name: z.string(),
  durationMs: z.number().int().min(0).optional(),
  sizeBytes: z.number().int().min(0).optional(),
  bitrateKbps: z.number().min(0).optional(),
})

export type MediaFormat = z.infer<typeof mediaFormatSchema>

// Cached media metadata for a recording.
export const mediaMetadataSchema = z.object({
  recordingId: z.string(),
  path: z.string(),
  durationMs: z.number().int().min(0),
  width: z.number().int().min(1).optional(),
  height: z.number().int().min(1).optional(),
  fps: z.number().min(0).optional(),
  hasAudio: z.boolean().default(false),
  videoCodec: z.string().optional(),
  audioCodec: z.string().optional(),
  bitrateKbps: z.number().min(0).optional(),
  streams: z.array(mediaStreamSchema).default([]),
  format: mediaFormatSchema.optional(),
  updatedAt: z.string().datetime(),
})

export type MediaMetadata = z.infer<typeof mediaMetadataSchema>

// Generated derivative file tracked for cleanup and recreation.
export const derivativeFileSchema = z.object({
  id: z.string(),
  recordingId: z.string(),
  jobId: z.string(),
  kind: z.enum(["proxy", "thumbnail", "waveform", "metadata"]),
  path: z.string(),
  sizeBytes: z.number().int().min(0).default(0),
  createdAt: z.string().datetime(),
})

export type DerivativeFile = z.infer<typeof derivativeFileSchema>

// Media job lifecycle status.
export const mediaJobStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
])

export type MediaJobStatus = z.infer<typeof mediaJobStatusSchema>

// Media job kind.
export const mediaJobKindSchema = z.enum([
  "metadata",
  "proxy",
  "thumbnail",
  "waveform",
  "prepare",
  "export",
])

export type MediaJobKind = z.infer<typeof mediaJobKindSchema>

// Progress payload emitted for a running or finished job.
export const mediaJobProgressSchema = z.object({
  jobId: z.string(),
  recordingId: z.string(),
  status: mediaJobStatusSchema,
  progress: z.number().min(0).max(1).default(0),
  stage: z.string(),
  message: z.string().optional(),
  updatedAt: z.string().datetime(),
})

export type MediaJobProgress = z.infer<typeof mediaJobProgressSchema>

// Output files produced by a prepare job.
export const mediaJobOutputsSchema = z.object({
  metadataPath: z.string().optional(),
  proxyPath: z.string().optional(),
  thumbnailDir: z.string().optional(),
  thumbnailManifestPath: z.string().optional(),
  waveformPath: z.string().optional(),
  waveformImagePath: z.string().optional(),
  outputPath: z.string().optional(),
})

export type MediaJobOutputs = z.infer<typeof mediaJobOutputsSchema>

// Media job record stored in SQLite and returned to the UI.
export const mediaJobSchema = z.object({
  id: z.string(),
  recordingId: z.string(),
  kind: mediaJobKindSchema,
  status: mediaJobStatusSchema,
  progress: z.number().min(0).max(1).default(0),
  stage: z.string(),
  message: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  outputs: mediaJobOutputsSchema.default({}),
})

export type MediaJob = z.infer<typeof mediaJobSchema>

// Options for starting a prepare job.
export const prepareMediaOptionsSchema = z.object({
  recordingId: z.string(),
  // Proxy resolution. Defaults to a 540p variant for smooth editing.
  proxyHeight: z.number().int().min(180).max(1080).default(540),
  // Seconds between extracted thumbnails.
  thumbnailIntervalSec: z.number().int().min(1).max(60).default(5),
  // Whether to recreate files that already exist.
  force: z.boolean().default(false),
})

export type PrepareMediaOptions = z.infer<typeof prepareMediaOptionsSchema>

// Disk-space estimate returned before a job starts.
export const diskSpaceEstimateSchema = z.object({
  bytesRequired: z.number().int().min(0),
  bytesAvailable: z.number().int().min(0),
  bytesFreeAfter: z.number().int().min(0),
  safe: z.boolean(),
})

export type DiskSpaceEstimate = z.infer<typeof diskSpaceEstimateSchema>

// Thumbnail sprite manifest written by the thumbnail generator.
export const thumbnailManifestSchema = z.object({
  spritePath: z.string(),
  columns: z.number().int().min(1),
  rows: z.number().int().min(1),
  count: z.number().int().min(0),
  intervalMs: z.number().int().min(0),
  thumbWidth: z.number().int().min(1),
  thumbHeight: z.number().int().min(1),
})

export type ThumbnailManifest = z.infer<typeof thumbnailManifestSchema>

// Compact waveform peak data.
export const waveformDataSchema = z.object({
  sampleRate: z.number().int().min(1),
  samplesPerPeak: z.number().int().min(1),
  peaks: z.array(z.number()),
  durationMs: z.number().int().min(0),
  imagePath: z.string().optional(),
})

export type WaveformData = z.infer<typeof waveformDataSchema>

// Summary of prepared media for a recording.
export const preparedMediaSchema = z.object({
  recordingId: z.string(),
  metadata: mediaMetadataSchema,
  outputs: mediaJobOutputsSchema,
  job: mediaJobSchema,
})

export type PreparedMedia = z.infer<typeof preparedMediaSchema>
