import { z } from "zod"

// Offline camera AI derivatives (#4b/#4c). Inference never runs during export:
// these jobs decode the camera stream once, run the pinned ONNX models, and
// write a grayscale matte video plus a compact face-track JSON next to the
// recording's other derivatives.

export const cameraAiFeaturesSchema = z.object({
  matte: z.boolean().default(false),
  faceTrack: z.boolean().default(false),
})

export type CameraAiFeatures = z.infer<typeof cameraAiFeaturesSchema>

export const cameraAiJobRequestSchema = z.object({
  jobId: z.string().min(1),
  recordingId: z.string().min(1),
  assetId: z.string().min(1),
  /** Absolute ffprobe stream index of the camera feed; omitted = first video. */
  streamIndex: z.number().int().min(0).optional(),
  features: cameraAiFeaturesSchema,
  /** Ignore existing derivatives and recompute. */
  force: z.boolean().default(false),
})

export type CameraAiJobRequest = z.infer<typeof cameraAiJobRequestSchema>

export const cameraAiJobResultSchema = z.object({
  mattePath: z.string().nullish(),
  faceTrackPath: z.string().nullish(),
  faceSamples: z.number().int().min(0).default(0),
  cached: z.boolean().default(false),
})

export type CameraAiJobResult = z.infer<typeof cameraAiJobResultSchema>

export const cameraAiArtifactsSchema = z.object({
  mattePath: z.string().nullish(),
  faceTrackPath: z.string().nullish(),
})

export type CameraAiArtifacts = z.infer<typeof cameraAiArtifactsSchema>

export const cameraAiModelInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  sizeBytes: z.number().int().min(0),
  downloaded: z.boolean(),
})

export type CameraAiModelInfo = z.infer<typeof cameraAiModelInfoSchema>

export const cameraAiStatusSchema = z.object({
  supported: z.boolean(),
  runtimeReady: z.boolean(),
  models: z.array(cameraAiModelInfoSchema),
  ready: z.boolean(),
  /** Why the runtime cannot run here, when `supported` is false. */
  reason: z.string().nullish(),
})

export type CameraAiStatus = z.infer<typeof cameraAiStatusSchema>

export const cameraAiProgressEventSchema = z.object({
  jobId: z.string(),
  phase: z.enum(["preparing", "matte", "face", "finalizing"]),
  percent: z.number().int().min(0).max(100),
})

export type CameraAiProgressEvent = z.infer<typeof cameraAiProgressEventSchema>

export const cameraAiSetupProgressSchema = z.object({
  stage: z.enum(["runtime", "model"]),
  model: z.string().optional(),
  downloadedBytes: z.number().int().min(0).default(0),
  totalBytes: z.number().int().min(0).default(0),
})

export type CameraAiSetupProgress = z.infer<typeof cameraAiSetupProgressSchema>

export const CAMERA_AI_SETUP_EVENT = "camera-ai-setup"

/**
 * Whether an asset path points at a standalone webcam sidecar file rather than
 * a stream inside the recording's primary output. The capture pipeline writes
 * `webcam.mp4` next to `output.mp4` (and `trim_<id>_webcam.mp4` for trimmed
 * recordings); an embedded camera stream shares the output file's path
 * instead. Absolute paths always contain a drive/URI separator and never
 * match.
 */
export function isStandaloneWebcamAssetPath(assetPath: string | null | undefined): boolean {
  if (!assetPath || assetPath.includes(":")) return false
  const name = assetPath.replace(/\\/g, "/").split("/").pop()?.toLowerCase()
  return name === "webcam.mp4" || (name?.endsWith("_webcam.mp4") ?? false)
}

// Face track write format (`camera-face-<stream>.json`). Boxes are in camera
// source pixels at the recording's container time. `score` is YuNet's
// cls·obj confidence in 0…1.
export const faceTrackSampleSchema = z.object({
  timeMs: z.number().int().min(0),
  x: z.number().min(0),
  y: z.number().min(0),
  width: z.number().positive(),
  height: z.number().positive(),
  score: z.number().min(0).max(1).default(0),
})

export type FaceTrackSample = z.infer<typeof faceTrackSampleSchema>

export const faceTrackSchema = z.object({
  version: z.literal(1),
  streamIndex: z.number().int().min(0),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  samples: z.array(faceTrackSampleSchema),
})

export type FaceTrack = z.infer<typeof faceTrackSchema>

/** Event emitted by Rust while a camera-AI job runs. */
export const CAMERA_AI_PROGRESS_EVENT = "camera-ai-progress"
