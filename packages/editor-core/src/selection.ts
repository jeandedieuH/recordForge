import {
  timelineSelectionSchema,
  type TimelineSelection,
  type TimelineSelectionKind,
  type TimelineState,
} from "@recordforge/contracts"
import { findClip } from "@recordforge/domain"
import { clipsInTimelineOrder, expandClipIdsThroughGroups } from "./grouping"

export type { TimelineSelection, TimelineSelectionKind }
export { timelineSelectionSchema }

// Type guards for the discriminated selection union.
export function isClipSelection(
  selection: TimelineSelection,
): selection is Extract<TimelineSelection, { kind: "clip" }> {
  return selection.kind === "clip"
}

export function isRangeSelection(
  selection: TimelineSelection,
): selection is Extract<TimelineSelection, { kind: "range" }> {
  return selection.kind === "range"
}

export function isMarkerSelection(
  selection: TimelineSelection,
): selection is Extract<TimelineSelection, { kind: "marker" }> {
  return selection.kind === "marker"
}

export function isZoomSelection(
  selection: TimelineSelection,
): selection is Extract<TimelineSelection, { kind: "zoom" }> {
  return selection.kind === "zoom"
}

type ClipSelection = Extract<TimelineSelection, { kind: "clip" }>

/** Create a single-clip selection. */
export function selectClip(clipId: string, trackId?: string): ClipSelection {
  return { kind: "clip", primaryClipId: clipId, clipIds: [clipId], trackId }
}

/** Create a multi-clip selection with a primary clip. */
export function selectClips(
  primaryClipId: string,
  clipIds: string[],
  trackId?: string,
): ClipSelection {
  return { kind: "clip", primaryClipId, clipIds, trackId }
}

/** Create a range selection. */
export function selectRange(
  startMs: number,
  endMs: number,
): Extract<TimelineSelection, { kind: "range" }> {
  return { kind: "range", startMs, endMs }
}

/** Create a marker selection. */
export function selectMarker(markerId: string): Extract<TimelineSelection, { kind: "marker" }> {
  return { kind: "marker", markerId }
}

/**
 * Toggle a clip in a multi selection. Pass `memberIds` (e.g. a clip's group
 * members) to toggle the whole set as one unit — the grouped clip id decides
 * add-vs-remove for the entire member set.
 */
export function toggleClipSelection(
  current: TimelineSelection,
  clipId: string,
  trackId?: string,
  memberIds?: string[],
): ClipSelection {
  if (!isClipSelection(current)) {
    return selectClip(clipId, trackId)
  }

  const ids = memberIds && memberIds.length > 0 ? memberIds : [clipId]
  const removing = current.clipIds.includes(clipId)
  const clipIds = removing
    ? current.clipIds.filter((id) => !ids.includes(id))
    : [...current.clipIds, ...ids.filter((id) => !current.clipIds.includes(id))]

  const primaryClipId =
    clipId === current.primaryClipId ? (clipIds[0] ?? current.primaryClipId) : clipId

  return { kind: "clip", primaryClipId, clipIds, trackId: trackId ?? current.trackId }
}

/** Union merge used by additive (Shift) marquee selection. */
export function mergeClipIds(base: readonly string[], added: readonly string[]): string[] {
  const merged = [...base]
  for (const id of added) {
    if (!merged.includes(id)) merged.push(id)
  }
  return merged
}

/** Every clip id on the timeline, in visual order. */
export function selectAllClipIds(state: TimelineState): string[] {
  return clipsInTimelineOrder(state).map(({ clip }) => clip.id)
}

/**
 * Shift-click extension: anchors on the selection's primary clip and selects a
 * positional range toward the clicked clip. Same-track clicks produce a
 * contiguous clip range on that track; cross-track clicks produce a block of
 * every clip intersecting the anchor→target time span. Group expansion then
 * pulls in any partially covered groups unless disabled (Alt-bypass).
 */
export function extendClipSelection(
  state: TimelineState,
  selection: ClipSelection | null,
  clipId: string,
  options?: { expandGroups?: boolean },
): ClipSelection | null {
  const target = findClip(state, clipId)
  if (!target) return selection

  const anchorFound = selection ? findClip(state, selection.primaryClipId) : undefined
  const anchor = anchorFound ?? target

  let clipIds: string[]
  if (anchor.track.id === target.track.id) {
    const minStart = Math.min(anchor.clip.startMs, target.clip.startMs)
    const maxStart = Math.max(anchor.clip.startMs, target.clip.startMs)
    clipIds = [...anchor.track.clips]
      .sort((a, b) => a.startMs - b.startMs)
      .filter((clip) => clip.startMs >= minStart && clip.startMs <= maxStart)
      .map((clip) => clip.id)
  } else {
    const fromMs = Math.min(anchor.clip.startMs, target.clip.startMs)
    const toMs = Math.max(
      anchor.clip.startMs + anchor.clip.durationMs,
      target.clip.startMs + target.clip.durationMs,
    )
    clipIds = clipsInTimelineOrder(state)
      .filter(({ clip }) => clip.startMs < toMs && clip.startMs + clip.durationMs > fromMs)
      .map(({ clip }) => clip.id)
  }

  if (options?.expandGroups !== false) {
    clipIds = expandClipIdsThroughGroups(state, clipIds)
  }
  if (clipIds.length === 0) return null
  return { kind: "clip", primaryClipId: clipId, clipIds, trackId: target.track.id }
}
