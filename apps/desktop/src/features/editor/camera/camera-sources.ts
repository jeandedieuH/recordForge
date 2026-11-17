import type {
  CameraClip,
  LibraryRecording,
  MediaJob,
  MediaMetadata,
  recordForgeProject,
} from "@recordforge/contracts"

export interface CameraSourceSize {
  width: number
  height: number
}

// Everything needed to resolve real camera source pixels for a clip.
export interface CameraSourceContext {
  project: recordForgeProject | null
  metadata: MediaMetadata | null
  activeJob: MediaJob | null
  recording: LibraryRecording | null
}

// Placeholder webcam size for standalone/secondary camera captures whose real
// dimensions have not been probed yet.
const UNPROBED_WEBCAM_SIZE: CameraSourceSize = { width: 1280, height: 720 }

/**
 * Resolve the real source-pixel size of a camera clip. Crop math lives in
 * source space, so the right dimensions are the camera stream's, not the
 * screen's or the canvas's.
 *
 * Resolution order:
 * 1. prepared derivative output (most reliable once the prepare job ran)
 * 2. durable project asset dimensions
 * 3. probed metadata stream dimensions
 * 4. 720p placeholder for known webcam captures still being prepared
 *
 * Returns null when nothing reliable is known.
 */
export function resolveCameraSourceSize(
  clip: CameraClip,
  ctx: CameraSourceContext,
): CameraSourceSize | null {
  const output = ctx.activeJob?.outputs?.videoTracks.find(
    (track) => track.streamIndex === clip.streamIndex,
  )
  const asset = ctx.project?.assets.find((candidate) => candidate.id === clip.assetId)
  const stream = ctx.metadata?.streams.find(
    (candidate) => candidate.index === clip.streamIndex && candidate.kind === "video",
  )
  const isWebcam = Boolean(ctx.recording?.webcamPath) || (clip.streamIndex ?? 0) > 0
  const fallback = isWebcam ? UNPROBED_WEBCAM_SIZE : null

  const width = output?.width ?? asset?.width ?? stream?.width ?? fallback?.width
  const height = output?.height ?? asset?.height ?? stream?.height ?? fallback?.height
  if (!width || !height) return null
  return { width, height }
}
