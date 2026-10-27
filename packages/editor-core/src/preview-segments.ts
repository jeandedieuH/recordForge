// Preview segmentation for the editor's seamless A/B media slots.
//
// A Smart Cut timeline can hold hundreds of clips that are really one
// continuous source read with holes punched out. This module fuses edited
// clips into the spans a media element can play without a seek: output
// contiguous, source continuous, same source and same speed.

import type { TimelineClip } from "@recordforge/domain"

export interface PreviewSegment {
  /** Timeline window this segment covers. */
  startMs: number
  endMs: number
  /** Source range played inside the window. */
  sourceInMs: number
  sourceOutMs: number
  speed: number
  /** Identity of the underlying media (resolved by the caller per track). */
  sourceKey: string
  /** Every clip whose output was fused into this segment. */
  clipIds: string[]
}

/**
 * Build the playable spans for one track. Clips are sorted by output and
 * merged only when playback can continue in the same media element: adjacent
 * output, continuous source, same speed and the same source key.
 */
export function buildPreviewSegments(
  clips: TimelineClip[],
  sourceKeyOf: (clip: TimelineClip) => string,
): PreviewSegment[] {
  const sorted = clips
    .filter((clip) => clip.durationMs > 0)
    .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))

  const segments: PreviewSegment[] = []
  for (const clip of sorted) {
    const sourceKey = sourceKeyOf(clip)
    const speed = clip.speed > 0 ? clip.speed : 1
    const clipEndMs = clip.startMs + clip.durationMs
    const last = segments[segments.length - 1]
    const fuses =
      last !== undefined &&
      last.endMs === clip.startMs &&
      last.speed === speed &&
      last.sourceKey === sourceKey &&
      last.sourceOutMs === clip.sourceInMs
    if (last && fuses) {
      last.endMs = clipEndMs
      last.sourceOutMs = clip.sourceOutMs
      last.clipIds.push(clip.id)
      continue
    }
    segments.push({
      startMs: clip.startMs,
      endMs: clipEndMs,
      sourceInMs: clip.sourceInMs,
      sourceOutMs: clip.sourceOutMs,
      speed,
      sourceKey,
      clipIds: [clip.id],
    })
  }
  return segments
}

/** Index of the segment covering `timelineMs`, or -1 in a gap. */
export function previewSegmentAt(segments: PreviewSegment[], timelineMs: number): number {
  let low = 0
  let high = segments.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const segment = segments[middle]!
    if (timelineMs < segment.startMs) {
      high = middle - 1
    } else if (timelineMs >= segment.endMs) {
      low = middle + 1
    } else {
      return middle
    }
  }
  return -1
}

/**
 * The segment a standby slot should pre-roll: the one starting where the
 * active segment ends, or the next one after the playhead when it sits in a
 * gap. -1 when nothing follows.
 */
export function nextPreviewSegment(segments: PreviewSegment[], timelineMs: number): number {
  const active = previewSegmentAt(segments, timelineMs)
  const fromMs = active >= 0 ? segments[active]!.endMs : timelineMs
  let low = 0
  let high = segments.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (segments[middle]!.startMs < fromMs) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return low < segments.length ? low : -1
}
