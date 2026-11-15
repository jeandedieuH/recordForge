import type {
  CaptionClip,
  ManualZoomSegment,
  TimelineClip,
  TimelineState,
} from "@recordforge/contracts"

/**
 * Timeline time-warp utility (spec 010 / modern-features F5).
 *
 * When a range of timeline time changes length — a clip retimed, a range
 * inserted or removed — every timeline-time entity has to follow. `warpTimeline`
 * applies one mapping to the whole state:
 *
 * - entities ending at or before the range are untouched;
 * - entities starting at or after the range shift by the duration delta under
 *   `ripple`, and stay put otherwise;
 * - entities overlapping the range scale their overlapping part proportionally
 *   (zoom segments, markers, caption clips + their display words).
 *
 * Media clips are never silently retimed here: a video/audio clip that only
 * overlaps the range keeps its timeline and source values, because changing
 * its length would break the `duration = (sourceOut − sourceIn) / speed`
 * invariant. The caller retimes the clips it owns and passes their ids in
 * `excludeClipIds`; `sourceWords` provenance is never touched so caption
 * resync keeps working.
 */
export interface TimeWarpOptions {
  /** Shift entities after the range by the duration delta. */
  ripple: boolean
  /** Clips the caller already retimed; their values are authoritative. */
  excludeClipIds?: ReadonlySet<string>
}

function scaleWithin(
  ms: number,
  startMs: number,
  oldDurationMs: number,
  newDurationMs: number,
): number {
  return startMs + ((ms - startMs) * newDurationMs) / oldDurationMs
}

function warpRegistrySpan(
  startMs: number,
  endMs: number,
  rangeStartMs: number,
  rangeEndMs: number,
  newDurationMs: number,
  ripple: boolean,
): { startMs: number; endMs: number } {
  const shift = newDurationMs - (rangeEndMs - rangeStartMs)
  if (endMs <= rangeStartMs) return { startMs, endMs }
  if (startMs >= rangeEndMs) {
    return ripple ? { startMs: startMs + shift, endMs: endMs + shift } : { startMs, endMs }
  }
  if (startMs >= rangeStartMs && endMs <= rangeEndMs) {
    return {
      startMs: scaleWithin(startMs, rangeStartMs, rangeEndMs - rangeStartMs, newDurationMs),
      endMs: scaleWithin(endMs, rangeStartMs, rangeEndMs - rangeStartMs, newDurationMs),
    }
  }
  // Straddles one or both range edges: scale the inside part, keep the
  // outside part anchored (and stretched by the delta when rippling).
  const nextStart =
    startMs >= rangeStartMs
      ? scaleWithin(startMs, rangeStartMs, rangeEndMs - rangeStartMs, newDurationMs)
      : startMs
  const nextEnd =
    endMs <= rangeEndMs
      ? scaleWithin(endMs, rangeStartMs, rangeEndMs - rangeStartMs, newDurationMs)
      : endMs + (ripple ? shift : 0)
  const minEnd = nextStart + 1
  return { startMs: nextStart, endMs: Math.max(nextEnd, minEnd) }
}

function warpCaptionClip(
  clip: CaptionClip,
  rangeStartMs: number,
  rangeEndMs: number,
  newDurationMs: number,
  ripple: boolean,
): CaptionClip {
  const startMs = clip.startMs
  const endMs = clipEndMs(clip)
  const warped = warpRegistrySpan(startMs, endMs, rangeStartMs, rangeEndMs, newDurationMs, ripple)
  if (warped.startMs === startMs && warped.endMs === endMs) return clip
  const ratio = clip.durationMs > 0 ? (warped.endMs - warped.startMs) / clip.durationMs : 1
  const words =
    ratio === 1
      ? clip.words
      : clip.words?.map((word) => ({
          ...word,
          startMs: Math.round(word.startMs * ratio),
          endMs: Math.max(Math.round(word.startMs * ratio) + 1, Math.round(word.endMs * ratio)),
        }))
  return {
    ...clip,
    startMs: Math.round(warped.startMs),
    durationMs: Math.max(1, Math.round(warped.endMs - warped.startMs)),
    ...(words ? { words } : {}),
  }
}

/** End of a clip on the timeline (clip ends are start + duration). */
function clipEndMs(clip: TimelineClip): number {
  return clip.startMs + clip.durationMs
}

function warpClip(
  clip: TimelineClip,
  rangeStartMs: number,
  rangeEndMs: number,
  newDurationMs: number,
  ripple: boolean,
): TimelineClip {
  if (clip.kind === "caption") {
    return warpCaptionClip(clip, rangeStartMs, rangeEndMs, newDurationMs, ripple)
  }
  const endMs = clip.startMs + clip.durationMs
  if (endMs <= rangeStartMs) return clip
  // Media clips are only moved, never rescaled in place (see the module doc).
  if (clip.startMs < rangeEndMs) return clip
  if (!ripple) return clip
  const shift = newDurationMs - (rangeEndMs - rangeStartMs)
  return { ...clip, startMs: Math.max(0, clip.startMs + shift) }
}

function warpZoomSegment(
  segment: ManualZoomSegment,
  rangeStartMs: number,
  rangeEndMs: number,
  newDurationMs: number,
  ripple: boolean,
): ManualZoomSegment {
  if (segment.locked) return segment
  const startMs = segment.startMs
  const endMs = startMs + segment.durationMs
  const warped = warpRegistrySpan(startMs, endMs, rangeStartMs, rangeEndMs, newDurationMs, ripple)
  const nextStart = Math.round(warped.startMs)
  return {
    ...segment,
    startMs: nextStart,
    durationMs: Math.max(1, Math.round(warped.endMs) - nextStart),
  }
}

/**
 * Remap every timeline-time entity after `[rangeStartMs, rangeEndMs)` changes
 * length. Returns the state unchanged for a degenerate range or a no-op warp.
 */
export function warpTimeline(
  state: TimelineState,
  rangeStartMs: number,
  rangeEndMs: number,
  newDurationMs: number,
  options: TimeWarpOptions,
): TimelineState {
  const oldDurationMs = rangeEndMs - rangeStartMs
  if (oldDurationMs <= 0 || newDurationMs <= 0) return state
  if (oldDurationMs === newDurationMs) return state
  const exclude = options.excludeClipIds
  const ripple = options.ripple
  const shift = newDurationMs - oldDurationMs

  const tracks = state.tracks.map((track) => {
    let changed = false
    const clips = track.clips.map((clip) => {
      if (exclude?.has(clip.id)) return clip
      const next = warpClip(clip, rangeStartMs, rangeEndMs, newDurationMs, ripple)
      if (next !== clip) changed = true
      return next
    })
    if (!changed) return track
    const sorted = [...clips].sort((left, right) => left.startMs - right.startMs)
    return { ...track, clips: sorted }
  })

  const zoomSegments = (state.zoomSegments ?? []).map((segment) =>
    warpZoomSegment(segment, rangeStartMs, rangeEndMs, newDurationMs, ripple),
  )

  const markers = state.markers.map((marker) => {
    if (marker.timeMs >= rangeEndMs) {
      return ripple ? { ...marker, timeMs: Math.max(0, marker.timeMs + shift) } : marker
    }
    if (marker.timeMs <= rangeStartMs) return marker
    return {
      ...marker,
      timeMs: Math.round(scaleWithin(marker.timeMs, rangeStartMs, oldDurationMs, newDurationMs)),
    }
  })

  return {
    ...state,
    tracks,
    zoomSegments,
    markers,
    updatedAt: new Date().toISOString(),
  }
}
