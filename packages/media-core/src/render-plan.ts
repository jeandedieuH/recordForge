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
  return sorted.map((clip) => ({
    assetId: clip.assetId || assetId,
    streamIndex: clip.streamIndex,
    sourceInMs: clip.sourceInMs,
    sourceOutMs: clip.sourceOutMs,
    speed: clip.speed,
    outputStartMs: clip.startMs,
    outputEndMs: clip.startMs + clip.durationMs,
  }))
}

function toOverlays(_clips: TimelineClip[], _assetId: string): RenderPlanOverlay[] {
  // Camera overlays are planned for a later phase. Return an empty array for the
  // MVP so the schema is ready when Rust overlay rendering lands.
  return []
}

export function isTimelineAudioMuted(state: TimelineState): boolean {
  const audioTracks = state.tracks.filter((track) => track.kind === "audio")
  return audioTracks.length > 0 && audioTracks.every((track) => track.muted)
}

function buildAudioTracks(recording: LibraryRecording, state: TimelineState): RenderPlanAudio[] {
  return state.tracks
    .filter((track) => track.kind === "audio" && track.clips.length > 0)
    .map((track) => {
      const clips = sortClips(track.clips)
      const firstClip = clips[0]
      const segments = toSegments(clips, recording.id).map((segment, index) => ({
        ...segment,
        volume: clips[index]?.kind === "audio" ? clips[index].volume * track.volume : track.volume,
      }))
      return {
        assetId: firstClip?.assetId || recording.id,
        streamIndex: firstClip?.streamIndex,
        muted: track.muted,
        volume: track.volume,
        segments,
      }
    })
}

export interface BuildRenderPlanInput {
  state: TimelineState
  recording: LibraryRecording
  outputPath: string
}

// Build a render plan from a timeline and a destination path.
// Screen cuts and independent audio tracks are rendered now; camera overlays
// and captions remain schema-ready for a later render pass.
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
  const audioTracks = buildAudioTracks(recording, state)

  return {
    ok: true,
    value: {
      recordingId: recording.id,
      canvas: state.canvas,
      durationMs: getTotalDuration(state),
      segments,
      audio: audioTracks[0] ?? {
        assetId: recording.id,
        muted: false,
        volume: 1,
        segments: [],
      },
      audioTracks,
      overlays,
    },
  }
}
