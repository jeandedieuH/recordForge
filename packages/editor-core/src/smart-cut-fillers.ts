// Smart Cut: filler-word detection (M2 #6).
//
// Filler removal needs word-level timing, not just the waveform: the transcript
// gives us "um" / "uh" / "euh" spans in *source* time, and the caption coverage
// mapping (`mapTranscriptToTimeline`) projects them into timeline time with trim
// and speed applied. This module is the pure detector between those two steps:
//
//   transcript words → detectFillerWords → candidates → ranges → ripple delete
//
// Strict disfluencies are cut by default; phrases ("like", "you know") and
// repeated words are opt-in because they are legitimate speech often enough to
// need a review pass. Nothing here mutates the timeline: the caller shows the
// candidates and applies the accepted ones as one `ripple-delete-ranges`.

export type FillerLanguage = "en" | "fr" | "es" | "de"

export interface FillerLexicon {
  /** Single-word disfluencies, always offered. */
  strict: readonly string[]
  /** Opt-in multi-word (or ambiguous single-word) phrases. */
  phrases: readonly string[]
}

/**
 * Per-language lexicons, deliberately strict. Whisper already drops many
 * disfluencies; these are the ones that survive and read as mistakes.
 */
export const FILLER_LEXICONS: Record<FillerLanguage, FillerLexicon> = {
  en: {
    strict: ["um", "uh", "erm", "ah", "hmm", "mm", "uhh", "umm"],
    phrases: ["like", "you know", "i mean", "basically", "sort of", "kind of", "right"],
  },
  fr: {
    strict: ["euh", "ben", "bah", "hum", "hein"],
    phrases: ["genre", "en fait", "du coup", "voilà", "quoi"],
  },
  es: {
    strict: ["eh", "este", "em", "mmm"],
    phrases: ["o sea", "pues", "es que", "bueno"],
  },
  de: {
    strict: ["äh", "ähm", "ähh", "hm", "mhm"],
    phrases: ["also", "halt", "irgendwie", "sozusagen"],
  },
}

/** One word with timeline timings (see `mapTranscriptToTimeline`). */
export interface FillerWord {
  text: string
  startMs: number
  endMs: number
}

export interface FillerOptions {
  language: FillerLanguage
  /** Offer the opt-in phrase set (default false). */
  includePhrases?: boolean
  /** Offer repeated-word detection (default false). */
  includeRepeats?: boolean
  /** Audio kept inside each cut so onsets are not clipped. */
  paddingMs?: number
  /** Canvas frame rate; edges snap to the output frame grid when set. */
  fps?: number
  /**
   * Adjacent dead air this close (ms) is absorbed into the cut, so the splice
   * lands on the pause instead of mid-word.
   */
  mergeSilenceMs?: number
}

export type FillerKind = "strict" | "phrase" | "repeat"

export interface FillerCandidate {
  id: string
  /** Timeline range the candidate would remove (padding applied). */
  startMs: number
  endMs: number
  /** Words the candidate removes, joined for display. */
  text: string
  /** A couple of words on each side, for the review list. */
  context: string
  kind: FillerKind
  /** Index of the first removed word in the input sequence. */
  wordIndex: number
}

/** Silence ranges (timeline ms) a candidate may merge into. */
export interface FillerSilenceRange {
  startMs: number
  endMs: number
}

const DEFAULT_PADDING_MS = 30
const DEFAULT_MERGE_SILENCE_MS = 220
/** A cut shorter than this is not worth a splice pair. */
export const MIN_FILLER_RANGE_MS = 60

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Lowercase, unaccented, punctuation-free form used for matching. */
export function normalizeFillerWord(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .trim()
}

function snapEdge(ms: number, fps: number | undefined): number {
  if (!fps || !Number.isFinite(fps) || fps <= 0) return Math.round(ms)
  return Math.round((Math.round((ms * fps) / 1000) * 1000) / fps)
}

interface Span {
  first: number
  last: number
  kind: FillerKind
}

/** Finds contiguous word spans matching the lexicon's strict entries. */
function strictSpans(words: FillerWord[], lexicon: FillerLexicon): Span[] {
  const strict = new Set(lexicon.strict.map(normalizeFillerWord))
  const spans: Span[] = []
  words.forEach((word, index) => {
    if (strict.has(normalizeFillerWord(word.text))) {
      spans.push({ first: index, last: index, kind: "strict" })
    }
  })
  return spans
}

/** Longest-match n-gram search over the opt-in phrase set. */
function phraseSpans(words: FillerWord[], lexicon: FillerLexicon): Span[] {
  const phrases = lexicon.phrases
    .map((phrase) => phrase.split(/\s+/).map(normalizeFillerWord).filter(Boolean))
    .filter((tokens) => tokens.length > 0)
    .sort((left, right) => right.length - left.length)
  if (phrases.length === 0) return []

  const normalized = words.map((word) => normalizeFillerWord(word.text))
  const spans: Span[] = []
  let index = 0
  while (index < normalized.length) {
    const match = phrases.find((tokens) =>
      tokens.every((token, offset) => normalized[index + offset] === token),
    )
    if (match) {
      const last = index + match.length - 1
      spans.push({ first: index, last, kind: "phrase" })
      index = last + 1
      continue
    }
    index += 1
  }
  return spans
}

/**
 * Repeated words: the repetition itself is the filler ("I I think", "the the
 * build"). The later word is removed, which keeps the sentence grammatical.
 */
function repeatSpans(words: FillerWord[]): Span[] {
  const spans: Span[] = []
  for (let index = 1; index < words.length; index++) {
    const previous = normalizeFillerWord(words[index - 1]!.text)
    const current = normalizeFillerWord(words[index]!.text)
    if (!previous || previous !== current) continue
    // Only immediate repeats with no audible gap count; a deliberate echo
    // ("no, no") usually carries a pause and punctuation we should keep.
    const gap = words[index]!.startMs - words[index - 1]!.endMs
    if (gap > 120) continue
    spans.push({ first: index, last: index, kind: "repeat" })
  }
  return spans
}

function contextFor(words: FillerWord[], first: number, last: number): string {
  const from = Math.max(0, first - 2)
  const to = Math.min(words.length, last + 3)
  return words
    .slice(from, to)
    .map((word) => word.text.trim())
    .join(" ")
}

/**
 * Detect filler-word candidates in timeline-time words. Ranges come back
 * padded, frame-snapped and merged with adjacent silence, ready for
 * `createRippleDeleteRangesCommand` once the user accepts them.
 */
export function detectFillerWords(
  words: FillerWord[],
  options: FillerOptions,
  silenceRanges: readonly FillerSilenceRange[] = [],
): FillerCandidate[] {
  if (words.length === 0) return []
  const lexicon = FILLER_LEXICONS[options.language] ?? FILLER_LEXICONS.en
  const padding = Math.max(0, options.paddingMs ?? DEFAULT_PADDING_MS)
  const mergeSilence = Math.max(0, options.mergeSilenceMs ?? DEFAULT_MERGE_SILENCE_MS)

  const spans = [
    ...strictSpans(words, lexicon),
    ...(options.includePhrases ? phraseSpans(words, lexicon) : []),
    ...(options.includeRepeats ? repeatSpans(words) : []),
  ].sort((left, right) => left.first - right.first)

  // Strict spans win when a phrase overlaps them.
  const accepted: Span[] = []
  for (const span of spans) {
    const overlaps = accepted.some(
      (existing) => span.first <= existing.last && existing.first <= span.last,
    )
    if (!overlaps) accepted.push(span)
  }

  const candidates: FillerCandidate[] = []
  for (const span of accepted) {
    const firstWord = words[span.first]!
    const lastWord = words[span.last]!
    let startMs = firstWord.startMs - padding
    let endMs = lastWord.endMs + padding

    // Absorb neighbouring dead air: a cut that ends mid-pause clicks.
    for (const silence of silenceRanges) {
      if (silence.endMs >= startMs && silence.endMs <= startMs + mergeSilence) {
        startMs = silence.startMs
      }
      if (silence.startMs >= endMs && silence.startMs <= endMs + mergeSilence) {
        endMs = silence.endMs
      }
    }

    startMs = Math.max(0, snapEdge(startMs, options.fps))
    endMs = Math.max(startMs, snapEdge(endMs, options.fps))
    if (endMs - startMs < MIN_FILLER_RANGE_MS) continue

    candidates.push({
      id: `filler:${span.kind}:${span.first}:${span.last}`,
      startMs,
      endMs,
      text: words
        .slice(span.first, span.last + 1)
        .map((word) => word.text.trim())
        .join(" "),
      context: contextFor(words, span.first, span.last),
      kind: span.kind,
      wordIndex: span.first,
    })
  }
  return candidates
}

/**
 * Merge overlapping candidates into one range per splice point, so accepting
 * everything produces the minimum number of cuts.
 */
export function mergeFillerCandidates(
  candidates: readonly FillerCandidate[],
): { startMs: number; endMs: number }[] {
  const sorted = [...candidates].sort(
    (left, right) => left.startMs - right.startMs || left.endMs - right.endMs,
  )
  const merged: { startMs: number; endMs: number }[] = []
  for (const candidate of sorted) {
    const last = merged[merged.length - 1]
    if (last && candidate.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, candidate.endMs)
    } else {
      merged.push({ startMs: candidate.startMs, endMs: candidate.endMs })
    }
  }
  return merged
}

/** Total time a set of accepted candidates removes. */
export function fillerRemovedMs(candidates: readonly FillerCandidate[]): number {
  return mergeFillerCandidates(candidates).reduce(
    (total, range) => total + Math.max(0, range.endMs - range.startMs),
    0,
  )
}

/** Clamp a candidate's padding helper for UI sliders (0–400 ms). */
export function clampFillerPadding(paddingMs: number): number {
  return clamp(Math.round(paddingMs), 0, 400)
}
