import type { TimelineState } from "@recordforge/contracts"

/**
 * Extracts and returns a sorted, deduplicated array of all key edit points
 * (cuts, clip edges, markers, zoom segment boundaries, start 0, and end duration)
 * across the entire timeline.
 */
export function getTimelineEditPoints(timeline: TimelineState, durationMs: number): number[] {
  const safeDuration = Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0
  const points = new Set<number>([0, safeDuration])

  const addClampedPoint = (pt: number) => {
    if (Number.isFinite(pt)) {
      points.add(Math.min(safeDuration, Math.max(0, Math.round(pt))))
    }
  }

  for (const track of timeline.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      addClampedPoint(clip.startMs)
      if (Number.isFinite(clip.durationMs)) {
        addClampedPoint(clip.startMs + clip.durationMs)
      }
    }
  }

  for (const marker of timeline.markers ?? []) {
    addClampedPoint(marker.timeMs)
  }

  for (const zoom of timeline.zoomSegments ?? []) {
    addClampedPoint(zoom.startMs)
    if (Number.isFinite(zoom.durationMs)) {
      addClampedPoint(zoom.startMs + zoom.durationMs)
    }
  }

  return Array.from(points).sort((a, b) => a - b)
}

/**
 * Finds the nearest cut point or marker strictly before `currentMs` (beyond a tolerance threshold).
 * Returns 0 if already at or before the first cut point.
 */
export function findPreviousCut(editPoints: number[], currentMs: number, thresholdMs = 20): number {
  if (editPoints.length === 0) return 0
  const threshold = Math.max(0, thresholdMs)
  const safeCurrent = Number.isFinite(currentMs) ? currentMs : 0

  for (let i = editPoints.length - 1; i >= 0; i--) {
    const point = editPoints[i]
    if (point !== undefined && point < safeCurrent - threshold) {
      return point
    }
  }
  return 0
}

/**
 * Finds the nearest cut point or marker strictly after `currentMs` (beyond a tolerance threshold).
 * Returns the last edit point (or currentMs) if already at or after the last cut point.
 */
export function findNextCut(editPoints: number[], currentMs: number, thresholdMs = 20): number {
  if (editPoints.length === 0) return Number.isFinite(currentMs) ? currentMs : 0
  const threshold = Math.max(0, thresholdMs)
  const safeCurrent = Number.isFinite(currentMs) ? currentMs : 0

  for (let i = 0; i < editPoints.length; i++) {
    const point = editPoints[i]
    if (point !== undefined && point > safeCurrent + threshold) {
      return point
    }
  }
  const lastPoint = editPoints[editPoints.length - 1]
  return lastPoint !== undefined ? lastPoint : safeCurrent
}

/**
 * Parses user-entered timecode strings into milliseconds.
 * Supports:
 * - "MM:SS" (e.g. "01:23" -> 83000ms)
 * - "MM:SS.ms" (e.g. "01:23.50" -> 83500ms)
 * - "HH:MM:SS" (e.g. "01:00:00" -> 3600000ms)
 * - Raw seconds (e.g. "45" -> 45000ms, "12.5" -> 12500ms)
 * - Relative offsets when currentMs is provided (e.g. "+5", "-10", "+01:30")
 * Clamps result between 0 and durationMs. Returns null on invalid input.
 */
export function parseTimecode(
  input: string,
  durationMs: number,
  currentMs?: number,
): number | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // Check for relative +/- prefix
  const isRelative = trimmed.startsWith("+") || trimmed.startsWith("-")
  if (isRelative && currentMs === undefined) {
    // If relative offset is given without currentMs context, reject as incomplete
    return null
  }

  const sign = trimmed.startsWith("-") ? -1 : 1
  const cleanInput = isRelative ? trimmed.slice(1).trim() : trimmed
  if (!cleanInput) return null

  // Reject strings containing invalid non-numeric/timecode characters
  if (!/^[\d:.]+$/.test(cleanInput)) return null

  const safeDuration = Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0
  let totalMs: number | null = null

  if (cleanInput.includes(":")) {
    const parts = cleanInput.split(":")
    // Ensure all colon-separated segments are non-empty
    if (parts.some((part) => part.trim() === "")) return null

    if (parts.length === 2) {
      // Minutes part must not have a decimal point
      if (parts[0]!.includes(".")) return null
      const minutes = Number(parts[0])
      const seconds = Number(parts[1])
      if (
        Number.isFinite(minutes) &&
        Number.isFinite(seconds) &&
        minutes >= 0 &&
        seconds >= 0 &&
        seconds < 60
      ) {
        totalMs = Math.round((minutes * 60 + seconds) * 1000)
      }
    } else if (parts.length === 3) {
      // Hours and minutes parts must not have decimal points
      if (parts[0]!.includes(".") || parts[1]!.includes(".")) return null
      const hours = Number(parts[0])
      const minutes = Number(parts[1])
      const seconds = Number(parts[2])
      if (
        Number.isFinite(hours) &&
        Number.isFinite(minutes) &&
        Number.isFinite(seconds) &&
        hours >= 0 &&
        minutes >= 0 &&
        minutes < 60 &&
        seconds >= 0 &&
        seconds < 60
      ) {
        totalMs = Math.round((hours * 3600 + minutes * 60 + seconds) * 1000)
      }
    }
  } else {
    // Only one decimal point allowed in raw seconds
    if (cleanInput.split(".").length > 2) return null
    const seconds = Number(cleanInput)
    if (Number.isFinite(seconds) && seconds >= 0) {
      totalMs = Math.round(seconds * 1000)
    }
  }

  if (totalMs === null || !Number.isFinite(totalMs) || totalMs < 0) {
    return null
  }

  if (isRelative && currentMs !== undefined) {
    const safeCurrent = Number.isFinite(currentMs) ? Math.max(0, currentMs) : 0
    const targetMs = safeCurrent + sign * totalMs
    return Math.max(0, Math.min(safeDuration, Math.round(targetMs)))
  }

  return Math.max(0, Math.min(safeDuration, totalMs))
}
