// Cut transition decisions for the screen preview.
//
// The screen surface is a pair of media elements: one plays the active preview
// segment, the other is pre-rolled to the next one. This module holds the two
// decisions that used to be inlined in `use-playback-clock` and turned a
// not-quite-ready standby into a playhead that bounced around a cut:
//
// 1. `planSegmentFrameTick` — how one presented frame moves the playhead. A
//    frame is always judged against the segment the playhead is already inside,
//    so a frame that belongs to a previous (or a deleted) range can never drag
//    the playhead backwards.
// 2. `planCutTransition` — what to do at a segment boundary: swap to the
//    pre-rolled standby, wait a moment for it, seek the active element, jump a
//    timeline gap, or stop.

import {
  classifyPreviewFrame,
  previewSegmentTimelineMs,
  type PreviewSegment,
} from "@recordforge/editor-core"

/** How long a cut may hold its last frame while the standby finishes seeking. */
export const DEFAULT_CUT_HOLD_MS = 180

export type SegmentFrameTick =
  { kind: "before-start" } | { kind: "past-end" } | { kind: "advance"; timelineMs: number }

export interface SegmentFrameTickInput {
  segment: PreviewSegment
  /** Timeline position the preview is currently at. */
  playheadMs: number
  /** Media time reported by the active element. */
  sourceMs: number
  /** One output frame: the tolerance for rounding at the segment's edges. */
  toleranceMs: number
}

/**
 * Decide how one presented media frame moves the playhead.
 *
 * `before-start` means the element is showing media from before this segment
 * (a frame from the retiring slot, or a seek that has not landed yet) and the
 * caller must re-seek instead of following it. `past-end` means the segment has
 * played out and the caller must cross the cut.
 */
export function planSegmentFrameTick(input: SegmentFrameTickInput): SegmentFrameTick {
  const toleranceMs = Math.max(0, input.toleranceMs)
  const { segment, playheadMs, sourceMs } = input

  const position = classifyPreviewFrame(segment, sourceMs, toleranceMs)
  if (position === "past-end") return { kind: "past-end" }
  if (position === "before-start") return { kind: "before-start" }

  // The playhead already sits on the segment's last frame: the cut is due even
  // when the media still reports a frame just inside the segment. Very short
  // segments skip this test so a cut can never fire at its own start.
  const segmentMs = segment.endMs - segment.startMs
  if (segmentMs > toleranceMs * 2 && playheadMs >= segment.endMs - toleranceMs) {
    return { kind: "past-end" }
  }

  return { kind: "advance", timelineMs: previewSegmentTimelineMs(segment, sourceMs) }
}

export type CutTransition =
  | { kind: "end" }
  | { kind: "gap" }
  | { kind: "swap" }
  | { kind: "seek" }
  | { kind: "hold"; pauseActive: boolean }

export interface CutTransitionInput {
  /** A segment follows the active one. */
  hasNext: boolean
  /** The next segment starts where the active one ends (no timeline gap). */
  contiguous: boolean
  /** The standby slot was pre-rolled for the next segment (it may still be seeking). */
  standbyHoldsNext: boolean
  /** The standby slot holds the next segment and can take over now. */
  standbyReady: boolean
  /** The active slot can accept a corrective seek right now. */
  activeSeekable: boolean
  /** Milliseconds this cut has been waiting for the standby; null on the first attempt. */
  heldMs: number | null
  /** Upper bound on that wait. */
  maxHoldMs?: number
}

/**
 * Decide how to cross a cut.
 *
 * A swap is preferred, then a short wait for a standby that is still seeking
 * (holding the last frame rather than playing deleted footage or seeking the
 * playing element), and only then the seek fallback.
 */
export function planCutTransition(input: CutTransitionInput): CutTransition {
  if (!input.hasNext) return { kind: "end" }
  if (!input.contiguous) return { kind: "gap" }
  if (input.standbyHoldsNext && input.standbyReady) return { kind: "swap" }
  // Never queue a second seek on an element that is already seeking: Chromium
  // aborts the in-flight request and the playhead stalls behind the media.
  if (!input.activeSeekable) return { kind: "hold", pauseActive: false }
  const waitedMs = input.heldMs ?? 0
  const maxHoldMs = input.maxHoldMs ?? DEFAULT_CUT_HOLD_MS
  if (input.standbyHoldsNext && waitedMs < maxHoldMs) return { kind: "hold", pauseActive: true }
  return { kind: "seek" }
}
