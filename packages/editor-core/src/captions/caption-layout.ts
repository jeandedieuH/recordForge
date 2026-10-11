import type {
  CanvasAspectRatio,
  CaptionClip,
  CaptionDesign,
  CaptionLayout,
  TimelineClip,
} from "@recordforge/contracts"
import { DEFAULT_CAPTION_DESIGN } from "@recordforge/contracts"

import { CAPTION_LOOKS, type CaptionLook } from "./caption-looks"
import { profileForCanvas } from "./caption-profiles"
import {
  balanceLines,
  captionWords,
  joinCaptionWords,
  paginateWords,
  reflowCueText,
  splitOversized,
  type CaptionTextWord,
} from "./caption-text"
import { measureCaptionTextEm } from "./inter-metrics"

// CSS line-height is the em a line box occupies; libass uses the same
// font-relative line height (its 1.43 win-metrics advance is compensated by
// the writer), so 1.25 is what both the preview and the ASS renderer use.
const CAPTION_LINE_HEIGHT_EM = 1.25
// Headroom against estimator drift: effective max width is 96% of the profile.
const WIDTH_SAFETY = 0.96
const MIN_PAGE_MS = 450
const CONTINUITY_GAP_MS = 120
// Fallback when pages*MIN_PAGE_MS exceeds the cue duration — one dense page.
const OVERFLOW_MAX_LINES = 4

type CaptionLayoutPage = CaptionLayout["pages"][number]
type CaptionLayoutLine = CaptionLayoutPage["lines"][number]

export interface CaptionLayoutInput {
  text: string
  startMs: number
  endMs: number
  design: CaptionDesign
  canvas: { width: number; height: number; aspectRatio?: CanvasAspectRatio }
  // Optional measured word timings RELATIVE to `input.startMs` — the same
  // shape `clip.words` stores, so callers pass it verbatim. When its count
  // equals the total display-word count across all pages the highlight
  // windows use real karaoke times; anything else falls back to the
  // proportional weighting below.
  words?: { text: string; startMs: number; endMs: number }[]
}

/** The resolved layout numbers segmentation reuses verbatim — one source. */
export interface CaptionTextBudget {
  fontPx: number
  maxTextWidthPx: number
  maxLines: number
  fontWeight: CaptionLook["fontWeight"]
  uppercase: boolean
  highlight: boolean
}

/**
 * Canvas+design → the resolved text budget (font size, effective line width,
 * line cap) — the exact numbers `resolveCaptionLayout` works with, shared so
 * segmentation budgets cues in the same units.
 */
export function captionTextBudget(
  canvas: { width: number; height: number; aspectRatio?: CanvasAspectRatio },
  design: CaptionDesign,
): CaptionTextBudget {
  const width = canvas.width
  const short = Math.min(width, canvas.height)
  const profile = profileForCanvas(canvas)
  const look = CAPTION_LOOKS[design.preset]
  const fontPx = Math.max(14, Math.round(short * profile.fontScale * design.sizeScale))
  const chipPadX = look.chip ? look.chip.padXEm * fontPx : 0
  // The chip pad is real canvas chrome — it must never push text past the
  // profile's width budget, and the box itself must stay inside the canvas
  // with a 4% side margin.
  const maxTextWidthPx =
    Math.min(width * profile.maxTextWidth, width - 2 * (chipPadX + 0.04 * width)) * WIDTH_SAFETY
  return {
    fontPx,
    maxTextWidthPx,
    maxLines: Math.max(1, profile.maxLines),
    fontWeight: look.fontWeight,
    uppercase: design.uppercase ?? look.uppercase,
    highlight: look.highlight !== null,
  }
}

/**
 * Resolve a cue + design + canvas into the px-level `CaptionLayout` consumed
 * identically by the preview renderer and the Rust ASS writer. Pure and
 * deterministic — no DOM, no Date, no randomness.
 */
export function resolveCaptionLayout(input: CaptionLayoutInput): CaptionLayout {
  const { canvas, design } = input
  const width = canvas.width
  const height = canvas.height
  const profile = profileForCanvas(canvas)
  const look = CAPTION_LOOKS[design.preset]
  const budget = captionTextBudget(canvas, design)
  const { fontPx, maxTextWidthPx } = budget
  const lineHeightPx = round2(fontPx * CAPTION_LINE_HEIGHT_EM)
  const uppercase = design.uppercase ?? look.uppercase
  const accent = design.accentColor ?? look.accentDefault
  const chipPadX = look.chip ? look.chip.padXEm * fontPx : 0
  const chipPadY = look.chip ? look.chip.padYEm * fontPx : 0
  const outlineWidth = look.outline ? look.outline.widthEm * fontPx : 0
  const letterSpacingPx = look.letterSpacingEm * fontPx

  // 2. Reflow → case → words, measured in px (space cost folded per word).
  // Oversized tokens are split up-front so EVERY path (fit, overflow page)
  // stays inside the width budget.
  const text = reflowCueText(input.text)
  const displayText = uppercase ? text.toUpperCase() : text
  const widthOf = (value: string) =>
    measureCaptionTextEm(value, look.fontWeight) * fontPx + letterSpacingPx * [...value].length
  const words = splitOversized(captionWords(displayText), widthOf, maxTextWidthPx)

  // 3. Break lines; paginate when the cue needs more than maxLines, then
  // balance each page's lines under the same width cap.
  const durationMs = Math.max(1, Math.round(input.endMs) - Math.round(input.startMs))
  const maxLines = budget.maxLines
  const fitted = balanceLines(words, widthOf, maxTextWidthPx, maxLines)
  let linePages: CaptionTextWord[][][]
  if (fitted.length <= maxLines) {
    linePages = [fitted]
  } else {
    const rawPages = paginateWords(words, widthOf, maxTextWidthPx, maxLines)
    if (rawPages.length * MIN_PAGE_MS > durationMs) {
      // Too short to paginate legibly — one dense page, up to 4 lines.
      linePages = [balanceLines(words, widthOf, maxTextWidthPx, OVERFLOW_MAX_LINES)]
    } else {
      linePages = rawPages.map((page) =>
        balanceLines(page.flat(), widthOf, maxTextWidthPx, page.length),
      )
    }
  }

  // 4. Page windows: proportional to character count with a MIN_PAGE_MS floor,
  // contiguous, exactly covering [startMs, endMs).
  const startMs = Math.round(input.startMs)
  const charCounts = linePages.map((lines) =>
    lines.reduce((sum, line) => sum + joinCaptionWords(line).length, 0),
  )
  const totalChars = charCounts.reduce((a, b) => a + b, 0) || 1
  const floors = linePages.map(() => MIN_PAGE_MS)
  const free = Math.max(0, durationMs - floors.reduce((a, b) => a + b, 0))
  const pageDurations = floors.map(
    (floor, i) => floor + Math.round((free * charCounts[i]) / totalChars),
  )
  // Give any rounding leftover to the last page so windows tile exactly.
  const allocated = pageDurations.reduce((a, b) => a + b, 0)
  pageDurations[pageDurations.length - 1] += durationMs - allocated

  // Flat display-word list across ALL pages (page → line → word order) —
  // the global count check that decides whether stored word timings match
  // this layout's token stream. Stored words are per display token BEFORE
  // oversized splitting/uppercasing, so a count mismatch simply means the
  // stored timings no longer describe this cue → proportional fallback.
  const flatDisplayWords: { text: string; pageIndex: number; lineIndex: number }[] = []
  linePages.forEach((page, pageIndex) =>
    page.forEach((line, lineIndex) =>
      line.forEach((word) => flatDisplayWords.push({ text: word.text, pageIndex, lineIndex })),
    ),
  )
  const storedWords =
    input.words !== undefined && input.words.length === flatDisplayWords.length ? input.words : null

  const pages: CaptionLayoutPage[] = []
  let pageStart = startMs
  let wordCursor = 0
  for (let p = 0; p < linePages.length; p++) {
    const pageEnd = p === linePages.length - 1 ? startMs + durationMs : pageStart + pageDurations[p]
    const lines = linePages[p]

    // Vertical anchor: bottom grows upward, top grows downward, center stays —
    // so the block stays fixed while pages change line count.
    const lineCount = Math.max(1, lines.length)
    const outerHeight = lineCount * lineHeightPx + 2 * (chipPadY + outlineWidth)
    const outerTop = placeOuterTop(design.placement, height, profile, design.offsetY, outerHeight)
    const textTop = outerTop + chipPadY + outlineWidth
    const blockCenterY = textTop + (lineCount * lineHeightPx) / 2

    // 5. Word timing for highlight looks. With matching stored timings the
    // windows are the real measured ones (clamped into the page, kept
    // monotone); otherwise contiguous windows ∝ word weight with a trailing
    // punctuation pause bonus.
    const pageLines: CaptionLayoutLine[] = lines.map((line) => ({
      text: joinCaptionWords(line),
      words: [],
    }))
    const pageWordCount = lines.reduce((sum, line) => sum + line.length, 0)
    if (look.highlight) {
      const flat: { text: string; lineIndex: number; globalIndex: number }[] = []
      lines.forEach((line, lineIndex) =>
        line.forEach((word) =>
          flat.push({ text: word.text, lineIndex, globalIndex: wordCursor + flat.length }),
        ),
      )
      if (storedWords) {
        // Real karaoke windows: absolute = cue start + stored relative,
        // clamped into the owning page, non-overlapping in sequence.
        let prevEnd = pageStart
        flat.forEach(({ text: wordText, lineIndex, globalIndex }) => {
          const stored = storedWords[globalIndex]
          const rawStart = startMs + stored.startMs
          const rawEnd = startMs + stored.endMs
          const wordStart = Math.max(prevEnd, Math.min(Math.max(rawStart, pageStart), pageEnd))
          const wordEnd = Math.max(wordStart, Math.min(Math.max(rawEnd, pageStart), pageEnd))
          pageLines[lineIndex].words.push({
            text: wordText,
            startMs: wordStart,
            endMs: wordEnd,
          })
          prevEnd = wordEnd
        })
      } else {
        const weights = flat.map(({ text: wordText }) => wordTimingWeight(wordText))
        const totalWeight = weights.reduce((a, b) => a + b, 0) || 1
        const pageDuration = pageEnd - pageStart
        // Cumulative-exact boundaries: each boundary rounds its own cumulative
        // share, so windows tile the page exactly and can never go negative.
        let cumulative = 0
        let wordStart = pageStart
        flat.forEach(({ text: wordText, lineIndex }, i) => {
          cumulative += weights[i]
          const wordEnd =
            i === flat.length - 1
              ? pageEnd
              : pageStart + Math.round((pageDuration * cumulative) / totalWeight)
          pageLines[lineIndex].words.push({ text: wordText, startMs: wordStart, endMs: wordEnd })
          wordStart = wordEnd
        })
      }
    }
    wordCursor += pageWordCount

    pages.push({
      startMs: pageStart,
      endMs: pageEnd,
      animateIn: p === 0,
      animateOut: p === linePages.length - 1,
      lines: pageLines,
      block: {
        centerX: width / 2,
        centerY: round2(blockCenterY),
        height: round2(lineCount * lineHeightPx),
      },
    })
    pageStart = pageEnd
  }

  return {
    lookId: look.id,
    fontPx,
    lineHeightPx,
    fontWeight: look.fontWeight,
    letterSpacingPx,
    textColor: look.textColor,
    chip: look.chip
      ? {
          color: look.chip.color === "accent" ? accent : look.chip.color,
          opacity: look.chip.opacity,
          radiusPx: round2(look.chip.radiusEm * fontPx),
          padXPx: round2(chipPadX),
          padYPx: round2(chipPadY),
        }
      : null,
    outline: look.outline
      ? {
          color: look.outline.color,
          opacity: look.outline.opacity,
          widthPx: round2(outlineWidth),
        }
      : null,
    shadow: look.shadow
      ? {
          color: look.shadow.color,
          opacity: look.shadow.opacity,
          blurPx: round2(look.shadow.blurEm * fontPx),
          offsetYPx: round2(look.shadow.offsetYEm * fontPx),
        }
      : null,
    highlight: look.highlight
      ? {
          mode: look.highlight.mode,
          activeColor:
            look.highlight.activeColor === "accent" ? accent : look.highlight.activeColor,
          inactiveOpacity: look.highlight.inactiveOpacity,
        }
      : null,
    animation: { ...look.animation },
    pages,
  }
}

/** Pause weighting for highlight timing — punctuation earns a longer window. */
function wordTimingWeight(text: string): number {
  const visible = [...text].filter((c) => /\S/.test(c)).length
  const trailing = text.match(/[.,;:!?…]+$/)?.[0] ?? ""
  let bonus = 0
  for (const char of trailing) {
    bonus += /[.?!…]/.test(char) ? 4 : 2
  }
  return Math.max(2, visible) + bonus
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Outer-box top edge for a placement, offset-adjusted, then clamped so the
 * whole box (text + chip + outline) stays inside [2%, 98%] of the height.
 */
function placeOuterTop(
  placement: CaptionDesign["placement"],
  height: number,
  profile: ReturnType<typeof profileForCanvas>,
  offsetY: number,
  outerHeight: number,
): number {
  const offset = offsetY * height
  let top: number
  switch (placement) {
    case "top":
      top = height * profile.topInset + offset
      break
    case "center":
      top = height / 2 - outerHeight / 2 + offset
      break
    default:
      top = height * (1 - profile.bottomInset) - outerHeight + offset
      break
  }
  const minTop = 0.02 * height
  const maxTop = 0.98 * height - outerHeight
  if (maxTop < minTop) return (height - outerHeight) / 2
  return Math.min(Math.max(top, minTop), maxTop)
}

/**
 * Merge page-animate flags for consecutive pages separated by a speech gap
 * (≤ CONTINUITY_GAP_MS): the outgoing page skips its out-animation and the
 * incoming page skips its in-animation so captions don't blink between cues.
 * Input must be sorted by startMs; returns new objects.
 */
export function applyCaptionContinuity(pages: CaptionLayoutPage[]): CaptionLayoutPage[] {
  const out = pages.map((page) => ({ ...page }))
  for (let i = 0; i + 1 < out.length; i++) {
    const gap = out[i + 1].startMs - out[i].endMs
    if (gap >= 0 && gap <= CONTINUITY_GAP_MS) {
      out[i].animateOut = false
      out[i + 1].animateIn = false
    }
  }
  return out
}

/** The page visible at `timeMs` — start inclusive, end exclusive. */
export function activeCaptionPage(layout: CaptionLayout, timeMs: number): CaptionLayoutPage | null {
  return layout.pages.find((page) => timeMs >= page.startMs && timeMs < page.endMs) ?? null
}

/** Active word position within a page, or null when the look has no word data. */
export function activeCaptionWordIndex(
  page: CaptionLayoutPage,
  timeMs: number,
): { line: number; word: number } | null {
  for (let line = 0; line < page.lines.length; line++) {
    const words = page.lines[line].words
    for (let word = 0; word < words.length; word++) {
      if (timeMs >= words[word].startMs && timeMs < words[word].endMs) {
        return { line, word }
      }
    }
  }
  return null
}

/**
 * Scrub-safe animation state at `timeMs` — purely time-derived. Ease-out in
 * (opacity + scale from fromScale→1), fade-only out; honors the page's
 * animateIn/animateOut flags (interior page swaps are hard cuts).
 */
export function captionAnimationState(
  layout: CaptionLayout,
  page: CaptionLayoutPage,
  timeMs: number,
): { opacity: number; scale: number } {
  const { inMs, outMs, fromScale } = layout.animation
  const progress = timeMs - page.startMs
  const remaining = page.endMs - timeMs
  if (timeMs < page.startMs || timeMs >= page.endMs) {
    return { opacity: 0, scale: 1 }
  }
  if (page.animateIn && inMs > 0 && progress < inMs) {
    const t = easeOut(progress / inMs)
    return { opacity: t, scale: fromScale + (1 - fromScale) * t }
  }
  if (page.animateOut && outMs > 0 && remaining < outMs) {
    return { opacity: easeOut(remaining / outMs), scale: 1 }
  }
  return { opacity: 1, scale: 1 }
}

function easeOut(t: number): number {
  const clamped = Math.min(Math.max(t, 0), 1)
  return 1 - (1 - clamped) ** 2
}

/**
 * Track-level caption design: `track.captionDesign` over the defaults, with a
 * legacy fallback — tracks saved before the design system derive their look
 * from the first caption clip's style/placement.
 */
export function resolveCaptionDesign(
  track: { captionDesign?: CaptionDesign; clips: TimelineClip[] } | undefined,
): CaptionDesign {
  const base: CaptionDesign = { ...DEFAULT_CAPTION_DESIGN, ...(track?.captionDesign ?? {}) }
  if (track?.captionDesign) return base
  const firstCaption = track?.clips.find((clip): clip is CaptionClip => clip.kind === "caption")
  if (!firstCaption) return base
  return {
    ...base,
    preset: firstCaption.style ?? base.preset,
    placement: firstCaption.placement ?? base.placement,
  }
}

/**
 * Per-clip design: the clip's own style/placement override the track design.
 * With a track-level `captionDesign`, `style: "default"` means "inherit" — it
 * is the schema default and indistinguishable from unset, so it must not
 * shadow the track preset. On legacy tracks without a design the clip style
 * stays authoritative (today's behavior, including an explicit "default").
 */
export function resolveClipDesign(
  track: { captionDesign?: CaptionDesign; clips: TimelineClip[] } | undefined,
  clip: CaptionClip,
): CaptionDesign {
  const base = resolveCaptionDesign(track)
  const hasTrackDesign = track?.captionDesign !== undefined
  return {
    ...base,
    preset: hasTrackDesign && clip.style === "default" ? base.preset : clip.style,
    placement: clip.placement ?? base.placement,
  }
}
