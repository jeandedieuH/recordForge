import type { TimelineClip, TimelineState } from "@recordforge/domain"

/** Timeline entities that can be used as a snap target. */
export type SnapTargetKind =
  "clip-edge" | "playhead" | "marker" | "caption-boundary" | "cursor-click"

export interface SnapTarget {
  id: string
  kind: SnapTargetKind
  timeMs: number
  priority: number
  label: string
}

export interface SnapOptions {
  enabled?: boolean
  thresholdMs?: number
  excludeClipId?: string
  playheadMs?: number
  cursorClickTimesMs?: number[]
  includeClipEdges?: boolean
  includeMarkers?: boolean
  includeCaptionBoundaries?: boolean
}

export interface SnapResult {
  timeMs: number
  snapped: boolean
  distanceMs: number
  target: SnapTarget | null
}

export interface ClipSnapResult extends SnapResult {
  edge: "start" | "end" | null
}

const DEFAULT_SNAP_THRESHOLD_MS = 120

// Higher priorities win ties. Intentional navigation points are preferred over
// derived clip boundaries so a marker or playhead remains easy to hit.
const SNAP_PRIORITY: Record<SnapTargetKind, number> = {
  playhead: 50,
  marker: 40,
  "cursor-click": 30,
  "caption-boundary": 20,
  "clip-edge": 10,
}

function addClipEdgeTargets(targets: SnapTarget[], clip: TimelineClip, excludeClipId?: string) {
  if (clip.id === excludeClipId) return
  targets.push(
    {
      id: `${clip.id}:start`,
      kind: "clip-edge",
      timeMs: clip.startMs,
      priority: SNAP_PRIORITY["clip-edge"],
      label: "Clip start",
    },
    {
      id: `${clip.id}:end`,
      kind: "clip-edge",
      timeMs: clip.startMs + clip.durationMs,
      priority: SNAP_PRIORITY["clip-edge"],
      label: "Clip end",
    },
  )
}

/** Build the deterministic target set used by move, trim, and range gestures. */
export function buildSnapTargets(state: TimelineState, options: SnapOptions = {}): SnapTarget[] {
  const targets: SnapTarget[] = []
  const includeClipEdges = options.includeClipEdges ?? true
  const includeMarkers = options.includeMarkers ?? true
  const includeCaptionBoundaries = options.includeCaptionBoundaries ?? true

  if (includeClipEdges) {
    for (const track of state.tracks) {
      for (const clip of track.clips) {
        addClipEdgeTargets(targets, clip, options.excludeClipId)
      }
    }
  }

  if (includeMarkers) {
    for (const marker of state.markers) {
      targets.push({
        id: marker.id,
        kind: "marker",
        timeMs: marker.timeMs,
        priority: SNAP_PRIORITY.marker,
        label: marker.label || "Marker",
      })
    }
  }

  if (includeCaptionBoundaries) {
    for (const track of state.tracks) {
      if (track.kind !== "captions") continue
      for (const clip of track.clips) {
        targets.push(
          {
            id: `${clip.id}:start`,
            kind: "caption-boundary",
            timeMs: clip.startMs,
            priority: SNAP_PRIORITY["caption-boundary"],
            label: "Caption start",
          },
          {
            id: `${clip.id}:end`,
            kind: "caption-boundary",
            timeMs: clip.startMs + clip.durationMs,
            priority: SNAP_PRIORITY["caption-boundary"],
            label: "Caption end",
          },
        )
      }
    }
  }

  if (options.playheadMs !== undefined) {
    targets.push({
      id: "playhead",
      kind: "playhead",
      timeMs: options.playheadMs,
      priority: SNAP_PRIORITY.playhead,
      label: "Playhead",
    })
  }

  for (const [index, timeMs] of (options.cursorClickTimesMs ?? []).entries()) {
    targets.push({
      id: `cursor-click:${index}`,
      kind: "cursor-click",
      timeMs,
      priority: SNAP_PRIORITY["cursor-click"],
      label: "Cursor click",
    })
  }

  return targets
    .filter((target) => Number.isFinite(target.timeMs) && target.timeMs >= 0)
    .sort((a, b) => a.timeMs - b.timeMs || b.priority - a.priority || a.id.localeCompare(b.id))
}

/** Snap a time to the closest eligible target, with deterministic tie-breaking. */
export function snapTime(
  timeMs: number,
  targets: readonly SnapTarget[],
  options: Pick<SnapOptions, "enabled" | "thresholdMs"> = {},
): SnapResult {
  const enabled = options.enabled ?? true
  const thresholdMs = options.thresholdMs ?? DEFAULT_SNAP_THRESHOLD_MS
  if (!enabled || thresholdMs <= 0 || targets.length === 0) {
    return { timeMs, snapped: false, distanceMs: Number.POSITIVE_INFINITY, target: null }
  }

  let best: SnapTarget | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const target of targets) {
    const distance = Math.abs(target.timeMs - timeMs)
    if (
      distance > thresholdMs ||
      distance > bestDistance ||
      (distance === bestDistance && best && target.priority < best.priority) ||
      (distance === bestDistance &&
        best &&
        target.priority === best.priority &&
        target.id >= best.id)
    ) {
      continue
    }
    best = target
    bestDistance = distance
  }

  if (!best) return { timeMs, snapped: false, distanceMs: Number.POSITIVE_INFINITY, target: null }
  return { timeMs: best.timeMs, snapped: true, distanceMs: bestDistance, target: best }
}

/** Snap a clip start while considering both the clip's leading and trailing edge. */
export function snapClipStart(
  startMs: number,
  durationMs: number,
  targets: readonly SnapTarget[],
  options: Pick<SnapOptions, "enabled" | "thresholdMs"> = {},
): ClipSnapResult {
  const startResult = snapTime(startMs, targets, options)
  const endResult = snapTime(startMs + durationMs, targets, options)
  const endDistance = endResult.snapped ? endResult.distanceMs : Number.POSITIVE_INFINITY
  if (endDistance < startResult.distanceMs) {
    return {
      ...endResult,
      timeMs: Math.max(0, endResult.timeMs - durationMs),
      edge: "end",
    }
  }
  return { ...startResult, edge: startResult.snapped ? "start" : null }
}

/** Snap a trim edge without changing the opposite edge. */
export function snapTrimEdge(
  edge: "start" | "end",
  timeMs: number,
  targets: readonly SnapTarget[],
  options: Pick<SnapOptions, "enabled" | "thresholdMs"> = {},
): ClipSnapResult {
  const result = snapTime(timeMs, targets, options)
  return { ...result, edge: result.snapped ? edge : null }
}

/** Convenience helper for callers that do not need to retain the target list. */
export function snapTimelineTime(
  state: TimelineState,
  timeMs: number,
  options: SnapOptions = {},
): SnapResult {
  return snapTime(timeMs, buildSnapTargets(state, options), options)
}

export const snapDefaults = {
  thresholdMs: DEFAULT_SNAP_THRESHOLD_MS,
} as const
