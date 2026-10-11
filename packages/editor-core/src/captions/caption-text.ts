// Pure caption text helpers — no DOM, no measurements beyond the caller's
// width function, so preview and export break identical lines.

/** A display token: the text plus whether a space precedes it in the cue. */
export interface CaptionTextWord {
  text: string
  spaceBefore: boolean
}

// Scripts without inter-word spaces break between characters — but never
// before a closing punctuation mark (。、！？… attach to the previous char).
export const SPACELESS_CHAR =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u0e00-\u0e7f\u0e80-\u0eff\u1780-\u17ff\u1000-\u109f]/
export const CLOSING_PUNCT =
  /^[。、！？：；．｡・，．「」『』【】〈〉《》（）［］｛｝…—–·、"'’”)\]}?!.,;:…%]$/
// A cue where every non-empty line (≥2) opens with a dialogue dash is a
// speaker list — its line breaks carry meaning and survive reflow.
const DIALOGUE_LINE = /^[-–—]/

/** Normalize imported cue text: unify newlines, strip controls, collapse runs. */
export function normalizeCueText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, "\n")
      // eslint-disable-next-line no-control-regex -- intentionally stripping control chars
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "")
      .replace(/[ \t]+/g, " ")
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      .trim()
  )
}

/**
 * Reflow cue text into wrapped form. Explicit newlines are re-flowed (joined
 * with spaces) EXCEPT dialogue-dash lists, where every line keeps its break.
 */
export function reflowCueText(text: string): string {
  const normalized = normalizeCueText(text)
  const lines = normalized.split("\n").filter((line) => line.length > 0)
  if (lines.length >= 2 && lines.every((line) => DIALOGUE_LINE.test(line))) {
    return lines.join("\n")
  }
  return lines.join(" ")
}

/**
 * Tokenize into display words. Whitespace splits; spaceless scripts
 * (CJK/Kana/Thai/Lao/Khmer/Myanmar) break between characters, never before
 * closing punctuation.
 */
export function captionWords(text: string): CaptionTextWord[] {
  const words: CaptionTextWord[] = []
  let atChunkStart = false // first token of a whitespace-separated chunk
  const push = (word: string) => {
    if (word === "") return
    words.push({ text: word, spaceBefore: atChunkStart && words.length > 0 })
    atChunkStart = false
  }
  for (const chunk of text.split(/\s+/)) {
    if (chunk === "") continue
    atChunkStart = true
    if (![...chunk].some((char) => SPACELESS_CHAR.test(char))) {
      push(chunk)
      continue
    }
    // Spaceless-script chunk: char-level tokens, punctuation attached.
    let current = ""
    for (const char of chunk) {
      const spaceless = SPACELESS_CHAR.test(char)
      if (spaceless && CLOSING_PUNCT.test(char)) {
        current += char
        continue
      }
      const chars = [...current]
      const currentEndsSpaceless = current !== "" && SPACELESS_CHAR.test(chars[chars.length - 1])
      if (spaceless || currentEndsSpaceless) {
        // Script boundary or a char-level word — start a new token.
        push(current)
        current = char
      } else {
        current += char
      }
    }
    push(current)
  }
  return words
}

/**
 * Split normalized text into two parts at the word boundary nearest
 * `ratio` × character count, preferring a boundary right after clause
 * punctuation (,;:.?!…) when one sits within ±15% of the ideal cut.
 * Returns trimmed `[left, right]`; a single-word text returns `[text, text]`.
 */
export function splitCaptionText(text: string, ratio: number): [string, string] {
  const words = captionWords(text)
  if (words.length <= 1) return [text.trim(), text.trim()]
  const total = text.length
  const ideal = total * Math.min(Math.max(ratio, 0), 1)
  // Cumulative character position at each inter-word boundary.
  let cursor = 0
  let best = -1
  let bestScore = Infinity
  for (let i = 0; i < words.length; i++) {
    cursor += words[i].text.length + (i > 0 && words[i].spaceBefore ? 1 : 0)
    if (i === words.length - 1) break
    const distance = Math.abs(cursor - ideal)
    const punctuationBonus = /[,;:.?!…]$/.test(words[i].text) && distance <= ideal * 0.15
    const score = punctuationBonus ? distance * 0.25 : distance
    if (score < bestScore) {
      bestScore = score
      best = i
    }
  }
  const left = joinCaptionWords(words.slice(0, best + 1))
  const right = joinCaptionWords(words.slice(best + 1))
  return [left.trim(), right.trim()]
}

/**
 * Word-boundary slice of normalized text between two character ratios. Never
 * returns a partial word; an empty range returns "".
 */
export function sliceCaptionText(text: string, fromRatio: number, toRatio: number): string {
  const words = captionWords(text)
  if (words.length === 0 || toRatio <= fromRatio) return ""
  const total = text.length
  const from = total * Math.min(Math.max(fromRatio, 0), 1)
  const to = total * Math.min(Math.max(toRatio, 0), 1)
  // Word boundaries as cumulative offsets; pick nearest boundary to each edge.
  const boundaries: number[] = [0]
  let cursor = 0
  for (let i = 0; i < words.length; i++) {
    cursor += words[i].text.length + (i > 0 && words[i].spaceBefore ? 1 : 0)
    boundaries.push(cursor)
  }
  const nearest = (target: number) =>
    boundaries.reduce(
      (best, b, i) => (Math.abs(b - target) < Math.abs(boundaries[best] - target) ? i : best),
      0,
    )
  const lo = nearest(from)
  const hi = nearest(to)
  if (hi <= lo) return ""
  return joinCaptionWords(words.slice(lo, hi))
}

/** Rebuild display text — spaceless-script tokens join without a space. */
export function joinCaptionWords(words: CaptionTextWord[]): string {
  return words
    .map((word, index) => (index > 0 && word.spaceBefore ? ` ${word.text}` : word.text))
    .join("")
}

/** Stored word timing — times RELATIVE to the containing clip/cue start. */
export interface CaptionWordTimingLike {
  text: string
  startMs: number
  endMs: number
}

/**
 * Display-token counts of two split texts checked against a stored list:
 * the split is only usable when every stored word lands on exactly one side.
 */
function captionWordSplitCounts(
  leftText: string,
  rightText: string,
  totalWords: number,
): { left: number; right: number } | null {
  const left = captionWords(reflowCueText(leftText)).length
  const right = captionWords(reflowCueText(rightText)).length
  if (left < 1 || right < 1 || left + right !== totalWords) return null
  return { left, right }
}

/**
 * Index-partition stored word timings across a text split. Left keeps the
 * first `captionWords(reflowCueText(leftText))` entries; right keeps the
 * rest rebased by `-splitOffsetMs`, clamped ≥ 0. Either side is undefined
 * when the partition can't cover every stored word consistently — an
 * inconsistent partition must be dropped, never emitted.
 */
export function partitionCaptionWordTiming(
  words: CaptionWordTimingLike[] | undefined,
  leftText: string,
  rightText: string,
  splitOffsetMs: number,
): { left?: CaptionWordTimingLike[]; right?: CaptionWordTimingLike[] } {
  if (!words || words.length === 0) return {}
  const counts = captionWordSplitCounts(leftText, rightText, words.length)
  if (!counts) return {}
  return {
    left: words.slice(0, counts.left),
    right: words.slice(counts.left).map((w) => ({
      text: w.text,
      startMs: Math.max(0, w.startMs - splitOffsetMs),
      endMs: Math.max(0, w.endMs - splitOffsetMs),
    })),
  }
}

/**
 * Index-only variant of `partitionCaptionWordTiming` for ABSOLUTE-time
 * fields (e.g. `sourceWords` in container ms): the same display-token
 * boundary determines the slice, but times are never rebased. Sharing
 * `captionWordSplitCounts` keeps the two fields' partitions in lock-step.
 */
export function partitionCaptionWordTimingByIndex<T extends CaptionWordTimingLike>(
  words: T[] | undefined,
  leftText: string,
  rightText: string,
): { left?: T[]; right?: T[] } {
  if (!words || words.length === 0) return {}
  const counts = captionWordSplitCounts(leftText, rightText, words.length)
  if (!counts) return {}
  return { left: words.slice(0, counts.left), right: words.slice(counts.left) }
}

/**
 * Word timings for the kept pieces of a range-delete. Left keeps the first
 * `leftCount` entries; right keeps the LAST `rightCount` rebased by
 * `-rightOffsetMs`, clamped ≥ 0. Both sides empty when the indices would
 * overlap or a piece carries the full-text fallback.
 */
/**
 * Display-token counts of the kept pieces of a range-delete: left takes the
 * first `leftCount` stored words, right the LAST `rightCount` — words in the
 * cut are dropped from both sides. Null when a side falls back to the full
 * text or the counts overlap the stored list.
 */
function rangeCaptionWordCounts(
  leftText: string | null,
  rightText: string | null,
  fullText: string,
  totalWords: number,
): { left: number; right: number } | null {
  // A side falling back to the original text can't be partitioned — drop.
  if (
    (leftText !== null && leftText === fullText) ||
    (rightText !== null && rightText === fullText)
  ) {
    return null
  }
  const left = leftText ? captionWords(reflowCueText(leftText)).length : 0
  const right = rightText ? captionWords(reflowCueText(rightText)).length : 0
  // Overlapping indices mean the stored list can't cover both pieces.
  if (left + right > totalWords) return null
  return { left, right }
}

export function rangeCaptionWordTiming(
  words: CaptionWordTimingLike[] | undefined,
  leftText: string | null,
  rightText: string | null,
  fullText: string,
  rightOffsetMs: number,
): { left?: CaptionWordTimingLike[]; right?: CaptionWordTimingLike[] } {
  if (!words || words.length === 0) return {}
  const counts = rangeCaptionWordCounts(leftText, rightText, fullText, words.length)
  if (!counts) return {}
  const out: { left?: CaptionWordTimingLike[]; right?: CaptionWordTimingLike[] } = {}
  if (counts.left > 0) out.left = words.slice(0, counts.left)
  if (counts.right > 0) {
    out.right = words.slice(words.length - counts.right).map((w) => ({
      text: w.text,
      startMs: Math.max(0, w.startMs - rightOffsetMs),
      endMs: Math.max(0, w.endMs - rightOffsetMs),
    }))
  }
  return out
}

/**
 * Index-only variant of `rangeCaptionWordTiming` for ABSOLUTE-time fields
 * (container ms stay verbatim — only the index slice is shared).
 */
export function rangeCaptionWordTimingByIndex<T extends CaptionWordTimingLike>(
  words: T[] | undefined,
  leftText: string | null,
  rightText: string | null,
  fullText: string,
): { left?: T[]; right?: T[] } {
  if (!words || words.length === 0) return {}
  const counts = rangeCaptionWordCounts(leftText, rightText, fullText, words.length)
  if (!counts) return {}
  const out: { left?: T[]; right?: T[] } = {}
  if (counts.left > 0) out.left = words.slice(0, counts.left)
  if (counts.right > 0) out.right = words.slice(words.length - counts.right)
  return out
}

/**
 * Rebase + clamp stored timings for a duration/start change: shift every
 * time by `-offsetMs`, drop words fully outside `[0, durationMs)`, clamp
 * ends into the window. Deliberately simple — when the surviving count no
 * longer matches the text, the layout engine falls back to proportional
 * weighting on its own.
 */
/**
 * Indices of the stored timings surviving a trim window — the same keep
 * predicate `clampCaptionWordTiming` applies (shifted window `[0, duration)`).
 * Absolute-time fields (`sourceWords`) filter by this index set so the two
 * fields can never diverge in length.
 */
export function keptCaptionWordIndices(
  words: CaptionWordTimingLike[] | undefined,
  offsetMs: number,
  durationMs: number,
): number[] | undefined {
  if (!words || words.length === 0) return undefined
  const indices: number[] = []
  words.forEach((w, i) => {
    const startMs = w.startMs - offsetMs
    const endMs = w.endMs - offsetMs
    if (endMs > 0 && startMs < durationMs) indices.push(i)
  })
  return indices.length > 0 ? indices : undefined
}

export function clampCaptionWordTiming(
  words: CaptionWordTimingLike[] | undefined,
  offsetMs: number,
  durationMs: number,
): CaptionWordTimingLike[] | undefined {
  const indices = keptCaptionWordIndices(words, offsetMs, durationMs)
  if (!indices || !words) return undefined
  return indices.map((i) => ({
    text: words[i].text,
    startMs: Math.max(0, words[i].startMs - offsetMs),
    endMs: Math.min(words[i].endMs - offsetMs, durationMs),
  }))
}

const SPACE_WIDTH_FALLBACK = 0.27 // em — only used when widthOf(" ") yields 0

interface MeasuredWord {
  word: CaptionTextWord
  width: number
}

function measure(words: CaptionTextWord[], widthOf: (text: string) => number): MeasuredWord[] {
  const spaceWidth = widthOf(" ") || SPACE_WIDTH_FALLBACK
  return words.map((word) => ({
    word,
    // spaceBefore cost is folded into the word itself so line math stays a
    // simple running sum.
    width: widthOf(word.text) + (word.spaceBefore ? spaceWidth : 0),
  }))
}

/**
 * Minimal line count via greedy fit; when that needs more than `maxLines`
 * lines the GREEDY overflow is returned so the caller can paginate instead.
 * Otherwise the n-line layout is balanced: smallest width cap that still fits
 * n lines (minimizes the widest line), then a DP minimizing squared raggedness
 * under that cap; a final line under ~25% of the cap is heavily penalized.
 */
export function balanceLines(
  words: CaptionTextWord[],
  widthOf: (text: string) => number,
  maxWidth: number,
  maxLines: number,
): CaptionTextWord[][] {
  const measured = measure(words, widthOf)
  if (measured.length === 0) return []
  const greedy = greedyLines(measured, maxWidth)
  const n = greedy.length
  if (n > Math.max(1, maxLines)) return greedy.map((line) => line.map((m) => m.word))
  if (n <= 1) return greedy.map((line) => line.map((m) => m.word))

  // Smallest cap that still fits in n lines — the widest line can't shrink
  // below a single word, so the search floor is the widest word.
  let lo = Math.ceil(Math.max(...measured.map((m) => m.width)))
  let hi = Math.ceil(maxWidth)
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (greedyLines(measured, mid).length <= n) hi = mid
    else lo = mid + 1
  }
  const cap = lo

  // DP partition into exactly n lines each ≤ cap, minimizing Σ(cap − w)² —
  // equal-width lines beat ragged ones at the same widest bound.
  const dp: number[][] = []
  const cut: number[][] = []
  for (let k = 0; k <= n; k++) {
    dp[k] = new Array(measured.length + 1).fill(Infinity)
    cut[k] = new Array(measured.length + 1).fill(0)
  }
  dp[0][0] = 0
  for (let k = 1; k <= n; k++) {
    for (let j = 1; j <= measured.length; j++) {
      for (let i = k - 1; i < j; i++) {
        const w = lineWidth(measured.slice(i, j))
        // Larger i drops a word → narrower; skip only the oversize starts.
        if (w > cap) continue
        const slack = cap - w
        const isLast = j === measured.length
        const runtPenalty = isLast && w < cap * 0.25 ? cap * cap * 4 : 0
        const score = dp[k - 1][i] + slack * slack + runtPenalty
        if (score < dp[k][j]) {
          dp[k][j] = score
          cut[k][j] = i
        }
      }
    }
  }
  if (dp[n][measured.length] === Infinity) {
    return greedy.map((line) => line.map((m) => m.word))
  }
  const lines: MeasuredWord[][] = []
  let j = measured.length
  for (let k = n; k > 0; k--) {
    const i = cut[k][j]
    lines.unshift(measured.slice(i, j))
    j = i
  }
  return lines.map((line) => line.map((m) => m.word))
}

/**
 * Greedy fill into pages of at most `maxLines` lines each, preferring a page
 * break after sentence/clause punctuation inside the last 35% of the page.
 * A word wider than the line is hard-split by character — the fragment keeps
 * the word's spaceBefore.
 */
export function paginateWords(
  words: CaptionTextWord[],
  widthOf: (text: string) => number,
  maxWidth: number,
  maxLines: number,
): CaptionTextWord[][][] {
  const measured = measure(splitOversized(words, widthOf, maxWidth), widthOf)
  const lines = greedyLines(measured, maxWidth)
  if (lines.length <= maxLines) return lines.length ? [lines.map((l) => l.map((m) => m.word))] : []
  const pages: CaptionTextWord[][][] = []
  let lineIndex = 0
  while (lineIndex < lines.length) {
    let pageEnd = Math.min(lineIndex + maxLines, lines.length)
    if (pageEnd < lines.length) {
      // Prefer the last sentence/clause break in the page's last 35%.
      const windowStart = lineIndex + Math.floor((pageEnd - lineIndex) * 0.65)
      for (let i = pageEnd - 1; i > windowStart; i--) {
        const lastWord = lines[i][lines[i].length - 1]
        if (lastWord && /[,;:.?!…]$/.test(lastWord.word.text)) {
          pageEnd = i + 1
          break
        }
      }
    }
    pages.push(lines.slice(lineIndex, pageEnd).map((l) => l.map((m) => m.word)))
    lineIndex = pageEnd
  }
  return pages
}

function lineWidth(line: MeasuredWord[]): number {
  return line.reduce((sum, m) => sum + m.width, 0)
}

function greedyLines(measured: MeasuredWord[], maxWidth: number): MeasuredWord[][] {
  const lines: MeasuredWord[][] = []
  let line: MeasuredWord[] = []
  let width = 0
  for (const m of measured) {
    if (line.length > 0 && width + m.width > maxWidth) {
      lines.push(line)
      line = []
      width = 0
    }
    line.push(m)
    width += m.width
  }
  if (line.length) lines.push(line)
  return lines
}

// Positions after these characters are legal break hints inside an oversized
// token (URLs, paths) — the fragment keeps the hint char.
const OVERSIZED_BREAK_AFTER = /[/\\\-_.?&=#]/

/**
 * Hard-split a word that alone exceeds the line width. Prefers breaking right
 * after the last break-hint character inside the fitting piece; falls back to
 * a raw character split when no hint exists. Fragments after the first keep
 * spaceBefore=false so the token re-joins without injected spaces.
 */
export function splitOversized(
  words: CaptionTextWord[],
  widthOf: (text: string) => number,
  maxWidth: number,
): CaptionTextWord[] {
  const out: CaptionTextWord[] = []
  for (const word of words) {
    if (widthOf(word.text) <= maxWidth) {
      out.push(word)
      continue
    }
    let piece = ""
    let firstFragment = true
    for (const char of word.text) {
      if (piece === "" || widthOf(piece + char) <= maxWidth) {
        piece += char
        continue
      }
      // Find the last break hint inside the fitting piece.
      let cutLength = -1
      for (let i = piece.length - 1; i > 0; i--) {
        if (OVERSIZED_BREAK_AFTER.test(piece[i])) {
          cutLength = i + 1
          break
        }
      }
      const cut = cutLength > 0 ? piece.slice(0, cutLength) : piece
      out.push({ text: cut, spaceBefore: firstFragment ? word.spaceBefore : false })
      firstFragment = false
      piece = piece.slice(cut.length) + char
    }
    if (piece !== "") {
      out.push({ text: piece, spaceBefore: firstFragment ? word.spaceBefore : false })
    }
  }
  return out
}
