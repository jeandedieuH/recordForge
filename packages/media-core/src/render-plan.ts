import type {
  AppError,
  ExportRange,
  ProjectExportSettings,
  RenderPlan,
  RenderPlanAudio,
  RenderPlanCaption,
  RenderPlanCursorEffect,
  RenderPlanMask,
  RenderCaptionMode,
  RenderPlanOverlay,
  RenderPlanZoomSegment,
  RenderSegment,
  TimelineClip,
  TimelineState,
} from "@recordforge/domain"
import { clampZoomTarget, getManualZoomSegments } from "@recordforge/editor-core"
import { sortClips } from "@recordforge/domain"

function editorError(code: string, message: string): AppError {
  return { category: "editor", code, message }
}

interface WindowedClip {
  sourceInMs: number
  sourceOutMs: number
  outputStartMs: number
  outputEndMs: number
}

function resolveRange(range: ExportRange | undefined): ExportRange | undefined {
  if (!range) return undefined
  if (range.endMs <= range.startMs) return undefined
  return range
}

function windowClip(clip: TimelineClip, range: ExportRange | undefined): WindowedClip | null {
  const clipEndMs = clip.startMs + clip.durationMs
  const startMs = Math.max(clip.startMs, range?.startMs ?? 0)
  const endMs = Math.min(clipEndMs, range?.endMs ?? clipEndMs)
  if (endMs <= startMs) return null

  const outputOffsetMs = range?.startMs ?? 0
  const relativeStartMs = startMs - clip.startMs
  const relativeEndMs = endMs - clip.startMs
  return {
    sourceInMs: clip.sourceInMs + Math.round(relativeStartMs * clip.speed),
    sourceOutMs: clip.sourceInMs + Math.round(relativeEndMs * clip.speed),
    outputStartMs: startMs - outputOffsetMs,
    outputEndMs: endMs - outputOffsetMs,
  }
}

function windowTimeRange(
  startMs: number,
  endMs: number,
  range: ExportRange | undefined,
): { startMs: number; endMs: number } | null {
  const start = Math.max(startMs, range?.startMs ?? 0)
  const end = Math.min(endMs, range?.endMs ?? endMs)
  if (end <= start) return null
  return { startMs: start - (range?.startMs ?? 0), endMs: end - (range?.startMs ?? 0) }
}

function toSegments(
  clips: TimelineClip[],
  range: ExportRange | undefined,
  includeAudioSettings = false,
): RenderSegment[] {
  return sortClips(clips)
    .map((clip) => {
      const window = windowClip(clip, range)
      if (!window) return null
      const durationMs = window.outputEndMs - window.outputStartMs
      return {
        assetId: clip.assetId,
        ...("streamIndex" in clip && clip.streamIndex !== undefined
          ? { streamIndex: clip.streamIndex }
          : {}),
        ...(includeAudioSettings && clip.kind === "audio"
          ? {
              volume: clip.volume,
              fadeInMs: Math.min(clip.fadeInMs, durationMs),
              fadeOutMs: Math.min(clip.fadeOutMs, durationMs),
            }
          : {}),
        sourceInMs: window.sourceInMs,
        sourceOutMs: window.sourceOutMs,
        speed: clip.speed,
        outputStartMs: window.outputStartMs,
        outputEndMs: window.outputEndMs,
      }
    })
    .filter((segment): segment is RenderSegment => segment !== null)
}

function toGaps(
  segments: RenderSegment[],
  durationMs: number,
): Array<{ startMs: number; endMs: number }> {
  const gaps: Array<{ startMs: number; endMs: number }> = []
  let cursorMs = 0
  for (const segment of segments) {
    if (segment.outputStartMs > cursorMs) {
      gaps.push({ startMs: cursorMs, endMs: segment.outputStartMs })
    }
    cursorMs = Math.max(cursorMs, segment.outputEndMs)
  }
  if (cursorMs < durationMs) gaps.push({ startMs: cursorMs, endMs: durationMs })
  return gaps
}

function toOverlays(
  clips: TimelineClip[],
  canvas: TimelineState["canvas"],
  trackVisible: boolean,
  range: ExportRange | undefined,
): RenderPlanOverlay[] {
  return sortClips(clips)
    .filter((clip): clip is Extract<TimelineClip, { kind: "camera" }> => clip.kind === "camera")
    .flatMap((clip) => {
      const window = windowClip(clip, range)
      if (!window) return []
      const transform = clip.transform
      const width = Math.min(Math.max(0, transform.width), canvas.width)
      const height = Math.min(Math.max(0, transform.height), canvas.height)
      return [
        {
          assetId: clip.assetId,
          streamIndex: clip.streamIndex,
          sourceInMs: window.sourceInMs,
          sourceOutMs: window.sourceOutMs,
          outputStartMs: window.outputStartMs,
          outputEndMs: window.outputEndMs,
          speed: clip.speed,
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
        },
      ]
    })
}

function toCaptions(state: TimelineState, range: ExportRange | undefined): RenderPlanCaption[] {
  return state.tracks
    .filter((track) => track.kind === "captions" && !track.muted)
    .flatMap((track) =>
      sortClips(track.clips)
        .filter(
          (clip): clip is Extract<TimelineClip, { kind: "caption" }> => clip.kind === "caption",
        )
        .flatMap((clip) => {
          const window = windowTimeRange(clip.startMs, clip.startMs + clip.durationMs, range)
          if (!window) return []
          return [
            {
              id: clip.id,
              text: clip.text,
              startMs: window.startMs,
              endMs: window.endMs,
              style: clip.style,
              placement: clip.placement ?? "bottom",
              safeAreaMargin: clip.safeAreaMargin ?? 48,
            },
          ]
        }),
    )
    .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))
}

function toMasks(state: TimelineState, range: ExportRange | undefined): RenderPlanMask[] {
  return state.tracks
    .filter((track) => track.kind === "effects" && !track.muted)
    .flatMap((track) =>
      sortClips(track.clips)
        .filter((clip): clip is Extract<TimelineClip, { kind: "mask" }> => clip.kind === "mask")
        .flatMap((clip) => {
          const window = windowTimeRange(clip.startMs, clip.startMs + clip.durationMs, range)
          if (!window) return []
          const width = Math.min(Math.max(1, clip.rect.width), state.canvas.width)
          const height = Math.min(Math.max(1, clip.rect.height), state.canvas.height)
          return [
            {
              id: clip.id,
              startMs: window.startMs,
              endMs: window.endMs,
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
            },
          ]
        }),
    )
}

function toZoomSegments(
  state: TimelineState,
  range: ExportRange | undefined,
): RenderPlanZoomSegment[] {
  return getManualZoomSegments(state)
    .filter((segment) => segment.enabled)
    .flatMap((segment) => {
      const window = windowTimeRange(segment.startMs, segment.startMs + segment.durationMs, range)
      if (!window) return []
      return [
        {
          id: segment.id,
          startMs: window.startMs,
          endMs: window.endMs,
          target: clampZoomTarget(segment.target, state.canvas),
          scale: segment.scale,
          easing: segment.easing,
          enabled: segment.enabled,
          mode: segment.mode,
          source: segment.source,
          preset: segment.preset,
        },
      ]
    })
    .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))
}

function toCursorEffects(
  state: TimelineState,
  range: ExportRange | undefined,
): RenderPlanCursorEffect[] {
  const track = state.tracks.find((candidate) => candidate.kind === "cursor")
  if (!track) return []
  return track.clips
    .filter(
      (clip): clip is Extract<TimelineClip, { kind: "cursor-effect" }> =>
        clip.kind === "cursor-effect" && clip.enabled,
    )
    .flatMap((clip) => {
      const window = windowTimeRange(clip.startMs, clip.startMs + clip.durationMs, range)
      if (!window) return []
      return [
        {
          id: clip.id,
          assetId: clip.assetId,
          startMs: window.startMs,
          endMs: window.endMs,
          enabled: clip.enabled,
          presetId: clip.presetId,
          scale: clip.scale,
          smoothing: clip.smoothing,
          settings: clip.settings,
        },
      ]
    })
    .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))
}

export function isTimelineAudioMuted(state: TimelineState): boolean {
  const audioTracks = state.tracks.filter((track) => track.kind === "audio")
  if (audioTracks.length === 0) return false
  const hasSoloTrack = audioTracks.some((track) => track.solo)
  return audioTracks.every((track) => track.muted || (hasSoloTrack && !track.solo))
}

function buildAudioTracks(state: TimelineState, range: ExportRange | undefined): RenderPlanAudio[] {
  const audioTracks = state.tracks.filter(
    (track) => track.kind === "audio" && track.clips.length > 0,
  )
  const hasSoloTrack = audioTracks.some((track) => track.solo)
  return audioTracks.flatMap((track) => {
    const clips = sortClips(track.clips).filter(
      (clip): clip is Extract<TimelineClip, { kind: "audio" }> => clip.kind === "audio",
    )
    const segments = toSegments(clips, range, true).map((segment, index) => ({
      ...segment,
      volume: Math.min(2, (clips[index]?.volume ?? 1) * track.volume),
    }))
    const firstAudioClip = clips[0]
    if (!firstAudioClip || segments.length === 0) return []
    return [
      {
        assetId: firstAudioClip.assetId,
        streamIndex: firstAudioClip.streamIndex,
        role: firstAudioClip.role,
        muted: track.muted || (hasSoloTrack && !track.solo),
        volume: track.volume,
        segments,
      },
    ]
  })
}

export interface BuildRenderPlanInput {
  state: TimelineState
  projectId: string
  captionMode?: RenderCaptionMode
  settings?: ProjectExportSettings
  range?: ExportRange
}

// Build a render plan from timeline metadata only. Rust resolves project assets
// and the destination path after validating the project identity.
export function buildRenderPlan(
  input: BuildRenderPlanInput,
): { ok: true; value: RenderPlan } | { ok: false; error: AppError } {
  const { state } = input
  if (!input.projectId.trim()) {
    return {
      ok: false,
      error: editorError("missing_project_id", "A saved project is required for export"),
    }
  }

  const requestedRange =
    input.range ??
    (input.settings?.preset === "selected-range" ? (input.settings.range ?? undefined) : undefined)
  const range = resolveRange(requestedRange)
  if (requestedRange && !range) {
    return {
      ok: false,
      error: editorError("invalid_export_range", "Export range must have a positive duration"),
    }
  }
  if (input.settings?.preset === "selected-range" && !range) {
    return {
      ok: false,
      error: editorError("missing_export_range", "Selected-range export requires a range"),
    }
  }

  const screenTrack = state.tracks.find((track) => track.kind === "screen")
  if (!screenTrack || screenTrack.clips.length === 0) {
    return {
      ok: false,
      error: editorError("no_screen_track", "Timeline has no screen track to render"),
    }
  }

  const segments = toSegments(screenTrack.clips, range)
  if (segments.length === 0) {
    return {
      ok: false,
      error: editorError(
        "empty_export_range",
        "The selected export range contains no screen media",
      ),
    }
  }

  const cameraTrack = state.tracks.find((track) => track.kind === "camera")
  const audioTracks = buildAudioTracks(state, range)
  const zoomSegments = toZoomSegments(state, range)
  const cursorEffects = toCursorEffects(state, range)
  const captions = toCaptions(state, range)
  const masks = toMasks(state, range)
  const screenDurationMs = segments.reduce(
    (duration, segment) => Math.max(duration, segment.outputEndMs),
    0,
  )
  const durationMs = range ? range.endMs - range.startMs : screenDurationMs
  const gaps = toGaps(segments, durationMs)

  if (captions.some((caption) => caption.endMs > durationMs)) {
    return {
      ok: false,
      error: editorError(
        "invalid_caption_range",
        "A caption extends beyond the rendered screen timeline",
      ),
    }
  }
  if (masks.some((mask) => mask.endMs > durationMs)) {
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

  const overlays = cameraTrack
    ? toOverlays(cameraTrack.clips, state.canvas, !cameraTrack.muted, range)
    : []
  const firstScreenAssetId = segments[0].assetId
  return {
    ok: true,
    value: {
      projectId: input.projectId,
      canvas: state.canvas,
      durationMs,
      segments,
      gaps,
      audio: audioTracks[0] ?? {
        assetId: firstScreenAssetId,
        muted: false,
        volume: 1,
        segments: [],
      },
      audioTracks,
      overlays,
      captions,
      captionMode: input.captionMode ?? input.settings?.captionMode ?? "burn-in",
      masks,
      zoomSegments,
      cursorEffects,
    },
  }
}
