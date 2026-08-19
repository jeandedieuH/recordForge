import type { ExportRange, RenderPlanChapter, TimelineMarker } from "@recordforge/domain"

/**
 * Formats a millisecond offset into a human-readable video timestamp (MM:SS or HH:MM:SS).
 */
export function formatChapterTimestamp(timeMs: number, forceHours = false): string {
  const safeMs = Math.max(0, Math.floor(timeMs))
  const totalSeconds = Math.floor(safeMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0 || forceHours) {
    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
  }
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
}

/**
 * Formats timeline markers into standard YouTube chapter description format:
 * 00:00 Intro
 * 01:23 Section Title
 * 04:50 Conclusion
 */
export function formatYouTubeChapters(
  markers: Array<{ timeMs: number; label?: string }>,
  durationMs?: number,
  defaultIntroTitle = "Intro",
): string {
  if (!markers || markers.length === 0) {
    return ""
  }

  // Filter valid markers and sort ascending by timeMs
  const sorted = [...markers]
    .filter((marker) => Number.isFinite(marker.timeMs) && marker.timeMs >= 0)
    .sort((left, right) => left.timeMs - right.timeMs)

  if (sorted.length === 0) {
    return ""
  }

  const maxTime = Math.max(durationMs ?? 0, ...sorted.map((marker) => marker.timeMs))
  const requiresHours = maxTime >= 3_600_000

  const lines: string[] = []
  const hasZeroMarker = sorted[0].timeMs === 0

  if (!hasZeroMarker) {
    const zeroStamp = formatChapterTimestamp(0, requiresHours)
    lines.push(`${zeroStamp} ${defaultIntroTitle.trim() || "Intro"}`)
  }

  sorted.forEach((marker, index) => {
    const stamp = formatChapterTimestamp(marker.timeMs, requiresHours)
    const rawLabel = marker.label?.trim() || `Chapter ${index + (hasZeroMarker ? 1 : 2)}`
    // Sanitize newlines from the label
    const sanitizedLabel = rawLabel.replace(/[\r\n]+/g, " ").trim()
    lines.push(`${stamp} ${sanitizedLabel}`)
  })

  return lines.join("\n")
}

/**
 * Parses YouTube-formatted chapter lines (e.g., "01:23 Introduction") into timestamps and labels.
 */
export function parseYouTubeChapters(
  text: string,
): Array<{ timeMs: number; label: string }> {
  if (!text || typeof text !== "string") return []

  const lines = text.split(/\r?\n/)
  const result: Array<{ timeMs: number; label: string }> = []
  // Matches timestamps like 00:00, 0:00, 01:23:45, 1:23:45 at line start
  const timestampRegex = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*(?:[-–—:]\s*)?(.*)$/

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const match = trimmed.match(timestampRegex)
    if (!match) continue

    const hours = match[1] ? Number.parseInt(match[1], 10) : 0
    const minutes = Number.parseInt(match[2], 10)
    const seconds = Number.parseInt(match[3], 10)
    const label = match[4]?.trim() || `Chapter ${result.length + 1}`

    if (Number.isFinite(minutes) && Number.isFinite(seconds)) {
      const timeMs = (hours * 3600 + minutes * 60 + seconds) * 1000
      result.push({ timeMs, label })
    }
  }

  return result.sort((left, right) => left.timeMs - right.timeMs)
}

/**
 * Converts timeline markers into discrete, contiguous chapter spans for MP4 render plans.
 * If range is defined, markers are filtered and remapped relative to the range start.
 */
export function timelineMarkersToChapters(
  markers: TimelineMarker[] | undefined,
  durationMs: number,
  range?: ExportRange,
  defaultIntroTitle = "Intro",
): RenderPlanChapter[] {
  if (!markers || markers.length === 0 || durationMs <= 0) {
    return []
  }

  const rangeStart = range?.startMs ?? 0
  const rangeEnd = range ? Math.min(range.endMs, durationMs) : durationMs
  const effectiveDuration = Math.max(0, rangeEnd - rangeStart)

  if (effectiveDuration <= 0) {
    return []
  }

  // Filter markers within range and remap time relative to export start
  const windowedMarkers = markers
    .filter((marker) => marker.timeMs >= rangeStart && marker.timeMs < rangeEnd)
    .map((marker) => ({
      id: marker.id,
      title: marker.label.trim() || "Chapter",
      timeMs: marker.timeMs - rangeStart,
    }))
    .sort((left, right) => left.timeMs - right.timeMs)

  if (windowedMarkers.length === 0) {
    return []
  }

  const chapters: RenderPlanChapter[] = []
  const hasZeroMarker = windowedMarkers[0].timeMs === 0

  // If first marker starts after 0 ms, create a synthesized start chapter
  if (!hasZeroMarker) {
    chapters.push({
      id: "chapter-intro",
      title: defaultIntroTitle.trim() || "Intro",
      startMs: 0,
      endMs: windowedMarkers[0].timeMs,
    })
  }

  for (let i = 0; i < windowedMarkers.length; i++) {
    const current = windowedMarkers[i]
    const nextTimeMs =
      i + 1 < windowedMarkers.length ? windowedMarkers[i + 1].timeMs : effectiveDuration

    if (nextTimeMs > current.timeMs) {
      chapters.push({
        id: current.id,
        title: current.title,
        startMs: current.timeMs,
        endMs: nextTimeMs,
      })
    }
  }

  return chapters
}
