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
  videoBitrateKbps: z.number().int().min(1).nullish(),
  crf: z.number().int().min(0).max(51).nullish(),
  encoderPriority: z.array(z.string()).default(["libx264"]),
  audioCodec: z.string().default("aac"),
  audioBitrateKbps: z.number().int().min(1).default(128),
})

export type RecordingProfile = z.infer<typeof recordingProfileSchema>

export const recordingSmartZoomPresetSchema = z.enum([
  "subtle",
  "product-demo",
  "cinematic",
  "developer",
  "manual-only",
])
export type RecordingSmartZoomPreset = z.infer<typeof recordingSmartZoomPresetSchema>

export const recordingSmartZoomSchema = z.object({
  enabled: z.boolean(),
  preset: recordingSmartZoomPresetSchema,
})
export type RecordingSmartZoom = z.infer<typeof recordingSmartZoomSchema>

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
  profile: z.enum([
    "low-impact",
    "balanced",
    "smooth-demo",
    "high-quality",
    "smooth-60fps",
    "ultra-4k",
    "ultra-4k-60",
    "camera-only",
  ]),
  captureMicrophone: z.boolean(),
  captureSystemAudio: z.boolean(),
  captureWebcam: z.boolean(),
  webcamDeviceId: z.string().nullish(),
  microphoneDeviceId: z.string().nullish(),
  systemAudioDeviceId: z.string().nullish(),
  smartZoomEnabled: z.boolean().default(false),
  smartZoomPreset: recordingSmartZoomPresetSchema.default("product-demo"),
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
  // Human-facing metadata for control surfaces (floating toolbar, tray).
  // Defaults keep older payloads valid.
  sourceKind: z.string().default(""),
  sourceName: z.string().default(""),
  microphoneActive: z.boolean().default(false),
  systemAudioActive: z.boolean().default(false),
  webcamActive: z.boolean().default(false),
  error: z.string().nullish(),
})

export type RecordingStatus = z.infer<typeof recordingStatusSchema>

// Broadcast during session finalization to report step and percentage progress.
export const finalizationProgressSchema = z.object({
  sessionId: z.string(),
  step: z.string(),
  stageLabel: z.string(),
  percent: z.number().min(0).max(100),
})

export type FinalizationProgress = z.infer<typeof finalizationProgressSchema>

// Broadcast after Rust persists a completed recording so every window can open it.
export const recordingCompletedSchema = z.object({
  recordingId: z.string(),
})

export type RecordingCompleted = z.infer<typeof recordingCompletedSchema>

// A user-defined marker placed during a recording session.
export const recordingMarkerSchema = z.object({
  id: z.string(),
  label: z.string(),
  timestampMs: z.number().transform(Math.round).pipe(z.number().int().min(0)),
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

// A webcam sidecar segment aligned to its matching screen fragment.
export const recordingWebcamFragmentSchema = z.object({
  index: z.number().int().min(0),
  fileName: z.string(),
  durationMs: z.number().int().min(0),
  // Signed camera-minus-screen start offset. Positive values become a leading
  // gap in the standalone camera asset.
  offsetMs: z.number().int(),
  validated: z.boolean().default(false),
})

export type RecordingWebcamFragment = z.infer<typeof recordingWebcamFragmentSchema>

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
  // Final screen/audio output path; may be absent until finalization completes.
  outputPath: z.string().optional(),
  // Independent camera output path. Older manifests omit this field.
  webcamPath: z.string().optional(),
  webcamFragments: z.array(recordingWebcamFragmentSchema).default([]),
  fragments: z.array(recordingFragmentSchema),
  markers: z.array(recordingMarkerSchema).default([]),
  // Snapshot of the smart-zoom preference used to create this recording.
  smartZoom: recordingSmartZoomSchema.optional(),
  // Total accumulated recorded time in milliseconds (used for pause/resume).
  totalRecordedMs: z.number().int().min(0).default(0),
  // Checkpoint identity for the cursor_events project asset. Event samples stay
  // in the telemetry asset rather than being copied into the manifest.
  cursorTelemetry: z
    .object({
      assetId: z.string(),
      path: z.string(),
      schemaVersion: z.number().int().positive(),
      sourceWidth: z.number().int().positive(),
      sourceHeight: z.number().int().positive(),
      captureBounds: boundsSchema,
      dpiScale: z.object({ x: z.number().positive(), y: z.number().positive() }),
      timebase: z.object({ unit: z.literal("ms"), ticksPerSecond: z.number().int().positive() }),
    })
    .optional(),
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
  vendor: z.string().nullish(),
  // Whether the encoder is currently usable on this machine.
  available: z.boolean(),
  // Human-readable reason if the encoder is unavailable.
  reason: z.string().nullish(),
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
  bitrateKbps: z.number().nullish(),
  // CPU utilization percentage observed during the run.
  cpuPercent: z.number().nullish(),
  // Memory working set in MB.
  memoryMb: z.number().nullish(),
  // Error message if the benchmark failed.
  error: z.string().nullish(),
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
  cursorTelemetryAvailable: z.boolean().default(false),
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
    cpu: z.string().nullish(),
    memoryMb: z.number().int().nullish(),
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
  // Standalone, timeline-aligned webcam asset for recordings that captured a camera.
  webcamPath: z.string().nullish(),
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
    cpu: z.string().nullish(),
    memoryMb: z.number().int().nullish(),
  }),
  encoders: z.array(encoderInfoSchema),
  audioDevices: z.array(audioDeviceSchema),
  videoDevices: z.array(videoDeviceSchema),
})

export type DiagnosticsReport = z.infer<typeof diagnosticsReportSchema>

// Persisted user preferences and selections for the recording dialog.
export const recordingPreferencesSchema = z.object({
  sourceType: z.enum(["screen", "window", "region"]).default("screen"),
  sourceId: z.string().nullable().default(null),
  sourceName: z.string().nullable().default(null),
  regionBounds: boundsSchema.nullable().default(null),
  profile: recordingConfigSchema.shape.profile.default("low-impact"),
  smartZoomEnabled: z.boolean().default(false),
  smartZoomPreset: recordingSmartZoomPresetSchema.default("product-demo"),
  microphoneEnabled: z.boolean().default(false),
  microphoneId: z.string().nullable().default(null),
  microphoneName: z.string().nullable().default(null),
  systemAudioEnabled: z.boolean().default(false),
  systemAudioId: z.string().nullable().default(null),
  systemAudioName: z.string().nullable().default(null),
  webcamEnabled: z.boolean().default(false),
  webcamId: z.string().nullable().default(null),
  webcamName: z.string().nullable().default(null),
})

export type RecordingPreferences = z.infer<typeof recordingPreferencesSchema>

export const defaultRecordingPreferences: RecordingPreferences = {
  sourceType: "screen",
  sourceId: null,
  sourceName: null,
  regionBounds: null,
  profile: "low-impact",
  smartZoomEnabled: false,
  smartZoomPreset: "product-demo",
  microphoneEnabled: false,
  microphoneId: null,
  microphoneName: null,
  systemAudioEnabled: false,
  systemAudioId: null,
  systemAudioName: null,
  webcamEnabled: false,
  webcamId: null,
  webcamName: null,
}

export function reconcileMicrophone(
  availableMics: AudioDevice[],
  prefs: RecordingPreferences,
): { id: string; enabled: boolean } {
  if (!prefs.microphoneEnabled || availableMics.length === 0) {
    return { id: "", enabled: false }
  }

  // 1. Try matching by exact device ID
  if (prefs.microphoneId) {
    const matchedById = availableMics.find((m) => m.id === prefs.microphoneId)
    if (matchedById) {
      return { id: matchedById.id, enabled: true }
    }
  }

  // 2. Try matching by device Name (e.g. Windows assigned a new endpoint ID)
  if (prefs.microphoneName) {
    const matchedByName = availableMics.find((m) => m.name === prefs.microphoneName)
    if (matchedByName) {
      return { id: matchedByName.id, enabled: true }
    }
  }

  // 3. Fallback: immediately choose first available (preferring default if flagged)
  const fallback = availableMics.find((m) => m.isDefault) || availableMics[0]
  return { id: fallback?.id || "", enabled: Boolean(fallback) }
}

export function reconcileSystemAudio(
  availableAudios: AudioDevice[],
  prefs: RecordingPreferences,
): { id: string; enabled: boolean } {
  if (!prefs.systemAudioEnabled || availableAudios.length === 0) {
    return { id: "", enabled: false }
  }

  // 1. Try matching by exact device ID
  if (prefs.systemAudioId) {
    const matchedById = availableAudios.find((a) => a.id === prefs.systemAudioId)
    if (matchedById) {
      return { id: matchedById.id, enabled: true }
    }
  }

  // 2. Try matching by device Name
  if (prefs.systemAudioName) {
    const matchedByName = availableAudios.find((a) => a.name === prefs.systemAudioName)
    if (matchedByName) {
      return { id: matchedByName.id, enabled: true }
    }
  }

  // 3. Fallback: immediately choose first available
  const fallback = availableAudios.find((a) => a.isDefault) || availableAudios[0]
  return { id: fallback?.id || "", enabled: Boolean(fallback) }
}

export function reconcileWebcam(
  availableWebcams: VideoDevice[],
  prefs: RecordingPreferences,
): { id: string; enabled: boolean } {
  if (!prefs.webcamEnabled || availableWebcams.length === 0) {
    return { id: "", enabled: false }
  }

  // 1. Try matching by exact device ID
  if (prefs.webcamId) {
    const matchedById = availableWebcams.find((w) => w.id === prefs.webcamId)
    if (matchedById) {
      return { id: matchedById.id, enabled: true }
    }
  }

  // 2. Try matching by device Name
  if (prefs.webcamName) {
    const matchedByName = availableWebcams.find((w) => w.name === prefs.webcamName)
    if (matchedByName) {
      return { id: matchedByName.id, enabled: true }
    }
  }

  // 3. Fallback: immediately choose first available
  const fallback = availableWebcams.find((w) => w.isDefault) || availableWebcams[0]
  return { id: fallback?.id || "", enabled: Boolean(fallback) }
}

export function reconcileCaptureSource(
  availableSources: CaptureSource[],
  prefs: RecordingPreferences,
): { source: CaptureSource | null; sourceType: "screen" | "window" | "region" } {
  if (prefs.sourceType === "region") {
    if (prefs.regionBounds) {
      return {
        source: {
          kind: "region",
          id: `region-${prefs.regionBounds.x}-${prefs.regionBounds.y}-${prefs.regionBounds.width}-${prefs.regionBounds.height}`,
          name: `Region ${prefs.regionBounds.width}×${prefs.regionBounds.height}`,
          bounds: prefs.regionBounds,
        },
        sourceType: "region",
      }
    }
    return { source: null, sourceType: "region" }
  }

  if (prefs.sourceType === "window") {
    const windowSources = availableSources.filter((s) => s.kind === "window")
    if (prefs.sourceId) {
      const matchedById = windowSources.find((w) => w.id === prefs.sourceId)
      if (matchedById) return { source: matchedById, sourceType: "window" }
    }
    if (prefs.sourceName) {
      const matchedByName = windowSources.find((w) => w.name === prefs.sourceName)
      if (matchedByName) return { source: matchedByName, sourceType: "window" }
    }
    if (windowSources.length > 0) {
      return { source: windowSources[0], sourceType: "window" }
    }
    // No open windows detected; fallback to display
    const displaySources = availableSources.filter((s) => s.kind === "display")
    return {
      source: displaySources[0] || availableSources[0] || null,
      sourceType: "screen",
    }
  }

  // "screen" display selection
  const displaySources = availableSources.filter((s) => s.kind === "display")
  if (prefs.sourceId) {
    const matchedById = displaySources.find((d) => d.id === prefs.sourceId)
    if (matchedById) return { source: matchedById, sourceType: "screen" }
  }
  if (prefs.sourceName) {
    const matchedByName = displaySources.find((d) => d.name === prefs.sourceName)
    if (matchedByName) return { source: matchedByName, sourceType: "screen" }
  }
  return {
    source: displaySources[0] || availableSources[0] || null,
    sourceType: "screen",
  }
}

export function reconcileProfile(
  availableProfiles: RecordingProfile[],
  prefs: RecordingPreferences,
): RecordingConfig["profile"] {
  if (availableProfiles.length === 0) return prefs.profile
  if (availableProfiles.some((p) => p.id === prefs.profile)) {
    return prefs.profile
  }
  return (availableProfiles[0]?.id as RecordingConfig["profile"]) || "low-impact"
}
