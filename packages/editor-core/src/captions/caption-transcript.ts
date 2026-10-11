import type {
  AudioClip,
  AudioRole,
  CanvasAspectRatio,
  CaptionClip,
  CaptionCue,
  CaptionDesign,
  TimelineClip,
  TimelineState,
  TimelineTrack,
  Transcript,
  TranscriptWord,
} from "@recordforge/contracts"

import { captionTextBudget, resolveCaptionLayout } from "./caption-layout"
import { avgCharEm } from "./inter-metrics"
import { captionWords, CLOSING_PUNCT, reflowCueText, type CaptionTextWord } from "./caption-text"

// Transcript times are in the recording asset's CONTAINER time — the same base
// AudioClip.sourceInMs/sourceOutMs use — so mapping onto the timeline is a
// pure coordinate transform, no resampling.

/** A transcript word positioned on the timeline (ms, timeline output time). */
export interface TimelineWord {
  text: string
  startMs: number
  endMs: number
  spaceBefore: boolean
  // Container-time provenance (ms) — where the word lives in the recording
  // asset. Optional so hand-built words stay usable; set verbatim by
  // mapTranscriptToTimeline regardless of output clamping.
  srcStartMs?: number
  srcEndMs?: number
}

/** One transcribable audio stream of a recording as seen from the timeline. */
export interface CaptionAudioSource {
  /** Absolute ffprobe stream index; null for the unindexed pseudo-source. */
  streamIndex: number | null
  trackId: string
  trackName: string
  role?: AudioRole
  muted: boolean
  clipCount: number
  /** Union of the source's clip coverage in container ms. */
  coveredMs: number
}

const MIN_WORD_MS = 30

/**
 * Recording-owned audio: the clip's asset is the container itself
 * (`assetId === recordingId`, kept by unindexed clips) or a stream asset
 * namespaced under it — `createStreamAsset` rewrites every indexed clip to
 * `${recordingId}:${role}:${streamIndex}`. External audio assets carry their
 * own ids and never share that prefix.
 */
export function isRecordingAudioClip(clip: TimelineClip, recordingId: string): clip is AudioClip {
  if (clip.kind !== "audio") return false
  return clip.assetId === recordingId || clip.assetId.startsWith(`${recordingId}:`)
}

/**
 * One entry per distinct audio `streamIndex` in audio-track clips whose
 * assetId belongs to `recordingId`. A clip without a streamIndex is skipped —
 * UNLESS the recording's audio lives on exactly one track that has no indexed
 * clips at all, in which case a single pseudo-source with `streamIndex: null`
 * is reported (the caller asks Rust for the default stream). `muted` mirrors
 * the export audibility rule: track muted, or another audio track is soloed.
 */
export function listCaptionAudioSources(
  timeline: TimelineState,
  recordingId: string,
): CaptionAudioSource[] {
  const audioTracks = timeline.tracks.filter(
    (track): track is TimelineTrack =>
      track.kind === "audio" && track.clips.some((clip) => isRecordingAudioClip(clip, recordingId)),
  )
  const anySolo = timeline.tracks.some((track) => track.kind === "audio" && track.solo)
  const sources: CaptionAudioSource[] = []
  let fallback: CaptionAudioSource | null = null

  for (const track of audioTracks) {
    const clips = track.clips.filter((clip): clip is AudioClip =>
      isRecordingAudioClip(clip, recordingId),
    )
    const muted = track.muted || (anySolo && !track.solo)
    const byStream = new Map<number, AudioClip[]>()
    const unindexed: AudioClip[] = []
    for (const clip of clips) {
      if (clip.streamIndex === undefined) unindexed.push(clip)
      else {
        const list = byStream.get(clip.streamIndex) ?? []
        list.push(clip)
        byStream.set(clip.streamIndex, list)
      }
    }
    for (const [streamIndex, streamClips] of byStream) {
      sources.push({
        streamIndex,
        trackId: track.id,
        trackName: track.name,
        role: streamClips[0].role,
        muted,
        clipCount: streamClips.length,
        coveredMs: unionMs(streamClips),
      })
    }
    if (unindexed.length > 0 && audioTracks.length === 1 && sources.length === 0) {
      fallback = {
        streamIndex: null,
        trackId: track.id,
        trackName: track.name,
        role: unindexed[0].role,
        muted,
        clipCount: unindexed.length,
        coveredMs: unionMs(unindexed),
      }
    }
  }
  return fallback ? [...sources, fallback] : sources
}

function unionMs(clips: AudioClip[]): number {
  const ranges = clips
    .map((clip) => [clip.sourceInMs, clip.sourceOutMs] as const)
    .sort((a, b) => a[0] - b[0])
  let covered = 0
  let curStart = -1
  let curEnd = -1
  for (const [s, e] of ranges) {
    if (s > curEnd) {
      if (curEnd >= 0) covered += curEnd - curStart
      curStart = s
      curEnd = e
    } else {
      curEnd = Math.max(curEnd, e)
    }
  }
  if (curEnd >= 0) covered += curEnd - curStart
  return covered
}

/** First audible microphone source, else first audible, else null. */
export function pickDefaultCaptionSource(sources: CaptionAudioSource[]): CaptionAudioSource | null {
  return (
    sources.find((s) => !s.muted && s.role === "microphone") ??
    sources.find((s) => !s.muted) ??
    null
  )
}

/**
 * Projection core shared by transcript mapping and caption resync: a word
 * (container times in `startMs`/`endMs`) lands on every clip whose source
 * range covers its MIDPOINT — duplicated source ranges host each occurrence.
 * Each result is the word's window on that clip in timeline ms, clamped to
 * the clip and stretched to at least MIN_WORD_MS.
 */
export function projectWordToClips(
  word: { startMs: number; endMs: number },
  clips: AudioClip[],
): { clipIndex: number; startMs: number; endMs: number }[] {
  const midpoint = (word.startMs + word.endMs) / 2
  const projections: { clipIndex: number; startMs: number; endMs: number }[] = []
  clips.forEach((clip, clipIndex) => {
    if (!(clip.sourceInMs <= midpoint && midpoint < clip.sourceOutMs)) return
    const clipEnd = clip.startMs + clip.durationMs
    let startMs = Math.round(clip.startMs + (word.startMs - clip.sourceInMs) / clip.speed)
    let endMs = Math.round(clip.startMs + (word.endMs - clip.sourceInMs) / clip.speed)
    startMs = Math.min(Math.max(startMs, clip.startMs), clipEnd)
    endMs = Math.min(Math.max(endMs, startMs), clipEnd)
    if (endMs - startMs < MIN_WORD_MS) {
      endMs = Math.min(endMs + (MIN_WORD_MS - (endMs - startMs)), clipEnd)
    }
    projections.push({ clipIndex, startMs, endMs })
  })
  return projections
}

/**
 * Project container-time transcript words onto timeline clips. A word belongs
 * to every clip whose source range covers the word's MIDPOINT, so duplicated
 * source ranges caption each occurrence. Words outside every clip drop out.
 */
export function mapTranscriptToTimeline(
  words: TranscriptWord[],
  clips: AudioClip[],
): { words: TimelineWord[]; droppedCount: number } {
  // Each clip maps the words whose midpoint it hosts, then keeps its own
  // sequence monotonic after clamping (words from different clips interleave).
  const perClip = clips.map(() => [] as TimelineWord[])
  let droppedCount = 0
  for (const word of words) {
    const projections = projectWordToClips(word, clips)
    if (projections.length === 0) {
      droppedCount += 1
      continue
    }
    for (const { clipIndex, startMs, endMs } of projections) {
      perClip[clipIndex].push({
        text: word.text,
        startMs,
        endMs,
        spaceBefore: word.spaceBefore,
        // Container times ride along verbatim — output clamping never
        // rewrites where the audio actually sits in the recording.
        srcStartMs: word.startMs,
        srcEndMs: word.endMs,
      })
    }
  }
  const mapped: TimelineWord[] = []
  for (const clipWords of perClip) {
    let prevEnd = -1
    for (const word of clipWords) {
      if (word.startMs < prevEnd) word.startMs = prevEnd
      if (word.endMs < word.startMs) word.endMs = word.startMs
      prevEnd = word.endMs
    }
    mapped.push(...clipWords)
  }
  mapped.sort((a, b) => a.startMs - b.startMs)
  return { words: mapped, droppedCount }
}

/**
 * Remove whisper repetition loops (a 1–6 word phrase repeated ≥ 4×
 * consecutively → keep the first occurrence) and stray-symbol words with no
 * letter/digit content.
 */
export function cleanTranscriptWords<T extends TimelineWord>(words: T[]): T[] {
  const hasContent = (word: T) => /[\p{L}\p{N}]/u.test(word.text)
  const kept: T[] = []
  let i = 0
  while (i < words.length) {
    const word = words[i]
    if (!hasContent(word)) {
      i += 1
      continue
    }
    kept.push(word)
    // Detect a repetition loop starting at i: try phrase lengths 1..6.
    let dropped = 0
    for (let len = 1; len <= 6; len++) {
      let repeats = 1
      while (
        i + (repeats + 1) * len <= words.length &&
        samePhrase(words, i, i + repeats * len, len)
      ) {
        repeats += 1
      }
      if (repeats >= 4) {
        // Keep only the first occurrence of the looped phrase.
        dropped = Math.max(dropped, (repeats - 1) * len)
        break
      }
    }
    i += 1 + dropped
  }
  return kept
}

function samePhrase(words: { text: string }[], a: number, b: number, len: number): boolean {
  for (let k = 0; k < len; k++) {
    if (words[a + k].text !== words[b + k].text) return false
  }
  return true
}

/** Segmentation knobs — all derived from the shared layout budget. */
export interface CaptionSegmentationProfile {
  maxCharsPerLine: number
  maxLines: number
  maxDurationMs: number
  minDurationMs: number
  hardPauseMs: number
  softPauseMs: number
  leadMs: number
  tailMs: number
  maxWords: number
}

export function captionSegmentationProfile(
  canvas: { width: number; height: number; aspectRatio?: CanvasAspectRatio },
  design: CaptionDesign,
): CaptionSegmentationProfile {
  const budget = captionTextBudget(canvas, design)
  return {
    // Uppercase glyphs measure ~12% wider — budget for them.
    maxCharsPerLine: Math.max(
      8,
      Math.floor(
        budget.maxTextWidthPx /
          (budget.fontPx * avgCharEm(budget.fontWeight) * (budget.uppercase ? 1.12 : 1)),
      ),
    ),
    maxLines: budget.maxLines,
    maxDurationMs: budget.highlight ? 4_200 : 6_000,
    minDurationMs: 800,
    hardPauseMs: 700,
    softPauseMs: 320,
    leadMs: 60,
    tailMs: 160,
    maxWords: budget.highlight ? 7 : Infinity,
  }
}

// Words that prefer to open a cue when a break is needed anyway (English-only
// heuristic — other languages simply get no bonus).
const CONJUNCTION_OPENERS = new Set([
  "and",
  "but",
  "so",
  "because",
  "which",
  "that",
  "then",
  "or",
  "if",
  "when",
  "while",
])

const SENTENCE_FINAL = /[.?!…。！？]$/
const CLAUSE_BREAK = /[,;:—、，；：]$/

/**
 * Segment timeline words into caption cues: hard pauses always split,
 * capacity/duration/word-count overflow picks the best-scored break inside the
 * cue (favouring punctuation and conjunction boundaries, penalizing widows),
 * and a sentence-final word past half capacity closes the cue early.
 */
export function segmentCaptionWords(
  words: TimelineWord[],
  profile: CaptionSegmentationProfile,
): CaptionCue[] {
  if (words.length === 0) return []
  const capacity = profile.maxCharsPerLine * profile.maxLines

  const cueLen = (ws: TimelineWord[]) =>
    ws.reduce((sum, w) => sum + w.text.length, 0) + ws.length - 1
  const cueDuration = (ws: TimelineWord[]) => ws[ws.length - 1].endMs - ws[0].startMs

  const groups: TimelineWord[][] = []
  let cue: TimelineWord[] = []
  for (const word of words) {
    if (cue.length > 0) {
      const gap = word.startMs - cue[cue.length - 1].endMs
      if (gap >= profile.hardPauseMs) {
        groups.push(cue)
        cue = []
      }
    }
    // Overflow → pick the best break inside the current cue, not necessarily
    // right before this word.
    while (
      cue.length > 0 &&
      (cueLen([...cue, word]) > capacity ||
        cueDuration([...cue, word]) > profile.maxDurationMs ||
        cue.length + 1 > profile.maxWords)
    ) {
      const cut = bestBreak(cue, profile)
      if (cut === null) {
        groups.push(cue)
        cue = []
      } else {
        groups.push(cue.slice(0, cut))
        cue = cue.slice(cut)
      }
    }
    cue.push(word)
    // Sentence-final punctuation past half capacity closes the cue early.
    if (SENTENCE_FINAL.test(word.text) && cueLen(cue) >= capacity * 0.5 && cueDuration(cue) >= 1) {
      groups.push(cue)
      cue = []
    }
  }
  if (cue.length > 0) groups.push(cue)
  return applyCueTiming(groups, profile)
}

/**
 * Shared cue timing pass — lead/tail padding, no-overlap resolution,
 * min-duration extension, and the collapse guard — applied to pre-grouped
 * words. Resync reuses this so rebuilt cues pad identically to segmented
 * ones. Also attaches per-display-token `words` (cue-relative) and, when
 * the group words carry container times, `sourceWords` (absolute).
 */
export function applyCueTiming(
  groups: TimelineWord[][],
  profile: CaptionSegmentationProfile,
): CaptionCue[] {
  const cues: CaptionCue[] = []
  const rawStarts = groups.map((g) => Math.max(0, g[0].startMs - profile.leadMs))
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]
    const nextStart = i + 1 < groups.length ? rawStarts[i + 1] : Infinity
    const prevEnd = cues.length > 0 ? cues[cues.length - 1].endMs : 0
    const startMs = Math.max(0, rawStarts[i], prevEnd)
    let endMs = Math.min(group[group.length - 1].endMs + profile.tailMs, nextStart)
    if (endMs - startMs < profile.minDurationMs) {
      endMs = Math.min(startMs + profile.minDurationMs, nextStart)
    }
    // Degenerate overlaps can still collapse a cue — keep it positive.
    endMs = Math.max(endMs, startMs + 1)
    const text = assembleCueText(group)
    if (text === "") continue
    const cueWords = displayWordTimings(text, group, startMs, endMs)
    const sourceWords = displaySourceTimings(text, group)
    cues.push({
      id: `ai-${cues.length + 1}`,
      startMs,
      endMs,
      text,
      ...(cueWords === undefined ? {} : { words: cueWords }),
      ...(sourceWords === undefined ? {} : { sourceWords }),
    })
  }
  return cues
}

/**
 * Per-DISPLAY-TOKEN timings for one cue, relative to `cueStartMs` — the
 * same token stream `resolveCaptionLayout` consumes
 * (`captionWords(reflowCueText(text))`), so the count always matches while
 * the clip text is unedited.
 *
 * Each TimelineWord is located verbatim in the reflowed text by a
 * sequential scan (skipping punctuation/whitespace drift; a word that never
 * matches contributes no coverage). A display token's window is the union
 * of every located word overlapping its char range; unmapped tokens
 * interpolate linearly between the nearest mapped neighbours, clamped to
 * the first/last mapped window at the edges. Returns undefined when no
 * token maps at all — better to omit `words` than emit garbage.
 */
interface TokenWindow {
  startMs: number
  endMs: number
}

interface TokenCoverage {
  tokens: CaptionTextWord[]
  windows: (TokenWindow | null)[]
}

/**
 * Shared display-token coverage walk: locate the cue's display tokens and
 * each group word verbatim in the reflowed text, then union every located
 * word window (`windowOf`) overlapping a token's char range. Unfound words
 * contribute no coverage; unfound tokens stay null for the caller to
 * interpolate. Returns undefined when nothing maps at all — better to omit
 * timings than emit garbage.
 */
function displayTokenCoverage(
  text: string,
  group: TimelineWord[],
  windowOf: (word: TimelineWord) => TokenWindow | null,
): TokenCoverage | undefined {
  const reflowed = reflowCueText(text)
  const tokens = captionWords(reflowed)
  if (tokens.length === 0 || group.length === 0) return undefined

  // Locate each display token's char range (they occur verbatim, in order).
  const tokenRanges: { start: number; end: number }[] = []
  let pointer = 0
  for (const token of tokens) {
    const at = reflowed.indexOf(token.text, pointer)
    if (at < 0) return undefined
    tokenRanges.push({ start: at, end: at + token.text.length })
    pointer = at + token.text.length
  }

  // Locate each timeline word's char range; unfound words give no coverage.
  const wordRanges: { start: number; end: number; win: TokenWindow }[] = []
  pointer = 0
  for (const word of group) {
    const at = reflowed.indexOf(word.text, pointer)
    if (at < 0) continue
    const win = windowOf(word)
    if (win !== null) {
      wordRanges.push({ start: at, end: at + word.text.length, win })
    }
    pointer = at + word.text.length
  }
  if (wordRanges.length === 0) return undefined

  // Token window = min start / max end over words overlapping its chars.
  const windows: (TokenWindow | null)[] = tokenRanges.map(({ start, end }) => {
    let lo = Infinity
    let hi = -Infinity
    for (const wr of wordRanges) {
      if (wr.start < end && wr.end > start) {
        lo = Math.min(lo, wr.win.startMs)
        hi = Math.max(hi, wr.win.endMs)
      }
    }
    return hi >= lo ? { startMs: lo, endMs: hi } : null
  })
  return { tokens, windows }
}

/** Fill unmapped tokens by linear interpolation between mapped neighbours;
 * edges clamp to the first/last mapped window. Undefined when none mapped. */
function fillTokenWindows(windows: (TokenWindow | null)[]): TokenWindow[] | undefined {
  const mapped = windows.map((win, i) => (win === null ? -1 : i)).filter((i) => i >= 0)
  if (mapped.length === 0) return undefined
  return windows.map((win, i) => {
    if (win !== null) return win
    const before = mapped.filter((j) => j < i).pop()
    const after = mapped.find((j) => j > i)
    if (before === undefined) return windows[after!]!
    if (after === undefined) return windows[before]!
    const t = (i - before) / (after - before)
    const a = windows[before]!
    const b = windows[after]!
    return {
      startMs: a.startMs + (b.startMs - a.startMs) * t,
      endMs: a.endMs + (b.endMs - a.endMs) * t,
    }
  })
}

export function displayWordTimings(
  text: string,
  group: TimelineWord[],
  cueStartMs: number,
  cueEndMs: number,
): { text: string; startMs: number; endMs: number }[] | undefined {
  const coverage = displayTokenCoverage(text, group, (word) => ({
    startMs: word.startMs,
    endMs: word.endMs,
  }))
  if (!coverage) return undefined
  const filled = fillTokenWindows(coverage.windows)
  if (!filled) return undefined

  // Cue-relative, clamped to [0, cue duration], monotonic in startMs.
  const duration = Math.max(0, cueEndMs - cueStartMs)
  let prevStart = 0
  const out: { text: string; startMs: number; endMs: number }[] = []
  filled.forEach((win, i) => {
    const startMs = Math.max(
      prevStart,
      Math.min(Math.max(Math.round(win.startMs - cueStartMs), 0), duration),
    )
    const endMs = Math.max(
      startMs,
      Math.min(Math.max(Math.round(win.endMs - cueStartMs), 0), duration),
    )
    prevStart = startMs
    out.push({ text: coverage.tokens[i].text, startMs, endMs })
  })
  return out
}

/**
 * Per-DISPLAY-TOKEN provenance windows in CONTAINER ms — the recording
 * coordinates each token was transcribed from. Same coverage walk and token
 * order as `displayWordTimings`, but absolute (never rebased) so the values
 * stay valid after moves/splits. Omitted when no group word carries source
 * times.
 */
export function displaySourceTimings(
  text: string,
  group: TimelineWord[],
): { text: string; startMs: number; endMs: number }[] | undefined {
  const coverage = displayTokenCoverage(text, group, (word) =>
    word.srcStartMs === undefined || word.srcEndMs === undefined
      ? null
      : { startMs: word.srcStartMs, endMs: word.srcEndMs },
  )
  if (!coverage) return undefined
  const filled = fillTokenWindows(coverage.windows)
  if (!filled) return undefined

  // Absolute container ms — rounded, end ≥ start, monotonic in startMs.
  let prevStart = 0
  return filled.map((win, i) => {
    const startMs = Math.max(prevStart, Math.round(win.startMs))
    const endMs = Math.max(startMs, Math.round(win.endMs))
    prevStart = startMs
    return { text: coverage.tokens[i].text, startMs, endMs }
  })
}

/**
 * Best break position (word count in the first part) inside `cue`. Only
 * positions holding ≥ 40% of the cue's words are candidates; returns null
 * when no position qualifies.
 */
function bestBreak(cue: TimelineWord[], profile: CaptionSegmentationProfile): number | null {
  const n = cue.length
  let best: number | null = null
  let bestScore = -Infinity
  for (let p = Math.max(1, Math.ceil(n * 0.4)); p < n; p++) {
    const before = cue[p - 1]
    const after = cue[p]
    let score = p / n
    if (SENTENCE_FINAL.test(before.text)) score += 5
    else if (CLAUSE_BREAK.test(before.text)) score += 3
    if (after.startMs - before.endMs >= profile.softPauseMs) score += 2
    if (CONJUNCTION_OPENERS.has(after.text.toLowerCase().replace(/^\W+|\W+$/g, ""))) score += 1.5
    // Widow penalties: a tiny first part or a lone short-word remainder.
    const firstChars = cue.slice(0, p).reduce((s, w) => s + w.text.length, 0) + p - 1
    const remainderWords = n - p
    const lastWord = cue[n - 1]
    if (p < 2 || firstChars < 8 || (remainderWords === 1 && lastWord.text.length < 4)) {
      score -= 4
    }
    if (score > bestScore) {
      bestScore = score
      best = p
    }
  }
  return best
}

/** Join cue words honouring spaceBefore and closing punctuation. */
function assembleCueText(words: TimelineWord[]): string {
  return words
    .map((word, i) => {
      const glue = i > 0 && word.spaceBefore && !CLOSING_PUNCT.test(word.text)
      return (glue ? " " : "") + word.text
    })
    .join("")
    .trim()
    .slice(0, 10_000)
}

export interface CaptionCueBuildResult {
  cues: CaptionCue[]
  droppedWords: number
  sourceClipCount: number
  language: string
}

/**
 * Full pipeline: audio clips of the recording (matching `streamIndex ??
 * transcript.streamIndex`; muted tracks still map — the caller decides whether
 * muted sources are offered) → timeline mapping → cleaning → segmentation.
 * Never throws on empty input.
 */
/**
 * Audio clips of `recordingId` carrying `stream` — the same selection the
 * generator uses: a numeric stream matches `clip.streamIndex` literally, and
 * when NO recording clip is indexed the unindexed clips form the
 * pseudo-source (all selected). `null` matches nothing literally — only the
 * pseudo rule can still select unindexed clips.
 */
export function collectAudioClipsForStream(
  timeline: TimelineState,
  recordingId: string,
  stream: number | null,
): AudioClip[] {
  const recordingClips = timeline.tracks
    .filter((track) => track.kind === "audio")
    .flatMap((track) => track.clips)
    .filter((clip): clip is AudioClip => isRecordingAudioClip(clip, recordingId))
  // Pseudo-source scenario: listCaptionAudioSources reports streamIndex null
  // when NO clip carries an index, so the transcript's resolved stream index
  // can't be matched literally — every unindexed clip belongs to it.
  const hasIndexed = recordingClips.some((clip) => clip.streamIndex !== undefined)
  return recordingClips.filter(
    (clip) => clip.streamIndex === stream || (!hasIndexed && clip.streamIndex === undefined),
  )
}

export function buildCaptionCuesFromTranscript(input: {
  transcript: Transcript
  timeline: TimelineState
  canvas: { width: number; height: number; aspectRatio?: CanvasAspectRatio }
  design: CaptionDesign
  streamIndex?: number
}): CaptionCueBuildResult {
  const stream = input.streamIndex ?? input.transcript.streamIndex
  const clips = collectAudioClipsForStream(input.timeline, input.timeline.recordingId, stream)
  const { words, droppedCount } = mapTranscriptToTimeline(input.transcript.words, clips)
  const cleaned = cleanTranscriptWords(words)
  const profile = captionSegmentationProfile(input.canvas, input.design)
  return {
    // The resolved stream stamps every cue so resync can re-collect the
    // same coverage later even after the audio was trimmed or moved.
    cues: segmentCaptionWords(cleaned, profile).map((cue) => ({
      ...cue,
      sourceStreamIndex: stream,
    })),
    droppedWords: droppedCount,
    sourceClipCount: clips.length,
    language: input.transcript.language,
  }
}

export interface CaptionCueAnalysis {
  pages: number
  /** Largest line count across pages (the visible block height). */
  lines: number
  charsPerSecond: number
  warnings: ("too-long" | "fast" | "short")[]
}

/** Badge-level diagnostics for the cue list — same engine as the renderer. */
export function analyzeCaptionCue(
  cue: { text: string; startMs: number; endMs: number },
  design: CaptionDesign,
  canvas: { width: number; height: number; aspectRatio?: CanvasAspectRatio },
): CaptionCueAnalysis {
  const layout = resolveCaptionLayout({
    text: cue.text,
    startMs: cue.startMs,
    endMs: cue.endMs,
    design,
    canvas,
  })
  const durationMs = Math.max(1, cue.endMs - cue.startMs)
  const charsPerSecond = cue.text.length / (durationMs / 1_000)
  const warnings: CaptionCueAnalysis["warnings"] = []
  if (layout.pages.length > 1) warnings.push("too-long")
  if (charsPerSecond > 20) warnings.push("fast")
  if (durationMs < 500) warnings.push("short")
  return {
    pages: layout.pages.length,
    lines: Math.max(...layout.pages.map((p) => p.lines.length)),
    charsPerSecond,
    warnings,
  }
}

export interface CaptionSyncReport {
  /** Provenance clips on the track (cues carrying `sourceWords`). */
  total: number
  /** Mapped but no longer where they were generated (moved/trimmed/cut). */
  displaced: number
  /** Every source word lost — the audio the cue was generated from is gone. */
  dropped: number
}

/** A mapped word counts as moved once its drift passes this threshold. */
export const CAPTION_SYNC_TOLERANCE_MS = 60

/**
 * Cheap staleness signal for the captions panel: replay each provenance
 * cue's `sourceWords` through the CURRENT audio coverage and compare the
 * result against the stored cue-relative `words`. Pure and O(words) — the
 * UI memoizes it on the timeline. Manual/imported/edited cues (no
 * `sourceWords`) are skipped entirely.
 */
export function analyzeCaptionSync(
  timeline: TimelineState,
  track: TimelineTrack,
): CaptionSyncReport {
  const report: CaptionSyncReport = { total: 0, displaced: 0, dropped: 0 }
  const clipCache = new Map<number | null, AudioClip[]>()
  const audioFor = (stream: number | null): AudioClip[] => {
    let clips = clipCache.get(stream)
    if (!clips) {
      clips = collectAudioClipsForStream(timeline, timeline.recordingId, stream)
      clipCache.set(stream, clips)
    }
    return clips
  }

  for (const clip of track.clips) {
    if (clip.kind !== "caption" || !clip.sourceWords?.length) continue
    report.total += 1
    const audio = audioFor(clip.sourceStreamIndex ?? null)
    const wordCount = clip.sourceWords.length
    // `words` and `sourceWords` are index-aligned; a mismatch means hand
    // tooling, so fall back to the endpoint-only comparison.
    const aligned = clip.words?.length === wordCount ? clip.words : undefined

    let mapped = 0
    let stale = false
    clip.sourceWords.forEach((src, i) => {
      const projections = projectWordToClips(src, audio)
      if (projections.length === 0) {
        // A surviving cue with an unmapped interior word means a mid-cue cut.
        stale = true
        return
      }
      mapped += 1
      const expected = expectedWordWindow(clip, aligned, i, wordCount)
      if (!expected) return
      // Duplicated source ranges host a word more than once — compare
      // against the projection closest to the expected position.
      const target = expected.startMs ?? expected.endMs ?? 0
      const best = projections.reduce((a, b) =>
        Math.abs(b.startMs - target) < Math.abs(a.startMs - target) ? b : a,
      )
      if (
        (expected.startMs !== undefined &&
          Math.abs(best.startMs - expected.startMs) > CAPTION_SYNC_TOLERANCE_MS) ||
        (expected.endMs !== undefined &&
          Math.abs(best.endMs - expected.endMs) > CAPTION_SYNC_TOLERANCE_MS)
      ) {
        stale = true
      }
    })

    if (mapped === 0) report.dropped += 1
    else if (stale) report.displaced += 1
  }
  return report
}

/**
 * Where display token `i` sits on the timeline per the stored cue — index-
 * aligned `words` when available, else the endpoint fallbacks (first word
 * anchors at the cue start, last word at the cue end).
 */
function expectedWordWindow(
  clip: CaptionClip,
  aligned: CaptionClip["words"] | undefined,
  i: number,
  wordCount: number,
): { startMs?: number; endMs?: number } | undefined {
  if (aligned) {
    const w = aligned[i]
    return { startMs: clip.startMs + w.startMs, endMs: clip.startMs + w.endMs }
  }
  if (i === 0) {
    return { startMs: clip.startMs + (clip.words?.[0]?.startMs ?? 0) }
  }
  if (i === wordCount - 1) {
    return { endMs: clip.startMs + clip.durationMs }
  }
  return undefined
}
