import { z } from "zod"

// Stream kind reported by FFprobe.
export const mediaStreamKindSchema = z.enum(["video", "audio", "subtitle", "data", "attachment"])
export type MediaStreamKind = z.infer<typeof mediaStreamKindSchema>

// Asset roles for the durable project asset registry.
// Each role maps a source file to a specific timeline purpose.
export const projectAssetRoleSchema = z.enum([
  "screen",
  "microphone",
  "system_audio",
  "music",
  "webcam",
  "cursor_events",
  "caption",
  "image",
])
export type ProjectAssetRole = z.infer<typeof projectAssetRoleSchema>

// Individual media stream from FFprobe.
export const mediaStreamSchema = z.object({
  index: z.number().int().min(0),
  kind: mediaStreamKindSchema,
  codec: z.string(),
  // FFmpeg stream metadata identifies the independently captured source.
  title: z.string().nullish(),
  startMs: z.number().int().min(0).nullish(),
  durationMs: z.number().int().min(0).nullish(),
  codecLongName: z.string().nullish(),
  width: z.number().int().min(0).nullish(),
  height: z.number().int().min(0).nullish(),
  fps: z.number().min(0).nullish(),
  bitrateKbps: z.number().min(0).nullish(),
  sampleRate: z.number().int().min(0).nullish(),
  channels: z.number().int().min(0).nullish(),
  channelLayout: z.string().nullish(),
  language: z.string().nullish(),
})

export type MediaStream = z.infer<typeof mediaStreamSchema>

// Container format metadata from FFprobe.
export const mediaFormatSchema = z.object({
  name: z.string(),
  durationMs: z.number().int().min(0).nullish(),
  sizeBytes: z.number().int().min(0).nullish(),
  bitrateKbps: z.number().min(0).nullish(),
})

export type MediaFormat = z.infer<typeof mediaFormatSchema>

// Cached media metadata for a recording.
export const mediaMetadataSchema = z.object({
  recordingId: z.string(),
  path: z.string(),
  durationMs: z.number().int().min(0),
  width: z.number().int().min(1).nullish(),
  height: z.number().int().min(1).nullish(),
  fps: z.number().min(0).nullish(),
  hasAudio: z.boolean().default(false),
  videoCodec: z.string().nullish(),
  audioCodec: z.string().nullish(),
  bitrateKbps: z.number().min(0).nullish(),
  streams: z.array(mediaStreamSchema).default([]),
  format: mediaFormatSchema.nullish(),
  updatedAt: z.string().datetime({ offset: true }),
})

export type MediaMetadata = z.infer<typeof mediaMetadataSchema>

// Generated derivative file tracked for cleanup and recreation.
export const derivativeFileSchema = z.object({
  id: z.string(),
  recordingId: z.string(),
  jobId: z.string(),
  kind: z.enum(["proxy", "thumbnail", "waveform", "metadata", "audio", "video"]),
  path: z.string(),
  sizeBytes: z.number().int().min(0).default(0),
  createdAt: z.string().datetime({ offset: true }),
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

export const ffmpegJobSpecSchema = z.object({
  kind: mediaJobKindSchema,
  inputPath: z.string(),
  outputPath: z.string(),
  args: z.array(z.string()),
})

export type FFmpegJobSpec = z.infer<typeof ffmpegJobSpecSchema>

// Progress payload emitted for a running or finished job.
export const mediaJobProgressSchema = z.object({
  jobId: z.string(),
  recordingId: z.string(),
  status: mediaJobStatusSchema,
  progress: z.number().min(0).max(1).default(0),
  stage: z.string(),
  message: z.string().nullish(),
  updatedAt: z.string().datetime({ offset: true }),
})

export type MediaJobProgress = z.infer<typeof mediaJobProgressSchema>

// One independently playable audio stream and its waveform assets.
export const mediaAudioTrackOutputSchema = z.object({
  streamIndex: z.number().int().min(0),
  title: z.string(),
  audioPath: z.string(),
  waveformPath: z.string(),
  waveformImagePath: z.string(),
})

export type MediaAudioTrackOutput = z.infer<typeof mediaAudioTrackOutputSchema>

// One independently playable secondary video stream for camera preview.
export const mediaVideoTrackOutputSchema = z.object({
  streamIndex: z.number().int().min(0),
  title: z.string(),
  videoPath: z.string(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
})

export type MediaVideoTrackOutput = z.infer<typeof mediaVideoTrackOutputSchema>

// Output files produced by a prepare job.
export const mediaJobOutputsSchema = z.object({
  prepareVersion: z.number().int().min(0).default(0),
  metadataPath: z.string().nullish(),
  proxyPath: z.string().nullish(),
  thumbnailDir: z.string().nullish(),
  thumbnailManifestPath: z.string().nullish(),
  waveformPath: z.string().nullish(),
  waveformImagePath: z.string().nullish(),
  audioTracks: z.array(mediaAudioTrackOutputSchema).default([]),
  videoTracks: z.array(mediaVideoTrackOutputSchema).default([]),
  outputPath: z.string().nullish(),
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
  message: z.string().nullish(),
  error: z.string().nullish(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).nullish(),
  completedAt: z.string().datetime({ offset: true }).nullish(),
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
  imagePath: z.string().nullish(),
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
