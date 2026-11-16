import { listen } from "@tauri-apps/api/event"
import {
  CAMERA_AI_PROGRESS_EVENT,
  CAMERA_AI_SETUP_EVENT,
  cameraAiArtifactsSchema,
  cameraAiJobResultSchema,
  cameraAiProgressEventSchema,
  cameraAiSetupProgressSchema,
  cameraAiStatusSchema,
  faceTrackSchema,
  type CameraAiArtifacts,
  type CameraAiJobRequest,
  type CameraAiJobResult,
  type CameraAiProgressEvent,
  type CameraAiSetupProgress,
  type CameraAiStatus,
  type FaceTrack,
} from "@recordforge/contracts"
import { invokeValidated } from "./ipc"
import type { CameraClip } from "@recordforge/contracts"

// Camera AI (Pro) — offline ONNX derivatives. The runtime and models are
// downloaded on demand; matte/face inference never runs during export.

export function getCameraAiStatus(): Promise<CameraAiStatus> {
  return invokeValidated("get_camera_ai_status", {}, cameraAiStatusSchema)
}

export function downloadCameraAiEngine(models: string[]): Promise<void> {
  return invokeValidated("download_camera_ai_engine", { models })
}

export function deleteCameraAiModel(model: string): Promise<void> {
  return invokeValidated("delete_camera_ai_model", { model })
}

export function analyzeCameraAi(request: CameraAiJobRequest): Promise<CameraAiJobResult> {
  return invokeValidated("analyze_camera_ai", { request }, cameraAiJobResultSchema)
}

export function cancelCameraAi(jobId: string): Promise<void> {
  return invokeValidated("cancel_camera_ai", { jobId })
}

/** Whether a rejected `analyzeCameraAi` call was cancelled by the user. */
export function isCameraAiCancelled(error: unknown): boolean {
  if (error && typeof error === "object") {
    const { code, message } = error as { code?: unknown; message?: unknown }
    if (code === "camera_ai_cancelled") return true
    if (typeof message === "string" && message.includes("camera_ai_cancelled")) return true
  }
  return typeof error === "string" && error.includes("camera_ai_cancelled")
}

export function getCameraAiArtifacts(
  recordingId: string,
  streamIndex?: number,
): Promise<CameraAiArtifacts> {
  return invokeValidated(
    "get_camera_ai_artifacts",
    { recordingId, streamIndex },
    cameraAiArtifactsSchema,
  )
}

export async function readCameraFaceTrack(
  recordingId: string,
  streamIndex?: number,
): Promise<FaceTrack | null> {
  const text = await invokeValidated<string | null>("read_camera_face_track", {
    recordingId,
    streamIndex,
  })
  if (!text) return null
  const parsed = faceTrackSchema.safeParse(JSON.parse(text))
  return parsed.success ? parsed.data : null
}

export function readCameraLut(recordingId: string, assetId: string): Promise<string> {
  return invokeValidated("read_camera_lut", { recordingId, assetId })
}

// A completed run writes deterministic matte/face-track paths; the inspector and
// the editor preview are separate surfaces, so the finished run notifies the
// preview to reload them.
const artifactListeners = new Set<() => void>()

export function notifyCameraAiArtifactsChanged(): void {
  for (const listener of artifactListeners) listener()
}

export function onCameraAiArtifactsChanged(listener: () => void): () => void {
  artifactListeners.add(listener)
  return () => {
    artifactListeners.delete(listener)
  }
}

export function onCameraAiProgress(
  callback: (progress: CameraAiProgressEvent) => void,
): Promise<() => void> {
  return listen<unknown>(CAMERA_AI_PROGRESS_EVENT, (event) => {
    const parsed = cameraAiProgressEventSchema.safeParse(event.payload)
    if (parsed.success) callback(parsed.data)
  })
}

export function onCameraAiSetupProgress(
  callback: (progress: CameraAiSetupProgress) => void,
): Promise<() => void> {
  return listen<unknown>(CAMERA_AI_SETUP_EVENT, (event) => {
    const parsed = cameraAiSetupProgressSchema.safeParse(event.payload)
    if (parsed.success) callback(parsed.data)
  })
}

export interface CameraAiExportArtifacts {
  mattePath?: string
  faceTrack?: FaceTrack
}

/**
 * Load every camera clip's completed derivatives for the render plan. Keys are
 * the render plan's stream keys (`"<index>"`, or `"-1"` for a standalone
 * webcam asset). Missing files simply produce an entry without that artifact.
 */
export async function loadCameraAiArtifactsForExport(
  recordingId: string,
  cameraClips: CameraClip[],
): Promise<Record<string, CameraAiExportArtifacts>> {
  const keys = new Map<string, number | undefined>()
  for (const clip of cameraClips) {
    const stream = clip.streamIndex
    keys.set(String(stream ?? -1), stream)
  }
  const result: Record<string, CameraAiExportArtifacts> = {}
  for (const [key, streamIndex] of keys) {
    try {
      const artifacts = await getCameraAiArtifacts(recordingId, streamIndex ?? 0)
      const faceTrack = artifacts.faceTrackPath
        ? await readCameraFaceTrack(recordingId, streamIndex ?? 0)
        : null
      result[key] = {
        ...(artifacts.mattePath ? { mattePath: artifacts.mattePath } : {}),
        ...(faceTrack ? { faceTrack } : {}),
      }
    } catch {
      // Derivatives are optional: a missing artifact must never block export.
      result[key] = {}
    }
  }
  return result
}
