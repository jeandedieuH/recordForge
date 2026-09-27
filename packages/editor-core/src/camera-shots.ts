import type { ManualZoomSegment, TimelineState, ZoomTarget } from "@recordforge/contracts"
import { canonicalizeZoomTarget, type CursorEngine } from "@recordforge/cursor-core"
import { resolveFollowCursorTargetAtTime } from "./preview-composition"

/**
 * Maximum gap between two zoom segments that still counts as one continuous
 * camera shot. Below it, the previous shot holds its target through the gap
 * instead of zooming out to 1x and the next segment pans in from that point.
 */
export const ZOOM_BRIDGE_GAP_MS = 800

export interface CameraShot extends ManualZoomSegment {
  /** Target the previous bridged shot ended on; this shot pans in from it. */
  fromTarget?: ZoomTarget
  /** Zoom scale the previous bridged shot ended on. */
  fromScale?: number
}

interface CameraShotCacheEntry {
  byEngine: WeakMap<CursorEngine, CameraShot[]>
  withoutEngine: CameraShot[] | null
}

// Shots are derived data; cache them per timeline state so per-frame preview
// resolution does not rebuild follow-cursor motion plans on every tick.
const cameraShotCache = new WeakMap<TimelineState, CameraShotCacheEntry>()

function computeCameraShots(state: TimelineState, cursorEngine: CursorEngine | null): CameraShot[] {
  const shots: CameraShot[] = (state.zoomSegments ?? [])
    .filter((segment) => segment.enabled)
    .map((segment) => ({ ...segment }))
    .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))

  for (let index = 0; index < shots.length - 1; index++) {
    const current = shots[index]
    const next = shots[index + 1]
    const effectiveEnd = current.startMs + current.durationMs
    const gap = next.startMs - effectiveEnd
    if (gap < 0 || gap > ZOOM_BRIDGE_GAP_MS) continue

    current.durationMs = next.startMs - current.startMs
    current.transitionOutMs = 0
    next.fromScale = current.scale
    next.fromTarget =
      (current.mode === "follow-cursor" && cursorEngine
        ? resolveFollowCursorTargetAtTime(
            current,
            state,
            current.startMs + current.durationMs,
            cursorEngine,
          )
        : undefined) ?? canonicalizeZoomTarget(current.target, state.canvas, current.scale)
  }

  return shots
}

/**
 * Resolve the effective camera shots for a timeline: enabled zoom segments in
 * order, with short gaps bridged so the camera never pops back to 1x between
 * adjacent focus points. Never mutates the timeline; callers receive copies.
 */
export function resolveCameraShots(
  state: TimelineState,
  cursorEngine?: CursorEngine | null,
): CameraShot[] {
  const engine = cursorEngine ?? null
  let entry = cameraShotCache.get(state)
  if (!entry) {
    entry = { byEngine: new WeakMap(), withoutEngine: null }
    cameraShotCache.set(state, entry)
  }

  const cached = engine ? entry.byEngine.get(engine) : entry.withoutEngine
  if (cached) return cached.map((shot) => ({ ...shot }))

  const shots = computeCameraShots(state, engine)
  if (engine) entry.byEngine.set(engine, shots)
  else entry.withoutEngine = shots
  return shots.map((shot) => ({ ...shot }))
}
