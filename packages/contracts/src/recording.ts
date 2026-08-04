import { z } from "zod"

// Pixel dimensions used by capture sources, regions, and output profiles.
export const boundsSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
})

export type Bounds = z.infer<typeof boundsSchema>

// Recording source options for screen capture.
export const captureSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("display"),
    id: z.string(),
    name: z.string(),
    bounds: boundsSchema,
  }),
  z.object({
    kind: z.literal("window"),
    id: z.string(),
    name: z.string(),
    bounds: boundsSchema,
  }),
  z.object({
    kind: z.literal("region"),
    id: z.string(),
    name: z.string(),
    bounds: boundsSchema,
  }),
])

export type CaptureSource = z.infer<typeof captureSourceSchema>

// Pre-defined recording profiles. These are tuned for low-end Windows 11
// hardware and map to concrete FFmpeg/libx264/encoder settings in Rust.
export const recordingProfileSchema = z.object({
  id: z.string(),
  label: z.string(),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  fps: z.number().int().min(1),
  videoBitrateKbps: z.number().int().min(1).optional(),
  crf: z.number().int().min(0).max(51).optional(),
  encoderPriority: z.array(z.string()).default(["libx264"]),
  audioCodec: z.string().default("aac"),
  audioBitrateKbps: z.number().int().min(1).default(128),
})

export type RecordingProfile = z.infer<typeof recordingProfileSchema>

// Audio device kinds supported during recording.
export const audioDeviceKindSchema = z.enum(["microphone", "system"])
export type AudioDeviceKind = z.infer<typeof audioDeviceKindSchema>

// Audio device description returned by Rust device enumeration.
export const audioDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: audioDeviceKindSchema,
  isDefault: z.boolean().default(false),
})

export type AudioDevice = z.infer<typeof audioDeviceSchema>

// Video device description returned by Rust device enumeration (e.g., webcam).
export const videoDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.literal("webcam"),
  isDefault: z.boolean().default(false),
})

export type VideoDevice = z.infer<typeof videoDeviceSchema>

export const recordingConfigSchema = z.object({
  source: captureSourceSchema,
  profile: z.enum(["low-impact", "balanced", "smooth-demo", "high-quality", "camera-only"]),
  captureMicrophone: z.boolean(),
  captureSystemAudio: z.boolean(),
  captureWebcam: z.boolean(),
  webcamDeviceId: z.string().nullish(),
  microphoneDeviceId: z.string().nullish(),
  systemAudioDeviceId: z.string().nullish(),
})

export type RecordingConfig = z.infer<typeof recordingConfigSchema>

export const recorderStateSchema = z.enum([
  "idle",
  "selecting-source",
  "configuring",
  "countdown",
  "recording",
  "paused",
  "finalizing",
  "completed",
  "failed",
  "recovering",
  "recovery-required",
])

export type RecorderState = z.infer<typeof recorderStateSchema>

// Status payload broadcast from the Rust recorder to the React UI.
export const recordingStatusSchema = z.object({
  sessionId: z.string(),
  state: recorderStateSchema,
  startedAt: z.string().datetime({ offset: true }).nullish(),
  stoppedAt: z.string().datetime({ offset: true }).nullish(),
  durationMs: z.number().int().min(0).default(0),
  recordedMs: z.number().int().min(0).default(0),
  error: z.string().nullish(),
})

export type RecordingStatus = z.infer<typeof recordingStatusSchema>

// A user-defined marker placed during a recording session.
export const recordingMarkerSchema = z.object({
  id: z.string(),
  label: z.string(),
  timestampMs: z.number().int().min(0),
  createdAt: z.string().datetime({ offset: true }),
})

export type RecordingMarker = z.infer<typeof recordingMarkerSchema>

// Per-fragment metadata. Fragments are short, independently finalizable
// chunks of a recording so that a crash only loses the last chunk.
export const recordingFragmentSchema = z.object({
  index: z.number().int().min(0),
  fileName: z.string(),
  startedAt: z.string().datetime({ offset: true }),
  stoppedAt: z.string().datetime({ offset: true }).optional(),
  durationMs: z.number().int().min(0).optional(),
  // Size in bytes once the fragment has been finalized.
  sizeBytes: z.number().int().min(0).optional(),
  // Whether the fragment passed basic media validity checks.
  validated: z.boolean().default(false),
})

export type RecordingFragment = z.infer<typeof recordingFragmentSchema>

// The on-disk manifest for a single recording session. It is written
// incrementally so that recovery can reconstruct as much as possible.
export const recordingManifestSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  state: recorderStateSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  // Redacted copy of the source and profile for recovery UI.
  source: captureSourceSchema,
  profileName: z.string(),
  // Working directory where fragments and the final output live.
  workDir: z.string(),
  // Final output path; may be absent until finalization completes.
  outputPath: z.string().optional(),
  fragments: z.array(recordingFragmentSchema),
  markers: z.array(recordingMarkerSchema).default([]),
  // Total accumulated recorded time in milliseconds (used for pause/resume).
  totalRecordedMs: z.number().int().min(0).default(0),
  // Optional FFmpeg process statistics captured at stop time.
  stats: z
    .object({
      framesProcessed: z.number().int().min(0).optional(),
      fps: z.number().optional(),
      speed: z.number().optional(),
      exitCode: z.number().int().optional(),
    })
    .optional(),
})

export type RecordingManifest = z.infer<typeof recordingManifestSchema>

// Description of a detected H.264/HEVC encoder available to FFmpeg.
export const encoderInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  codec: z.string(),
  // Hardware-backed encoders report their vendor (nvidia, intel, amd, microsoft).
  vendor: z.string().optional(),
  // Whether the encoder is currently usable on this machine.
  available: z.boolean(),
  // Human-readable reason if the encoder is unavailable.
  reason: z.string().optional(),
  // Bitrate/cqp/crf support flags.
  supportsCbr: z.boolean().default(false),
  supportsCrf: z.boolean().default(false),
  supportsCqp: z.boolean().default(false),
})

export type EncoderInfo = z.infer<typeof encoderInfoSchema>

// Result of a single encoder benchmark run.
export const encoderBenchmarkResultSchema = z.object({
  encoderId: z.string(),
  profileId: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  fps: z.number().int(),
  durationSec: z.number(),
  framesProcessed: z.number().int(),
  avgFps: z.number(),
  speed: z.number(),
  // Estimated based on output file size / duration.
  bitrateKbps: z.number().optional(),
  // CPU utilization percentage observed during the run.
  cpuPercent: z.number().optional(),
  // Memory working set in MB.
  memoryMb: z.number().optional(),
  // Error message if the benchmark failed.
  error: z.string().optional(),
})

export type EncoderBenchmarkResult = z.infer<typeof encoderBenchmarkResultSchema>

// Runtime statistics returned when a recording stops.
export const recordingStatsSchema = z.object({
  framesProcessed: z.number().int().min(0).optional(),
  fps: z.number().optional(),
  speed: z.number().optional(),
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().min(0).default(0),
  outputSizeBytes: z.number().int().min(0).default(0),
})

export type RecordingStats = z.infer<typeof recordingStatsSchema>

// Result of a recovery scan for a force-quit or crashed session.
export const recoveryScanResultSchema = z.object({
  sessionId: z.string(),
  state: recorderStateSchema,
  manifestPath: z.string(),
  outputPath: z.string().optional(),
  outputSizeBytes: z.number().int().min(0).default(0),
  isRecoverable: z.boolean(),
  validationError: z.string().optional(),
})

export type RecoveryScanResult = z.infer<typeof recoveryScanResultSchema>

// Aggregate benchmark report used to choose the default profile/encoder.
export const benchmarkReportSchema = z.object({
  id: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  platform: z.object({
    os: z.string(),
    ffmpegVersion: z.string(),
    cpu: z.string().optional(),
    memoryMb: z.number().int().optional(),
  }),
  results: z.array(encoderBenchmarkResultSchema),
  recommendation: z.object({
    profileId: z.string(),
    encoderId: z.string(),
    reason: z.string(),
  }),
})

export type BenchmarkReport = z.infer<typeof benchmarkReportSchema>

// Library recording status. Reflects the lifecycle of a finished recording.
export const libraryRecordingStatusSchema = z.enum([
  "recording",
  "paused",
  "completed",
  "recovered",
  "trashed",
])

export type LibraryRecordingStatus = z.infer<typeof libraryRecordingStatusSchema>

// Recording entry as shown in the local library.
export const libraryRecordingSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  name: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  durationMs: z.number().int().min(0).default(0),
  sizeBytes: z.number().int().min(0).default(0),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  fps: z.number().int().min(1),
  status: libraryRecordingStatusSchema,
  tags: z.array(z.string()).default([]),
  source: captureSourceSchema,
  profileName: z.string(),
  outputPath: z.string().nullish(),
  workDir: z.string(),
  thumbnailPath: z.string().nullish(),
  markers: z.array(recordingMarkerSchema).default([]),
})

export type LibraryRecording = z.infer<typeof libraryRecordingSchema>

// Options for trimming a completed recording.
export const trimOptionsSchema = z.object({
  recordingId: z.string(),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
})

export type TrimOptions = z.infer<typeof trimOptionsSchema>

// Options for exporting a completed recording to a user-selected location.
export const exportOptionsSchema = z.object({
  recordingId: z.string(),
  outputPath: z.string(),
})

export type ExportOptions = z.infer<typeof exportOptionsSchema>

// Device and encoder diagnostics report shown in the settings/diagnostics view.
export const diagnosticsReportSchema = z.object({
  platform: z.object({
    os: z.string(),
    ffmpegVersion: z.string(),
    cpu: z.string().optional(),
    memoryMb: z.number().int().optional(),
  }),
  encoders: z.array(encoderInfoSchema),
  audioDevices: z.array(audioDeviceSchema),
  videoDevices: z.array(videoDeviceSchema),
})

export type DiagnosticsReport = z.infer<typeof diagnosticsReportSchema>
