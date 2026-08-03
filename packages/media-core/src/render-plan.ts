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

function toSegments(clips: TimelineClip[], assetId: string): RenderSegment[] {
  const sorted = sortClips(clips)
  let outputStart = 0
  const segments: RenderSegment[] = []

  for (const clip of sorted) {
    const outputEnd = outputStart + clip.durationMs
    segments.push({
      assetId: clip.assetId || assetId,
      sourceInMs: clip.sourceInMs,
      sourceOutMs: clip.sourceOutMs,
      outputStartMs: outputStart,
      outputEndMs: outputEnd,
    })
    outputStart = outputEnd
  }

  return segments
}

function toOverlays(_clips: TimelineClip[], _assetId: string): RenderPlanOverlay[] {
  // Camera overlays are planned for a later phase. Return an empty array for the
  // MVP so the schema is ready when Rust overlay rendering lands.
  return []
}

function buildAudio(
  recording: LibraryRecording,
  state: TimelineState,
): RenderPlanAudio | undefined {
  const audioTrack = state.tracks.find((t) => t.kind === "audio")
  const muted = audioTrack?.muted ?? false
  const volume = audioTrack?.volume ?? 1

  return {
    assetId: recording.id,
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
  const { state, recording } = input

  if (!recording.id || !recording.outputPath) {
    return {
      ok: false,
      error: editorError(
        "missing_recording_source",
        "Recording is missing valid output path or ID",
      ),
    }
  }

  const screenTrack = state.tracks.find((t) => t.kind === "screen")
  if (!screenTrack || screenTrack.clips.length === 0) {
    return {
      ok: false,
      error: editorError("no_screen_track", "Timeline has no screen track to render"),
    }
  }

  const cameraTrack = state.tracks.find((t) => t.kind === "camera")
  const assetId = recording.id

  const segments = toSegments(screenTrack.clips, assetId)
  const overlays = cameraTrack ? toOverlays(cameraTrack.clips, assetId) : []
  const audio = buildAudio(recording, state)

  return {
    ok: true,
    value: {
      recordingId: recording.id,
      canvas: state.canvas,
      durationMs: getTotalDuration(state),
      segments,
      audio,
      overlays,
    },
  }
}
