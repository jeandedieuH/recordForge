import type { TimelineClip, TimelineTrack } from "@recordforge/contracts"

export type TrimLimit = "source-start" | "source-end" | "neighbor" | "min-duration"

export interface ClampTrimEdgeOptions {
  edge: "start" | "end"
  edgeMs: number
  // Clip snapshot captured at gesture START — drafts rewrite clip.startMs,
  // so clamping must run against the pre-gesture geometry.
  clip: TimelineClip
  frameMs: number
  prevEndMs: number | null
  nextStartMs: number | null
  sourceDurationMs?: number
}

export interface ClampTrimEdgeResult {
  edgeMs: number
  // Why the requested edge could not be honored; null when it fits freely.
  limit: TrimLimit | null
}

// Only true source-backed media can hit a source-media trim limit; overlays
// and effects resize freely within their neighbors.
const MEDIA_KINDS: ReadonlySet<TimelineClip["kind"]> = new Set(["screen", "camera", "audio"])

function isMediaClip(clip: TimelineClip): boolean {
  return MEDIA_KINDS.has(clip.kind)
}

/**
 * Clamps a trim edge against source media bounds, neighboring clips, and the
 * minimum clip duration. Mirrors the limits enforced by buildTrimCommand in
 * use-timeline-interaction.ts (sourceOut clamps to
 * max(sourceDurationMs, clip.sourceOutMs)) so the HUD can name the binding
 * limit instead of silently sticking.
 */
export function clampTrimEdge(options: ClampTrimEdgeOptions): ClampTrimEdgeResult {
  const { edge, clip, frameMs, prevEndMs, nextStartMs, sourceDurationMs } = options
  const edgeMs = Math.round(options.edgeMs)
  const media = isMediaClip(clip)
  const clipEndMs = clip.startMs + clip.durationMs

  if (edge === "start") {
    const sourceLower = media
      ? clip.startMs - clip.sourceInMs / clip.speed
      : Number.NEGATIVE_INFINITY
    const lower = Math.max(0, prevEndMs ?? 0, sourceLower)
    const upper = clipEndMs - frameMs
    if (edgeMs < lower) {
      const limit: TrimLimit =
        sourceLower >= Math.max(0, prevEndMs ?? 0) ? "source-start" : "neighbor"
      return { edgeMs: Math.round(lower), limit }
    }
    if (edgeMs > upper) return { edgeMs: Math.round(upper), limit: "min-duration" }
    return { edgeMs, limit: null }
  }

  const sourceUpper =
    media && sourceDurationMs !== undefined
      ? clip.startMs + (Math.max(sourceDurationMs, clip.sourceOutMs) - clip.sourceInMs) / clip.speed
      : Number.POSITIVE_INFINITY
  const neighborUpper = nextStartMs ?? Number.POSITIVE_INFINITY
  const upper = Math.min(neighborUpper, sourceUpper)
  const lower = clip.startMs + frameMs
  if (edgeMs > upper) {
    const limit: TrimLimit = sourceUpper <= neighborUpper ? "source-end" : "neighbor"
    return { edgeMs: Math.round(upper), limit }
  }
  if (edgeMs < lower) return { edgeMs: Math.round(lower), limit: "min-duration" }
  return { edgeMs, limit: null }
}

/** True when another clip on the track intersects [startMs, startMs + durationMs). */
export function moveOverlaps(
  track: TimelineTrack,
  clipId: string,
  startMs: number,
  durationMs: number,
): boolean {
  const endMs = startMs + durationMs
  return track.clips.some(
    (clip) =>
      clip.id !== clipId && clip.startMs < endMs && clip.startMs + clip.durationMs > startMs,
  )
}

/**
 * Auto-scroll speed for a pointer within `zonePx` of a horizontal edge.
 * Quadratic ease: 0 at the zone boundary, `maxSpeedPx` at the edge (and for
 * pointers dragged outside the element entirely).
 */
export function edgeScrollDelta(
  clientX: number,
  left: number,
  right: number,
  zonePx = 56,
  maxSpeedPx = 22,
): number {
  const fromLeft = clientX - left
  if (fromLeft < zonePx) {
    const t = Math.min(1, Math.max(0, (zonePx - fromLeft) / zonePx))
    return -maxSpeedPx * t * t
  }
  const fromRight = right - clientX
  if (fromRight < zonePx) {
    const t = Math.min(1, Math.max(0, (zonePx - fromRight) / zonePx))
    return maxSpeedPx * t * t
  }
  return 0
}
