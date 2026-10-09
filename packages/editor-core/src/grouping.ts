import type { TimelineClip, TimelineState, TimelineTrack } from "@recordforge/contracts"

// Clip groups: clips sharing a `groupId` act as one unit for selection-driven
// operations (move, delete, duplicate, nudge). Grouping is an editing aid only
// — the render plan ignores it — and single-clip commands like trim or split
// still operate on the individual clip so users can break symmetry on purpose.

export function getClipGroupId(clip: TimelineClip | null | undefined): string | undefined {
  if (!clip) return undefined
  return "groupId" in clip && typeof clip.groupId === "string" && clip.groupId.length > 0
    ? clip.groupId
    : undefined
}

export function isClipGrouped(clip: TimelineClip | null | undefined): boolean {
  return getClipGroupId(clip) !== undefined
}

/**
 * Flattened clip list in visual order: tracks top-to-bottom, clips left-to-right.
 * Used anywhere selection needs a deterministic "next clip" or stable ordering.
 */
export function clipsInTimelineOrder(
  state: TimelineState,
): Array<{ track: TimelineTrack; clip: TimelineClip }> {
  const entries: Array<{ track: TimelineTrack; clip: TimelineClip }> = []
  for (const track of state.tracks) {
    const sorted = [...track.clips].sort(
      (a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id),
    )
    for (const clip of sorted) {
      entries.push({ track, clip })
    }
  }
  return entries
}

/** All member ids of a group, in timeline order. */
export function getGroupMemberIds(state: TimelineState, groupId: string): string[] {
  return clipsInTimelineOrder(state)
    .filter(({ clip }) => getClipGroupId(clip) === groupId)
    .map(({ clip }) => clip.id)
}

/**
 * Expand a clip-id set so it contains complete groups: every clip that shares
 * a groupId with any listed clip is pulled in. Output is deduped and ordered in
 * timeline order so selection renders predictably. Unknown ids are dropped.
 */
export function expandClipIdsThroughGroups(
  state: TimelineState,
  clipIds: readonly string[],
): string[] {
  const requested = new Set(clipIds)
  const groups = new Set<string>()
  const entries = clipsInTimelineOrder(state)
  for (const { clip } of entries) {
    if (!requested.has(clip.id)) continue
    const groupId = getClipGroupId(clip)
    if (groupId) groups.add(groupId)
  }
  if (groups.size === 0)
    return entries.filter(({ clip }) => requested.has(clip.id)).map((e) => e.clip.id)
  return entries
    .filter(({ clip }) => {
      if (requested.has(clip.id)) return true
      const groupId = getClipGroupId(clip)
      return groupId !== undefined && groups.has(groupId)
    })
    .map(({ clip }) => clip.id)
}
