import type {
  AppError,
  LibraryRecording,
  RenderPlan,
  RenderPlanAudio,
  RenderPlanCaption,
  RenderPlanMask,
  RenderPlanCursorEffect,
  RenderCaptionMode,
  RenderPlanOverlay,
  RenderPlanZoomSegment,
  RenderSegment,
  TimelineClip,
  TimelineState,
} from "@recordforge/domain"
import { clampZoomTarget, getManualZoomSegments } from "@recordforge/editor-core"
import { getTotalDuration, sortClips } from "@recordforge/domain"

function editorError(code: string, message: string): AppError {
  return { category: "editor", code, message }
}

function toSegments(
  clips: TimelineClip[],
  assetId: string,
  includeAudioSettings = false,
): RenderSegment[] {
  const sorted = sortClips(clips)
  return sorted.map((clip) => ({
    assetId: clip.assetId || assetId,
    streamIndex: "streamIndex" in clip ? clip.streamIndex : undefined,
    ...(includeAudioSettings && clip.kind === "audio"
      ? {
          volume: clip.volume,
          fadeInMs: Math.min(clip.fadeInMs, clip.durationMs),
          fadeOutMs: Math.min(clip.fadeOutMs, clip.durationMs),
        }
      : {}),
    sourceInMs: clip.sourceInMs,
    sourceOutMs: clip.sourceOutMs,
    speed: clip.speed,
    outputStartMs: clip.startMs,
    outputEndMs: clip.startMs + clip.durationMs,
  }))
}

function toOverlays(
  clips: TimelineClip[],
  assetId: string,
  canvas: TimelineState["canvas"],
  trackVisible: boolean,
): RenderPlanOverlay[] {
  return sortClips(clips)
    .filter((clip): clip is Extract<TimelineClip, { kind: "camera" }> => clip.kind === "camera")
    .map((clip) => {
      const transform = clip.transform
      const width = Math.min(Math.max(0, transform.width), canvas.width)
      const height = Math.min(Math.max(0, transform.height), canvas.height)
      return {
        assetId: clip.assetId || assetId,
        streamIndex: clip.streamIndex,
        sourceInMs: clip.sourceInMs,
        sourceOutMs: clip.sourceOutMs,
        outputStartMs: clip.startMs,
        outputEndMs: clip.startMs + clip.durationMs,
        x: Math.min(Math.max(0, transform.x), Math.max(0, canvas.width - width)),
        y: Math.min(Math.max(0, transform.y), Math.max(0, canvas.height - height)),
        width,
        height,
        crop: transform.crop,
        opacity: transform.opacity,
        visible: trackVisible && transform.visible !== false,
        shape: transform.shape,
        borderWidth: transform.borderWidth,
        borderColor: transform.borderColor,
        borderOpacity: transform.borderOpacity,
        shadowEnabled: transform.shadowEnabled,
        shadowColor: transform.shadowColor,
        shadowBlur: transform.shadowBlur,
        shadowOffsetX: transform.shadowOffsetX,
        shadowOffsetY: transform.shadowOffsetY,
      }
    })
}

function toCaptions(state: TimelineState): RenderPlanCaption[] {
  return state.tracks
    .filter((track) => track.kind === "captions" && !track.muted)
    .flatMap((track) =>
      sortClips(track.clips)
        .filter(
          (clip): clip is Extract<TimelineClip, { kind: "caption" }> => clip.kind === "caption",
        )
        .map((clip) => ({
          id: clip.id,
          text: clip.text,
          startMs: clip.startMs,
          endMs: clip.startMs + clip.durationMs,
          style: clip.style,
          placement: clip.placement ?? "bottom",
          safeAreaMargin: clip.safeAreaMargin ?? 48,
        })),
    )
    .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))
}

function toMasks(state: TimelineState, assetId: string): RenderPlanMask[] {
  return state.tracks
    .filter((track) => track.kind === "effects" && !track.muted)
    .flatMap((track) =>
      sortClips(track.clips)
        .filter((clip): clip is Extract<TimelineClip, { kind: "mask" }> => clip.kind === "mask")
        .map((clip) => {
          const width = Math.min(Math.max(1, clip.rect.width), state.canvas.width)
          const height = Math.min(Math.max(1, clip.rect.height), state.canvas.height)
          return {
            id: clip.id,
            // Masks are output-canvas effects; the recording id keeps the
            // render plan anchored to a trusted source without treating the mask as media.
            assetId,
            startMs: clip.startMs,
            endMs: clip.startMs + clip.durationMs,
            mode: clip.mode,
            rect: {
              x: Math.min(Math.max(0, clip.rect.x), Math.max(0, state.canvas.width - width)),
              y: Math.min(Math.max(0, clip.rect.y), Math.max(0, state.canvas.height - height)),
              width,
              height,
            },
            blurRadius: clip.blurRadius,
            pixelSize: clip.pixelSize,
            redactColor: clip.redactColor,
            enabled: clip.enabled,
          }
        }),
    )
}

function toZoomSegments(state: TimelineState): RenderPlanZoomSegment[] {
  return getManualZoomSegments(state)
    .filter((segment) => segment.enabled)
    .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))
    .map((segment) => ({
      id: segment.id,
      startMs: segment.startMs,
      endMs: segment.startMs + segment.durationMs,
      target: clampZoomTarget(segment.target, state.canvas),
      scale: segment.scale,
      easing: segment.easing,
      enabled: segment.enabled,
    }))
}

function toCursorEffects(state: TimelineState): RenderPlanCursorEffect[] {
  const track = state.tracks.find((candidate) => candidate.kind === "cursor")
  if (!track) return []
  return track.clips
    .filter((clip) => clip.kind === "cursor-effect")
    .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))
    .map((clip) => ({
      id: clip.id,
      assetId: clip.assetId,
      startMs: clip.startMs,
      endMs: clip.startMs + clip.durationMs,
      enabled: clip.enabled,
      presetId: clip.presetId,
      scale: clip.scale,
      smoothing: clip.smoothing,
      settings: clip.settings,
    }))
}

export function isTimelineAudioMuted(state: TimelineState): boolean {
  const audioTracks = state.tracks.filter((track) => track.kind === "audio")
  if (audioTracks.length === 0) return false
  const hasSoloTrack = audioTracks.some((track) => track.solo)
  return audioTracks.every((track) => track.muted || (hasSoloTrack && !track.solo))
}

function buildAudioTracks(recording: LibraryRecording, state: TimelineState): RenderPlanAudio[] {
  const audioTracks = state.tracks.filter(
    (track) => track.kind === "audio" && track.clips.length > 0,
  )
  const hasSoloTrack = audioTracks.some((track) => track.solo)
  return audioTracks.map((track) => {
    const clips = sortClips(track.clips)
    const firstClip = clips[0]
    const segments = toSegments(clips, recording.id, true).map((segment, index) => ({
      ...segment,
      volume:
        clips[index]?.kind === "audio"
          ? Math.min(2, clips[index].volume * track.volume)
          : track.volume,
    }))
    const firstAudioClip = clips.find(
      (clip): clip is Extract<TimelineClip, { kind: "audio" }> => clip.kind === "audio",
    )
    return {
      assetId: firstClip?.assetId || recording.id,
      streamIndex: firstClip && "streamIndex" in firstClip ? firstClip.streamIndex : undefined,
      role: firstAudioClip?.role,
      muted: track.muted || (hasSoloTrack && !track.solo),
      volume: track.volume,
      segments,
    }
  })
}

export interface BuildRenderPlanInput {
  state: TimelineState
  recording: LibraryRecording
  outputPath: string
  captionMode?: RenderCaptionMode
}

// Build a render plan from a timeline and a destination path. Camera overlays,
// manual zooms, canvas framing, and independent audio tracks are all emitted
// here so the Rust compositor receives the same semantics as the preview.
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
  const overlays = cameraTrack
    ? toOverlays(cameraTrack.clips, assetId, state.canvas, !cameraTrack.muted)
    : []
  const audioTracks = buildAudioTracks(recording, state)
  const zoomSegments = toZoomSegments(state)
  const cursorEffects = toCursorEffects(state)
  const captions = toCaptions(state)
  const masks = toMasks(state, recording.id)
  const screenDurationMs = segments.reduce(
    (duration, segment) => Math.max(duration, segment.outputEndMs),
    0,
  )
  if (captions.some((caption) => caption.endMs > screenDurationMs)) {
    return {
      ok: false,
      error: editorError(
        "invalid_caption_range",
        "A caption extends beyond the rendered screen timeline",
      ),
    }
  }
  if (masks.some((mask) => mask.endMs > screenDurationMs)) {
    return {
      ok: false,
      error: editorError(
        "invalid_mask_range",
        "A privacy mask extends beyond the rendered screen timeline",
      ),
    }
  }
  for (let index = 1; index < captions.length; index++) {
    if (captions[index].startMs < captions[index - 1].endMs) {
      return {
        ok: false,
        error: editorError(
          "caption_overlap",
          "Caption clips overlap and cannot be rendered safely",
        ),
      }
    }
  }

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
      captions,
      captionMode: input.captionMode ?? "burn-in",
      masks,
      zoomSegments,
      cursorEffects,
    },
  }
}
