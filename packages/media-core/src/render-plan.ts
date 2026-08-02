import type {
  AppError,
  LibraryRecording,
  RenderPlan,
  RenderPlanAudio,
  RenderPlanOverlay,
  RenderSegment,
  TimelineClip,
  TimelineState,
} from "@recordforge/domain"
import { getTotalDuration, sortClips } from "@recordforge/domain"

function editorError(code: string, message: string): AppError {
  return { category: "editor", code, message }
}

function toSegments(clips: TimelineClip[], inputPath: string): RenderSegment[] {
  const sorted = sortClips(clips)
  let outputStart = 0
  const segments: RenderSegment[] = []

  for (const clip of sorted) {
    const outputEnd = outputStart + clip.durationMs
    segments.push({
      inputPath,
      sourceInMs: clip.sourceInMs,
      sourceOutMs: clip.sourceOutMs,
      outputStartMs: outputStart,
      outputEndMs: outputEnd,
    })
    outputStart = outputEnd
  }

  return segments
}

function toOverlays(_clips: TimelineClip[], _inputPath: string): RenderPlanOverlay[] {
  // Camera overlays are planned for a later phase. Return an empty array for the
  // MVP so the schema is ready when Rust overlay rendering lands.
  return []
}

function buildAudio(
  recording: LibraryRecording,
  state: TimelineState,
): RenderPlanAudio | undefined {
  if (!recording.outputPath) return undefined

  const audioTrack = state.tracks.find((t) => t.kind === "audio")
  const muted = audioTrack?.muted ?? false
  const volume = audioTrack?.volume ?? 1

  return {
    inputPath: recording.outputPath,
    muted,
    volume,
  }
}

export interface BuildRenderPlanInput {
  state: TimelineState
  recording: LibraryRecording
  outputPath: string
}

// Build a render plan from a timeline and a destination path.
// The MVP only renders the first screen track; camera, audio and captions
// are included in the plan schema for the next phase.
export function buildRenderPlan(
  input: BuildRenderPlanInput,
): { ok: true; value: RenderPlan } | { ok: false; error: AppError } {
  const { state, recording, outputPath } = input

  if (!recording.outputPath) {
    return { ok: false, error: editorError("no_output_path", "Recording has no output path") }
  }

  const sourcePath = recording.outputPath
  const screenTrack = state.tracks.find((t) => t.kind === "screen")
  if (!screenTrack || screenTrack.clips.length === 0) {
    return {
      ok: false,
      error: editorError("no_screen_track", "Timeline has no screen track to render"),
    }
  }

  const cameraTrack = state.tracks.find((t) => t.kind === "camera")
  const cameraInputPath = cameraTrack?.clips[0]?.assetId ? sourcePath : sourcePath

  const segments = toSegments(screenTrack.clips, sourcePath)
  const overlays = cameraTrack ? toOverlays(cameraTrack.clips, cameraInputPath) : []
  const audio = buildAudio(recording, state)

  return {
    ok: true,
    value: {
      recordingId: recording.id,
      outputPath,
      canvas: state.canvas,
      durationMs: getTotalDuration(state),
      segments,
      audio,
      overlays,
    },
  }
}
