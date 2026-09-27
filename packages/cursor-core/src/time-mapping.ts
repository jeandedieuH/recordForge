import type { CursorTelemetryFile, TimelineState } from "@recordforge/contracts"

/**
 * Map a source cursor point into zoom space: normalized screen coordinates
 * stretched onto the full canvas (x = sourceX/sourceWidth * canvasWidth). Zoom
 * targets live in this space, so unlike `fitCursorPoint` this ignores letterbox
 * fit and padding — a point on the source edge lands on the canvas edge.
 */
export function sourcePointToZoomSpace(
  telemetry: Pick<CursorTelemetryFile, "sourceWidth" | "sourceHeight">,
  canvas: { width: number; height: number },
  point: { x: number; y: number },
): { x: number; y: number } {
  const sourceWidth = Math.max(1, telemetry.sourceWidth)
  const sourceHeight = Math.max(1, telemetry.sourceHeight)
  const sourceX = Math.min(sourceWidth, Math.max(0, point.x))
  const sourceY = Math.min(sourceHeight, Math.max(0, point.y))
  return {
    x: (sourceX / sourceWidth) * canvas.width,
    y: (sourceY / sourceHeight) * canvas.height,
  }
}

export interface TimelineOccurrence {
  timeMs: number
  /** Timeline ms per source ms for the clip that produced this occurrence. */
  clipRatio: number
}

/**
 * Map a cursor source timestamp to every timeline position that plays it,
 * also returning each clip's source→timeline rate so event durations survive
 * speed changes. A duplicated source range maps to multiple occurrences.
 */
export function cursorSourceToTimelineOccurrences(
  state: TimelineState,
  sourceMs: number,
): TimelineOccurrence[] {
  const occurrences: TimelineOccurrence[] = []
  for (const track of state.tracks) {
    if (track.kind !== "screen") continue
    for (const clip of track.clips) {
      const sourceSpan = clip.sourceOutMs - clip.sourceInMs
      if (sourceSpan <= 0) continue
      if (sourceMs < clip.sourceInMs || sourceMs >= clip.sourceOutMs) continue
      const clipRatio = clip.durationMs / sourceSpan
      occurrences.push({
        timeMs: clip.startMs + (sourceMs - clip.sourceInMs) * clipRatio,
        clipRatio,
      })
    }
  }
  return occurrences.sort((left, right) => left.timeMs - right.timeMs)
}

/**
 * Inverse of `timelineToCursorSourceTime` across every screen clip: each clip
 * whose [sourceInMs, sourceOutMs) range contains `sourceMs` produces one
 * timeline position (a duplicated source range maps to multiple times).
 */
export function cursorSourceToTimelineTimes(state: TimelineState, sourceMs: number): number[] {
  return cursorSourceToTimelineOccurrences(state, sourceMs).map((occurrence) => occurrence.timeMs)
}
