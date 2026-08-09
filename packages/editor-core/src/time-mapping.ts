import type { TimelineClip, TimelineState, TimelineTrackKind } from "@recordforge/domain"

// Time mapping between the three domains used by the editor:
//
// - Source time: a position in an immutable source asset (ms).
// - Timeline time: a position in the editable project, including gaps (ms).
// - Output time: a position in the final rendered file (ms).
//
// By default output preserves the timeline position of every clip so that
// intentional gaps become silence/filler. A `squeezeGaps` mode is provided
// for callers that need a compressed output (e.g. legacy render previews).

/** One contiguous source/timeline interval for a clip. */
export interface TimelineSegment {
  clipId: string
  assetId: string
  streamIndex: number | undefined
  startMs: number
  endMs: number
  sourceInMs: number
  sourceOutMs: number
  speed: number
}

/** Result of a source-to-timeline lookup. */
export interface SourceToTimelineResult {
  clipId: string
  timelineMs: number
  unambiguous: boolean
}

/** Compute the timeline duration for a source range and a speed factor. */
export function clipDurationFromSourceRange(
  sourceInMs: number,
  sourceOutMs: number,
  speed: number,
): number {
  if (speed <= 0) return 0
  return Math.max(0, (sourceOutMs - sourceInMs) / speed)
}

/** True when `ms` falls inside the clip's timeline interval (inclusive start). */
export function isInsideClip(clip: TimelineClip, timelineMs: number): boolean {
  const endMs = clip.startMs + clip.durationMs
  return timelineMs >= clip.startMs && timelineMs <= endMs
}

/**
 * Convert a timeline position inside a clip into a source position.
 *
 * Returns `null` when the position is outside the clip's timeline range.
 */
export function timelineToSource(clip: TimelineClip, timelineMs: number): number | null {
  if (!isInsideClip(clip, timelineMs)) return null
  return clip.sourceInMs + (timelineMs - clip.startMs) * clip.speed
}

/**
 * Convert a source position inside a clip into a timeline position.
 *
 * Returns `null` when the source position is outside the clip's source range.
 */
export function sourceToClipTime(clip: TimelineClip, sourceMs: number): number | null {
  if (sourceMs < clip.sourceInMs || sourceMs > clip.sourceOutMs) return null
  return clip.startMs + (sourceMs - clip.sourceInMs) / clip.speed
}

/**
 * Build the continuous source-to-timeline map for every clip that references
 * `assetId`. Clips are returned sorted by timeline start so callers can scan
 * for the active segment at a given output time.
 */
export function buildTimelineSegments(state: TimelineState, assetId: string): TimelineSegment[] {
  const segments: TimelineSegment[] = []

  for (const track of state.tracks) {
    for (const clip of track.clips) {
      if (clip.assetId !== assetId) continue
      segments.push({
        clipId: clip.id,
        assetId: clip.assetId,
        streamIndex: clip.streamIndex,
        startMs: clip.startMs,
        endMs: clip.startMs + clip.durationMs,
        sourceInMs: clip.sourceInMs,
        sourceOutMs: clip.sourceOutMs,
        speed: clip.speed,
      })
    }
  }

  return segments.sort((a, b) => a.startMs - b.startMs)
}

/** Find every clip in the state that references the given asset. */
function findClipsForAsset(state: TimelineState, assetId: string): TimelineClip[] {
  const clips: TimelineClip[] = []
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      if (clip.assetId === assetId) clips.push(clip)
    }
  }
  return clips.sort((a, b) => a.startMs - b.startMs)
}

/** A source position paired with the exact timeline clip that owns it. */
export interface TimelinePlaybackPosition {
  clip: TimelineClip
  clipId: string
  sourceMs: number
}

function findTrackClips(
  state: TimelineState,
  trackKind: TimelineTrackKind,
  trackId?: string,
): TimelineClip[] {
  const track = state.tracks.find((candidate) => {
    if (candidate.kind !== trackKind) return false
    return trackId ? candidate.id === trackId : true
  })
  return track ? [...track.clips].sort((a, b) => a.startMs - b.startMs) : []
}

/** Find a clip at timeline time on one authoritative playback track. */
export function findTimelineClipAt(
  state: TimelineState,
  trackKind: TimelineTrackKind,
  timelineMs: number,
  trackId?: string,
): TimelineClip | null {
  return (
    findTrackClips(state, trackKind, trackId).find(
      (clip) => timelineMs >= clip.startMs && timelineMs < clip.startMs + clip.durationMs,
    ) ?? null
  )
}

/** Find the next clip on a track, including a clip that starts at `timelineMs`. */
export function findNextTimelineClip(
  state: TimelineState,
  trackKind: TimelineTrackKind,
  timelineMs: number,
  trackId?: string,
): TimelineClip | null {
  return (
    findTrackClips(state, trackKind, trackId).find((clip) => clip.startMs >= timelineMs) ?? null
  )
}

/**
 * Convert a timeline position into source time for one track kind.
 *
 * Playback uses a single track (normally the screen track) so camera or audio
 * clips sharing the same source asset cannot make the mapping ambiguous.
 */
export function timelineToSourceForTrack(
  state: TimelineState,
  trackKind: TimelineTrackKind,
  timelineMs: number,
  trackId?: string,
): TimelinePlaybackPosition | null {
  const clip = findTimelineClipAt(state, trackKind, timelineMs, trackId)
  if (!clip) return null
  const sourceMs = timelineToSource(clip, timelineMs)
  if (sourceMs === null) return null
  return { clip, clipId: clip.id, sourceMs }
}

/** Convert source time back to timeline time on one authoritative track. */
export function sourceToTimelineForTrack(
  state: TimelineState,
  trackKind: TimelineTrackKind,
  assetId: string,
  sourceMs: number,
  options?: { preferClipId?: string; trackId?: string },
): SourceToTimelineResult | null {
  const candidates = findTrackClips(state, trackKind, options?.trackId).filter((clip) => {
    if (clip.assetId !== assetId) return false
    if (options?.preferClipId && clip.id !== options.preferClipId) return false
    return sourceMs >= clip.sourceInMs && sourceMs <= clip.sourceOutMs
  })
  const first = candidates[0]
  if (!first) return null
  const timelineMs = sourceToClipTime(first, sourceMs)
  if (timelineMs === null) return null
  return {
    clipId: first.id,
    timelineMs,
    unambiguous: candidates.length === 1,
  }
}

/**
 * Convert a source position into the timeline position where it is played.
 *
 * If the same source segment appears in multiple clips (e.g. a duplicated
 * range) the result is marked `unambiguous: false`. Callers that need a
 * unique mapping should pass `preferClipId` to select a specific clip.
 */
export function sourceToTimeline(
  state: TimelineState,
  assetId: string,
  sourceMs: number,
  options?: { preferClipId?: string },
): SourceToTimelineResult | null {
  const candidates = findClipsForAsset(state, assetId).filter((clip) => {
    if (options?.preferClipId && clip.id !== options.preferClipId) return false
    return sourceMs >= clip.sourceInMs && sourceMs <= clip.sourceOutMs
  })

  if (candidates.length === 0) return null

  const first = candidates[0]
  const timelineMs = sourceToClipTime(first, sourceMs)
  if (timelineMs === null) return null

  return {
    clipId: first.id,
    timelineMs,
    unambiguous: candidates.length === 1,
  }
}

/** Find the clip active at a given timeline time. */
function findClipAtTimelineTime(state: TimelineState, timelineMs: number): TimelineClip | null {
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      if (isInsideClip(clip, timelineMs)) return clip
    }
  }
  return null
}

/**
 * Convert a timeline position into a source position for the clip active at
 * that time.
 *
 * Returns `null` when the position falls in a gap and no clip is active.
 */
export function timelineToSourceForState(
  state: TimelineState,
  timelineMs: number,
): { clipId: string; sourceMs: number } | null {
  const clip = findClipAtTimelineTime(state, timelineMs)
  if (!clip) return null
  const sourceMs = timelineToSource(clip, timelineMs)
  if (sourceMs === null) return null
  return { clipId: clip.id, sourceMs }
}

/**
 * Convert a timeline position to an output position.
 *
 * When `squeezeGaps` is `false` (default) output preserves the timeline
 * position of every clip, so gaps become silent/black frames. When `true`,
 * the output compresses clips together and removes the duration of gaps.
 */
export function timelineToOutput(
  state: TimelineState,
  timelineMs: number,
  options?: { squeezeGaps?: boolean },
): number {
  if (timelineMs < 0) return 0
  if (!options?.squeezeGaps) return timelineMs

  // Squeeze: subtract the total gap duration that occurs before this point.
  const segments = allTimelineSegments(state)
  let gapMs = 0
  let lastEnd = 0

  for (const segment of segments) {
    if (segment.startMs >= timelineMs) break
    if (segment.startMs > lastEnd) {
      const gapStart = lastEnd
      const gapEnd = Math.min(segment.startMs, timelineMs)
      gapMs += Math.max(0, gapEnd - gapStart)
    }
    const segmentEnd = Math.min(segment.endMs, timelineMs)
    lastEnd = Math.max(lastEnd, segmentEnd)
    if (lastEnd >= timelineMs) break
  }

  // Add any trailing gap before timelineMs.
  if (lastEnd < timelineMs) gapMs += timelineMs - lastEnd

  return Math.max(0, timelineMs - gapMs)
}

/**
 * Convert an output position back to a timeline position.
 *
 * Requires the same `squeezeGaps` mode used for `timelineToOutput`.
 */
export function outputToTimeline(
  state: TimelineState,
  outputMs: number,
  options?: { squeezeGaps?: boolean },
): number | null {
  if (outputMs < 0) return null
  if (!options?.squeezeGaps) return outputMs

  const segments = allTimelineSegments(state)
  let consumedOutput = 0
  let lastEnd = 0

  for (const segment of segments) {
    const segmentDuration = segment.endMs - segment.startMs
    if (consumedOutput + segmentDuration >= outputMs) {
      return segment.startMs + (outputMs - consumedOutput)
    }
    consumedOutput += segmentDuration
    lastEnd = segment.endMs
  }

  // Output falls after the last segment, map to a trailing gap.
  return lastEnd + (outputMs - consumedOutput)
}

/** Get every video/audio clip on the timeline sorted by start time. */
function allTimelineSegments(state: TimelineState): TimelineSegment[] {
  const segments: TimelineSegment[] = []
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === "screen" || clip.kind === "camera" || clip.kind === "audio") {
        segments.push({
          clipId: clip.id,
          assetId: clip.assetId,
          streamIndex: clip.streamIndex,
          startMs: clip.startMs,
          endMs: clip.startMs + clip.durationMs,
          sourceInMs: clip.sourceInMs,
          sourceOutMs: clip.sourceOutMs,
          speed: clip.speed,
        })
      }
    }
  }
  return segments.sort((a, b) => a.startMs - b.startMs)
}
