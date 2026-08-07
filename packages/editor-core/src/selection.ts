import {
  timelineSelectionSchema,
  type TimelineSelection,
  type TimelineSelectionKind,
} from "@recordforge/contracts"

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

/** Create a single-clip selection. */
export function selectClip(
  clipId: string,
  trackId?: string,
): Extract<TimelineSelection, { kind: "clip" }> {
  return { kind: "clip", primaryClipId: clipId, clipIds: [clipId], trackId }
}

/** Create a multi-clip selection with a primary clip. */
export function selectClips(
  primaryClipId: string,
  clipIds: string[],
  trackId?: string,
): Extract<TimelineSelection, { kind: "clip" }> {
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

/** Toggle a clip in a multi selection. */
export function toggleClipSelection(
  current: TimelineSelection,
  clipId: string,
  trackId?: string,
): Extract<TimelineSelection, { kind: "clip" }> {
  if (!isClipSelection(current)) {
    return selectClip(clipId, trackId)
  }

  const clipIds = current.clipIds.includes(clipId)
    ? current.clipIds.filter((id) => id !== clipId)
    : [...current.clipIds, clipId]

  const primaryClipId =
    clipId === current.primaryClipId ? (clipIds[0] ?? current.primaryClipId) : clipId

  return { kind: "clip", primaryClipId, clipIds, trackId: trackId ?? current.trackId }
}
