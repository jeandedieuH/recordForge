import { previewSegmentSourceMs, type PreviewSegment } from "@recordforge/editor-core"

/** Seek just before the segment end so the browser presents the final frame. */
export const FREEZE_TAIL_SOURCE_LEAD_MS = 1

export interface FreezeTailFrame {
  /** Source timestamp (ms) the video element should hold. */
  sourceMs: number
}

/**
 * Preview state for an overlay-only tail: the playhead is past the last screen
 * segment but still inside content that extends to `contentEndMs`. The media
 * element must stay visible on its final frame while the virtual clock advances.
 *
 * Returns `null` for normal playback, mid-timeline gaps and after the tail.
 */
export function resolveFreezeTailFrame(
  playheadMs: number,
  segments: PreviewSegment[],
  contentEndMs: number,
): FreezeTailFrame | null {
  const last = segments[segments.length - 1]
  if (!last || contentEndMs <= last.endMs) return null
  if (playheadMs < last.endMs || playheadMs > contentEndMs) return null
  return {
    sourceMs: Math.max(0, previewSegmentSourceMs(last, last.endMs) - FREEZE_TAIL_SOURCE_LEAD_MS),
  }
}
