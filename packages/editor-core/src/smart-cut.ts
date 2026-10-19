import type { TimelineState } from "@recordforge/domain"

// Smart Cut: a silence window the backend detected on the edited timeline's
// mixed audio, in output-timeline milliseconds.
export interface SmartCutRange {
  startMs: number
  endMs: number
}

// Below this a cut is more damage than value — the residual pause is so short
// removing it makes speech feel clipped instead of tight.
const SMART_CUT_MIN_CUT_MS = 80

export interface PrepareSmartCutRangesInput {
  ranges: readonly { startMs: number; endMs: number }[]
  durationMs: number
  paddingMs?: number
}

export interface SmartCutAnalysis {
  ranges: SmartCutRange[]
  // True only when detected silences existed but their union covered the whole
  // timeline — the caller should say "no safe cuts", not "no pauses found".
  wholeTimeline: boolean
}

// Normalize raw silencedetect ranges into safe ripple-delete cuts. Order:
// drop malformed input → clamp bounds into [0, durationMs] (negative starts
// clamp to 0, overshoot ends clamp to duration) → merge overlapping/adjacent
// → keep `paddingMs` of detected silence on each cut edge so speech is never
// clipped (except at the physical timeline ends, where there is nothing to
// preserve) → discard sub-minimum cuts → never produce a set that deletes the
// whole project.
export function analyzeSmartCutRanges(input: PrepareSmartCutRangesInput): SmartCutAnalysis {
  const { durationMs } = input
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return { ranges: [], wholeTimeline: false }
  }
  const duration = Math.floor(durationMs)
  const padding =
    Number.isFinite(input.paddingMs) && (input.paddingMs ?? 0) > 0
      ? Math.floor(input.paddingMs ?? 0)
      : 0

  const clamped: SmartCutRange[] = []
  for (const range of input.ranges) {
    // Only finite, integer-ms bounds are actionable — anything else is dropped.
    if (!Number.isInteger(range.startMs) || !Number.isInteger(range.endMs)) continue
    const startMs = Math.min(Math.max(range.startMs, 0), duration)
    const endMs = Math.min(Math.max(range.endMs, 0), duration)
    if (endMs > startMs) clamped.push({ startMs, endMs })
  }
  clamped.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)

  const merged: SmartCutRange[] = []
  for (const range of clamped) {
    const last = merged[merged.length - 1]
    if (last && range.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, range.endMs)
    } else {
      merged.push({ ...range })
    }
  }

  const cuts: SmartCutRange[] = []
  for (const range of merged) {
    const startMs = range.startMs + (range.startMs > 0 ? padding : 0)
    const endMs = range.endMs - (range.endMs < duration ? padding : 0)
    if (endMs - startMs >= SMART_CUT_MIN_CUT_MS) cuts.push({ startMs, endMs })
  }

  // A union covering the entire timeline would delete the project — report no
  // cuts instead (e.g. an all-silent recording) and flag why.
  if (cuts.length > 0 && rangesCover(cuts, duration)) {
    return { ranges: [], wholeTimeline: true }
  }
  return { ranges: cuts, wholeTimeline: false }
}

export function prepareSmartCutRanges(input: PrepareSmartCutRangesInput): SmartCutRange[] {
  return analyzeSmartCutRanges(input).ranges
}

function rangesCover(cuts: SmartCutRange[], durationMs: number): boolean {
  let cursor = 0
  for (const cut of cuts) {
    if (cut.startMs > cursor) return false
    cursor = Math.max(cursor, cut.endMs)
  }
  return cursor >= durationMs
}

// A ripple delete cuts and shifts everything at/after the earliest cut start.
// The engine leaves locked tracks untouched, so applying while a locked track
// sits downstream of a cut silently desyncs it — callers must refuse first.
export function lockedTracksBlockingRanges(
  state: TimelineState,
  ranges: readonly SmartCutRange[],
): string[] {
  if (ranges.length === 0) return []
  // Reduce, not spread — review lists can be arbitrarily long.
  const minStart = ranges.reduce((min, range) => Math.min(min, range.startMs), Infinity)
  const names: string[] = []
  for (const track of state.tracks) {
    if (!track.locked) continue
    const clipAffected = track.clips.some((clip) => clip.startMs + clip.durationMs > minStart)
    // Zoom segments live off-track in state.zoomSegments; a locked zoom lane
    // keeps them in place while the rest of the timeline ripples.
    const zoomAffected =
      track.kind === "zoom" &&
      (state.zoomSegments ?? []).some((segment) => segment.startMs + segment.durationMs > minStart)
    if (clipAffected || zoomAffected) names.push(track.name)
  }
  return names
}
