// Pure scroll/timing math for the teleprompter engine — framework-free so the
// playback rules stay unit-testable without a DOM.

/** Vertical position of the reading line as a fraction of the viewport height. */
export const READING_LINE_RATIO = 0.35
/** Hidden/throttled windows can stall rAF for seconds; clamp the frame delta so
 *  a resume never teleports the script. */
export const MAX_FRAME_DELTA_MS = 100
/** Distance from the bottom of the scroll range that counts as "finished". */
export const END_EPSILON_PX = 1
/** How far a user scroll must deviate from our last write to count as manual. */
export const USER_SCROLL_THRESHOLD_PX = 1

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

interface IntlSegmenterLike {
  segment(input: string): Iterable<{ isWordLike?: boolean }>
}

// Intl.Segmenter is not in the repo's ES2020 lib types; declare the slice we use.
type IntlWithSegmenter = typeof Intl & {
  Segmenter?: new (
    locales?: string | string[],
    options?: { granularity?: "grapheme" | "word" | "sentence" },
  ) => IntlSegmenterLike
}

/** Word count that treats CJK text correctly; falls back to whitespace split. */
export function countWords(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0

  const Segmenter = (Intl as IntlWithSegmenter).Segmenter
  if (Segmenter) {
    try {
      const segmenter = new Segmenter(undefined, { granularity: "word" })
      let count = 0
      for (const segment of segmenter.segment(trimmed)) {
        if (segment.isWordLike) count += 1
      }
      return count
    } catch {
      // Fall through to the whitespace heuristic.
    }
  }
  return trimmed.split(/\s+/).length
}

interface WpmToSpeedInput {
  wpm: number
  wordCount: number
  textHeight: number
}

/** Converts a speaking rate into px/s for the current script + layout. */
export function pxPerSecondFromWpm({ wpm, wordCount, textHeight }: WpmToSpeedInput): number {
  if (!Number.isFinite(wpm) || !Number.isFinite(wordCount) || !Number.isFinite(textHeight)) return 0
  if (wpm <= 0 || wordCount <= 0 || textHeight <= 0) return 0
  return (wpm / 60) * (textHeight / wordCount)
}

interface AdvanceInput {
  position: number
  pxPerSecond: number
  deltaMs: number
  maxScroll: number
}

interface AdvanceResult {
  position: number
  reachedEnd: boolean
}

export function advanceScrollPosition({
  position,
  pxPerSecond,
  deltaMs,
  maxScroll,
}: AdvanceInput): AdvanceResult {
  const safeMax = Number.isFinite(maxScroll) ? Math.max(0, maxScroll) : 0
  if (safeMax <= 0) return { position: 0, reachedEnd: true }

  const dt = clamp(Number.isFinite(deltaMs) ? deltaMs : 0, 0, MAX_FRAME_DELTA_MS)
  const speed = Number.isFinite(pxPerSecond) ? pxPerSecond : 0
  const start = Number.isFinite(position) ? position : 0
  const next = clamp(start + (speed * dt) / 1000, 0, safeMax)
  return { position: next, reachedEnd: next >= safeMax - END_EPSILON_PX }
}

interface AdoptScrollInput {
  position: number
  lastTop: number
  currentTop: number
}

/** Keeps the float accumulator authoritative: only a delta larger than the
 *  sub-pixel quantization we introduce counts as a user-driven scroll. */
export function adoptUserScroll({ position, lastTop, currentTop }: AdoptScrollInput): number {
  return Math.abs(currentTop - lastTop) > USER_SCROLL_THRESHOLD_PX ? currentTop : position
}

interface RemainingInput {
  position: number
  maxScroll: number
  pxPerSecond: number
}

export function estimateRemainingSeconds({
  position,
  maxScroll,
  pxPerSecond,
}: RemainingInput): number {
  if (!Number.isFinite(pxPerSecond) || pxPerSecond <= 0) return 0
  if (!Number.isFinite(position) || !Number.isFinite(maxScroll)) return 0
  if (position >= maxScroll) return 0
  return (maxScroll - position) / pxPerSecond
}

interface ReadTimeInput {
  wordCount: number
  wpm: number
}

export function estimateReadSeconds({ wordCount, wpm }: ReadTimeInput): number {
  if (!Number.isFinite(wordCount) || !Number.isFinite(wpm) || wordCount <= 0 || wpm <= 0) return 0
  return (wordCount / wpm) * 60
}

/** Seconds -> "m:ss" (or "h:mm:ss" once an hour or longer). */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00"
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours > 0)
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
  return `${minutes}:${String(secs).padStart(2, "0")}`
}
