import { describe, expect, it } from "vitest"
import type { CanvasAspectRatio, CaptionClip, TimelineTrack } from "@recordforge/contracts"
import { DEFAULT_CAPTION_DESIGN } from "@recordforge/contracts"
import {
  activeCaptionPage,
  activeCaptionWordIndex,
  applyCaptionContinuity,
  captionAnimationState,
  captionTextBudget,
  resolveCaptionDesign,
  resolveCaptionLayout,
  resolveClipDesign,
  type CaptionLayoutInput,
} from "./caption-layout"
import { normalizeCueText } from "./caption-text"
import { profileForCanvas } from "./caption-profiles"
import { measureCaptionTextEm } from "./inter-metrics"

function layoutFor(overrides: Partial<CaptionLayoutInput> = {}) {
  return resolveCaptionLayout({
    text: "hello world",
    startMs: 0,
    endMs: 2_000,
    design: { ...DEFAULT_CAPTION_DESIGN },
    canvas: { width: 1920, height: 1080, aspectRatio: "16:9" },
    ...overrides,
  })
}

// fontPx = round(short edge × profile.fontScale); canvases are the standard
// tier sizes produced by canvasSizeForAspectRatio.
const FONT_PX_TABLE: [CanvasAspectRatio, [number, number][], number[]][] = [
  [
    "16:9",
    [
      [1920, 1080],
      [2560, 1440],
      [3840, 2160],
    ],
    [46, 61, 92],
  ],
  [
    "5:4",
    [
      [1350, 1080],
      [1800, 1440],
      [2700, 2160],
    ],
    [49, 65, 97],
  ],
  [
    "1:1",
    [
      [1080, 1080],
      [1440, 1440],
      [2160, 2160],
    ],
    [52, 69, 104],
  ],
  [
    "4:5",
    [
      [1080, 1350],
      [1440, 1800],
      [2160, 2700],
    ],
    [56, 75, 112],
  ],
  [
    "9:16",
    [
      [1080, 1920],
      [1440, 2560],
      [2160, 3840],
    ],
    [60, 81, 121],
  ],
]

describe("resolveCaptionLayout — font size", () => {
  it.each(
    FONT_PX_TABLE.flatMap(([ratio, canvases, expected]) =>
      canvases.map(([w, h], i) => ({ ratio, w, h, expected: expected[i] })),
    ),
  )("computes fontPx for $ratio at $w×$h → $expected", ({ ratio, w, h, expected }) => {
    const layout = layoutFor({ canvas: { width: w, height: h, aspectRatio: ratio } })
    expect(layout.fontPx).toBe(expected)
  })

  it("scales with sizeScale", () => {
    const layout = layoutFor({ design: { ...DEFAULT_CAPTION_DESIGN, sizeScale: 1.5 } })
    expect(layout.fontPx).toBe(Math.round(1080 * 0.0425 * 1.5)) // 69
  })
})

describe("resolveCaptionLayout — line breaking and pagination", () => {
  const sentence =
    "The quick brown fox jumps over the lazy dog while five boxing wizards watch quietly now."

  it("fits a ~90-char sentence on ≤2 lines at 16:9", () => {
    const layout = layoutFor({ text: sentence })
    expect(layout.pages).toHaveLength(1)
    expect(layout.pages[0].lines.length).toBeLessThanOrEqual(2)
  })

  it("paginates the same sentence at 9:16 and preserves the text", () => {
    const layout = layoutFor({
      text: sentence,
      canvas: { width: 1080, height: 1920, aspectRatio: "9:16" },
    })
    expect(layout.pages.length).toBeGreaterThan(1)
    const joined = layout.pages
      .map((page) => page.lines.map((line) => line.text).join(" "))
      .join(" ")
    expect(normalizeCueText(joined)).toBe(normalizeCueText(sentence))
    // Pages tile the cue window exactly.
    expect(layout.pages[0].startMs).toBe(0)
    for (let i = 1; i < layout.pages.length; i++) {
      expect(layout.pages[i].startMs).toBe(layout.pages[i - 1].endMs)
    }
    expect(layout.pages[layout.pages.length - 1].endMs).toBe(2_000)
    // Interior boundaries are hard swaps: only the outer edges animate.
    expect(layout.pages[0].animateIn).toBe(true)
    expect(layout.pages[layout.pages.length - 1].animateOut).toBe(true)
    for (const page of layout.pages.slice(1)) expect(page.animateIn).toBe(false)
    for (const page of layout.pages.slice(0, -1)) expect(page.animateOut).toBe(false)
  })

  it("keeps every line under the width budget — seeded random sentences", () => {
    // mulberry32 — deterministic property test over generated text.
    let seed = 0x5eed
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const vocab =
      "the quick brown fox jumps over lazy dog screen recording captions render fast".split(" ")
    for (let run = 0; run < 60; run++) {
      const wordCount = 1 + Math.floor(rand() * 30)
      const text = Array.from(
        { length: wordCount },
        () => vocab[Math.floor(rand() * vocab.length)],
      ).join(" ")
      for (const [w, h, ratio] of [
        [1920, 1080, "16:9"],
        [1080, 1920, "9:16"],
        [1080, 1080, "1:1"],
      ] as const) {
        const canvas = { width: w, height: h, aspectRatio: ratio }
        const layout = layoutFor({ text, canvas })
        // The engine's effective cap: min(profile width, canvas minus chip
        // side chrome) × WIDTH_SAFETY.
        const maxTextWidthPx =
          Math.min(
            w * profileForCanvas(canvas).maxTextWidth,
            w - 2 * ((layout.chip?.padXPx ?? 0) + 0.04 * w),
          ) * 0.96
        for (const page of layout.pages) {
          for (const line of page.lines) {
            // Measured line width must respect the budget (2px epsilon for
            // letter-spacing/rounding slack).
            const measured =
              measureCaptionTextEm(line.text, layout.fontWeight) * layout.fontPx +
              layout.letterSpacingPx * [...line.text].length
            expect(measured, `line "${line.text}"`).toBeLessThanOrEqual(maxTextWidthPx + 2)
          }
        }
      }
    }
  })
})

describe("resolveCaptionLayout — look resolution", () => {
  it("uppercase look transforms the text", () => {
    const layout = layoutFor({ design: { ...DEFAULT_CAPTION_DESIGN, preset: "pop" } })
    expect(layout.lookId).toBe("pop")
    expect(layout.fontWeight).toBe(800)
    expect(layout.pages[0].lines[0].text).toBe("HELLO WORLD")
  })

  it("uppercase:false on the design overrides the look", () => {
    const layout = layoutFor({
      design: { ...DEFAULT_CAPTION_DESIGN, preset: "pop", uppercase: false },
    })
    expect(layout.pages[0].lines[0].text).toBe("hello world")
  })

  it("resolves the accent placeholder", () => {
    const layout = layoutFor({
      design: { ...DEFAULT_CAPTION_DESIGN, preset: "highlight", accentColor: "#22D3EE" },
    })
    expect(layout.chip?.color).toBe("#22D3EE")
    const noAccent = layoutFor({ design: { ...DEFAULT_CAPTION_DESIGN, preset: "highlight" } })
    expect(noAccent.chip?.color).toBe("#FACC15")
  })
})

describe("resolveCaptionLayout — highlight windows", () => {
  const layout = layoutFor({
    text: "slow word here, then faster. tail",
    endMs: 3_000,
    design: { ...DEFAULT_CAPTION_DESIGN, preset: "pop" },
  })
  const words = layout.pages[0].lines.flatMap((line) => line.words)

  it("emits contiguous, monotonic windows covering the page", () => {
    expect(words.length).toBeGreaterThan(1)
    expect(words[0].startMs).toBe(0)
    expect(words[words.length - 1].endMs).toBe(3_000)
    for (let i = 1; i < words.length; i++) {
      expect(words[i].startMs).toBe(words[i - 1].endMs)
      expect(words[i].endMs).toBeGreaterThan(words[i].startMs)
    }
  })

  it("weights punctuation pauses longer than a same-length word", () => {
    // "FASTER." (7 chars + sentence pause) vs "WORD" weighting — the pause
    // bonus must give the punctuated word a larger ms/char window.
    const punct = words.find((w) => w.text === "FASTER.")
    const plain = words.find((w) => w.text === "WORD")
    expect(punct && plain).toBeTruthy()
    const punctPerChar = (punct!.endMs - punct!.startMs) / punct!.text.length
    const plainPerChar = (plain!.endMs - plain!.startMs) / plain!.text.length
    expect(punctPerChar).toBeGreaterThan(plainPerChar)
  })

  it("tiles the page exactly over many weight/duration combinations", () => {
    // Property-style: for arbitrary word sets and (very) short page durations,
    // cumulative boundaries stay monotonic, non-degenerate, and exhaustive.
    let seed = 7
    const rand = () => {
      seed = (seed * 48271) % 2147483647
      return seed / 2147483647
    }
    const canvas = { width: 1080, height: 1920, aspectRatio: "9:16" as const }
    const design = { ...DEFAULT_CAPTION_DESIGN, preset: "pop" as const }
    for (let run = 0; run < 80; run++) {
      const wordCount = 1 + Math.floor(rand() * 12)
      const text = Array.from({ length: wordCount }, (_, i) =>
        i === wordCount - 1 && rand() > 0.5 ? `w${i}.` : `w${i}`,
      ).join(" ")
      const durationMs = 1 + Math.floor(rand() * 4_000)
      const layout = resolveCaptionLayout({
        text,
        startMs: 100,
        endMs: 100 + durationMs,
        design,
        canvas,
      })
      for (const page of layout.pages) {
        const words = page.lines.flatMap((line) => line.words)
        expect(words.length).toBe(wordCount)
        expect(words[0].startMs).toBe(page.startMs)
        expect(words[words.length - 1].endMs).toBe(page.endMs)
        for (let i = 0; i < words.length; i++) {
          expect(words[i].endMs).toBeGreaterThanOrEqual(words[i].startMs)
          if (i > 0) expect(words[i].startMs).toBe(words[i - 1].endMs)
        }
      }
    }
  })

  it("non-highlight looks emit no word windows", () => {
    const plain = layoutFor({ text: "one two three" })
    expect(plain.highlight).toBeNull()
    expect(plain.pages[0].lines.every((line) => line.words.length === 0)).toBe(true)
  })

  it("activeCaptionWordIndex resolves the live word", () => {
    const page = layout.pages[0]
    const mid = words[1]
    const index = activeCaptionWordIndex(page, mid.startMs + 1)
    expect(index).not.toBeNull()
    expect(page.lines[index!.line].words[index!.word].text).toBe(mid.text)
    expect(activeCaptionWordIndex(page, -1)).toBeNull()
  })
})

describe("resolveCaptionLayout — stored word timings", () => {
  const design = { ...DEFAULT_CAPTION_DESIGN, preset: "pop" as const }
  const canvas = { width: 1920, height: 1080, aspectRatio: "16:9" as const }

  it("uses real windows when the stored count matches the display tokens", () => {
    const stored = [
      { text: "SLOW", startMs: 0, endMs: 800 },
      { text: "WORD", startMs: 850, endMs: 1_200 },
      { text: "HERE,", startMs: 1_300, endMs: 1_700 },
      { text: "THEN", startMs: 1_800, endMs: 2_300 },
      { text: "FASTER.", startMs: 2_400, endMs: 2_800 },
      { text: "TAIL", startMs: 2_850, endMs: 3_000 },
    ]
    const layout = resolveCaptionLayout({
      text: "slow word here, then faster. tail",
      startMs: 1_000,
      endMs: 4_000,
      words: stored,
      design,
      canvas,
    })
    const flat = layout.pages.flatMap((page) => page.lines.flatMap((line) => line.words))
    expect(flat).toHaveLength(stored.length)
    // One window ≈ the stored time (rebased to the cue start) ± rounding.
    const third = flat.find((w) => w.text === "HERE,")!
    expect(third.startMs).toBe(1_000 + stored[2].startMs)
    expect(third.endMs).toBe(1_000 + stored[2].endMs)
    // Real windows stay inside their owning page and keep monotonicity.
    for (const page of layout.pages) {
      let prev = page.startMs
      for (const line of page.lines) {
        for (const word of line.words) {
          expect(word.startMs).toBeGreaterThanOrEqual(prev)
          expect(word.startMs).toBeGreaterThanOrEqual(page.startMs)
          expect(word.endMs).toBeLessThanOrEqual(page.endMs)
          expect(word.endMs).toBeGreaterThanOrEqual(word.startMs)
          prev = word.endMs
        }
      }
    }
  })

  it("falls back to proportional windows on a count mismatch", () => {
    const layout = resolveCaptionLayout({
      text: "slow word here, then faster. tail",
      startMs: 1_000,
      endMs: 4_000,
      // Two entries can't cover six display tokens → proportional path.
      words: [
        { text: "SLOW", startMs: 0, endMs: 800 },
        { text: "WORD", startMs: 850, endMs: 1_200 },
      ],
      design,
      canvas,
    })
    const flat = layout.pages.flatMap((page) => page.lines.flatMap((line) => line.words))
    // Proportional windows tile each page exactly from its start.
    for (const page of layout.pages) {
      const pageWords = page.lines.flatMap((line) => line.words)
      expect(pageWords[0].startMs).toBe(page.startMs)
      for (let i = 1; i < pageWords.length; i++) {
        expect(pageWords[i].startMs).toBe(pageWords[i - 1].endMs)
      }
      expect(pageWords[pageWords.length - 1].endMs).toBe(page.endMs)
    }
    expect(flat.length).toBeGreaterThan(2)
  })

  it("treats stored timings as cue-relative regardless of absolute start", () => {
    const stored = [
      { text: "ONE", startMs: 100, endMs: 500 },
      { text: "TWO", startMs: 600, endMs: 1_000 },
    ]
    const layout = resolveCaptionLayout({
      text: "one two",
      startMs: 5_000,
      endMs: 6_000,
      words: stored,
      design,
      canvas,
    })
    const flat = layout.pages[0].lines[0].words
    expect(flat[0].startMs).toBe(5_100)
    expect(flat[0].endMs).toBe(5_500)
  })
})

describe("resolveCaptionLayout — placement", () => {
  const text = "one two three four five six seven eight nine ten eleven twelve"

  const outerBottom = (layout: ReturnType<typeof layoutFor>, pageIndex: number) => {
    const page = layout.pages[pageIndex]
    const pad = (layout.chip?.padYPx ?? 0) + (layout.outline?.widthPx ?? 0)
    return page.block.centerY + page.block.height / 2 + pad
  }
  const outerTop = (layout: ReturnType<typeof layoutFor>, pageIndex: number) => {
    const page = layout.pages[pageIndex]
    const pad = (layout.chip?.padYPx ?? 0) + (layout.outline?.widthPx ?? 0)
    return page.block.centerY - page.block.height / 2 - pad
  }

  it("places bottom/center/top correctly", () => {
    const bottom = layoutFor({ text })
    expect(bottom.pages[0].block.centerX).toBe(960)
    expect(bottom.pages[0].block.centerY).toBeGreaterThan(1080 * 0.5)
    const center = layoutFor({ text, design: { ...DEFAULT_CAPTION_DESIGN, placement: "center" } })
    expect(Math.abs(center.pages[0].block.centerY - 540)).toBeLessThan(30)
    const top = layoutFor({ text, design: { ...DEFAULT_CAPTION_DESIGN, placement: "top" } })
    expect(top.pages[0].block.centerY).toBeLessThan(1080 * 0.4)
  })

  it("offsetY shifts the block by a height fraction", () => {
    // Center placement has headroom both ways — no clamping for ±0.1.
    const base = layoutFor({
      text: "hello",
      design: { ...DEFAULT_CAPTION_DESIGN, placement: "center" },
    })
    const shifted = layoutFor({
      text: "hello",
      design: { ...DEFAULT_CAPTION_DESIGN, placement: "center", offsetY: 0.1 },
    })
    expect(shifted.pages[0].block.centerY - base.pages[0].block.centerY).toBeCloseTo(108, 0)
  })

  it("clamps the outer box into [2%, 98%] of the canvas", () => {
    const clamped = layoutFor({
      text,
      design: { ...DEFAULT_CAPTION_DESIGN, offsetY: 0.4 },
    })
    expect(outerBottom(clamped, 0)).toBeLessThanOrEqual(0.98 * 1080 + 0.01)
    expect(outerTop(clamped, 0)).toBeGreaterThanOrEqual(0.02 * 1080)
  })

  it("keeps the bottom anchor stable across pages with different line counts", () => {
    // A long cue paginates into pages of 2/1 lines — the outer bottom edge
    // must not move between them (bottom placement grows upward).
    const longCue = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ")
    const layout = layoutFor({
      text: longCue,
      endMs: 20_000,
      canvas: { width: 1080, height: 1920, aspectRatio: "9:16" },
    })
    expect(layout.pages.length).toBeGreaterThan(1)
    const lineCounts = layout.pages.map((p) => p.lines.length)
    expect(new Set(lineCounts).size).toBeGreaterThan(1)
    const bottoms = layout.pages.map((_, i) => outerBottom(layout, i))
    for (const b of bottoms) expect(b).toBeCloseTo(bottoms[0], 1)

    // Top placement grows downward: outer TOP edge stays fixed instead.
    const topLayout = layoutFor({
      text: longCue,
      endMs: 20_000,
      canvas: { width: 1080, height: 1920, aspectRatio: "9:16" },
      design: { ...DEFAULT_CAPTION_DESIGN, placement: "top" },
    })
    const tops = topLayout.pages.map((_, i) => outerTop(topLayout, i))
    for (const t of tops) expect(t).toBeCloseTo(tops[0], 1)

    // Center placement keeps the block center fixed.
    const centerLayout = layoutFor({
      text: longCue,
      endMs: 20_000,
      canvas: { width: 1080, height: 1920, aspectRatio: "9:16" },
      design: { ...DEFAULT_CAPTION_DESIGN, placement: "center" },
    })
    const centers = centerLayout.pages.map((page) => page.block.centerY)
    for (const c of centers) expect(c).toBeCloseTo(centers[0], 1)
  })
})

describe("resolveCaptionLayout — oversized tokens + shared budget", () => {
  const url = "https://example.com/tutorials/recordforge/quick-start-guide/step-01"

  it("keeps a 70-char URL inside the line budget at 16:9 and 9:16", () => {
    for (const canvas of [
      { width: 1920, height: 1080, aspectRatio: "16:9" as const },
      { width: 1080, height: 1920, aspectRatio: "9:16" as const },
    ]) {
      const layout = resolveCaptionLayout({
        text: `open ${url} now`,
        startMs: 0,
        endMs: 4_000,
        design: { ...DEFAULT_CAPTION_DESIGN },
        canvas,
      })
      const maxTextWidthPx = captionTextBudget(canvas, {
        ...DEFAULT_CAPTION_DESIGN,
      }).maxTextWidthPx
      for (const page of layout.pages) {
        for (const line of page.lines) {
          const measured =
            measureCaptionTextEm(line.text, layout.fontWeight) * layout.fontPx +
            layout.letterSpacingPx * [...line.text].length
          expect(measured, `line "${line.text}"`).toBeLessThanOrEqual(maxTextWidthPx + 2)
        }
      }
      // Fragments re-join without spaces — the URL survives verbatim (the
      // line-boundary space in the join is a test artifact of `join(" ")`).
      const joined = layout.pages.map((p) => p.lines.map((l) => l.text).join(" ")).join(" ")
      expect(joined.replace(/ /g, "")).toBe(`open ${url} now`.replace(/ /g, ""))
    }
  })

  it("captionTextBudget returns exactly the numbers the layout uses", () => {
    const design = { ...DEFAULT_CAPTION_DESIGN, preset: "highlight" as const, sizeScale: 1.2 }
    const canvas = { width: 2560, height: 1440, aspectRatio: "16:9" as const }
    const budget = captionTextBudget(canvas, design)
    const layout = resolveCaptionLayout({
      text: "hello world",
      startMs: 0,
      endMs: 2_000,
      design,
      canvas,
    })
    expect(layout.fontPx).toBe(budget.fontPx)
    expect(layout.fontWeight).toBe(budget.fontWeight)
    expect(budget.maxLines).toBe(2)
    expect(budget.highlight).toBe(false)
    const popBudget = captionTextBudget(canvas, { ...DEFAULT_CAPTION_DESIGN, preset: "pop" })
    expect(popBudget.uppercase).toBe(true)
    expect(popBudget.highlight).toBe(true)
  })
})

describe("caption page continuity and animation", () => {
  const pages = [
    {
      startMs: 0,
      endMs: 1_000,
      animateIn: true,
      animateOut: true,
      lines: [],
      block: { centerX: 0, centerY: 0, height: 0 },
    },
    {
      startMs: 1_100,
      endMs: 2_000,
      animateIn: true,
      animateOut: true,
      lines: [],
      block: { centerX: 0, centerY: 0, height: 0 },
    },
    {
      startMs: 2_500,
      endMs: 3_000,
      animateIn: true,
      animateOut: true,
      lines: [],
      block: { centerX: 0, centerY: 0, height: 0 },
    },
  ]

  it("merges animations across gaps ≤ 120ms only", () => {
    const adjusted = applyCaptionContinuity(pages)
    // Gap 1_000→1_100 is 100ms ≤ 120: merged.
    expect(adjusted[0].animateOut).toBe(false)
    expect(adjusted[1].animateIn).toBe(false)
    // Gap 2_000→2_500 is 500ms: not merged.
    expect(adjusted[1].animateOut).toBe(true)
    expect(adjusted[2].animateIn).toBe(true)
    // Input objects are not mutated.
    expect(pages[0].animateOut).toBe(true)
  })

  it("activeCaptionPage is start-inclusive, end-exclusive", () => {
    const layout = layoutFor({ text: "one two", endMs: 1_000 })
    const page = layout.pages[0]
    expect(activeCaptionPage(layout, 0)).toBe(page)
    expect(activeCaptionPage(layout, 999)).toBe(page)
    expect(activeCaptionPage(layout, 1_000)).toBeNull()
    expect(activeCaptionPage(layout, -1)).toBeNull()
  })

  it("captionAnimationState covers in/mid/out/after phases", () => {
    // default look: in 140ms, out 100ms, fromScale 0.96; single page 0..2000.
    const layout = layoutFor({ text: "one two", endMs: 2_000 })
    const page = layout.pages[0]

    const at0 = captionAnimationState(layout, page, 0)
    expect(at0.opacity).toBeCloseTo(0, 1)
    expect(at0.scale).toBeCloseTo(0.96, 2)

    const atIn = captionAnimationState(layout, page, 70)
    expect(atIn.opacity).toBeGreaterThan(0)
    expect(atIn.opacity).toBeLessThan(1)
    expect(atIn.scale).toBeGreaterThan(0.96)
    expect(atIn.scale).toBeLessThan(1)

    const atMid = captionAnimationState(layout, page, 1_000)
    expect(atMid).toEqual({ opacity: 1, scale: 1 })

    const atOut = captionAnimationState(layout, page, 1_950)
    expect(atOut.opacity).toBeLessThan(1)
    expect(atOut.opacity).toBeGreaterThan(0)
    expect(atOut.scale).toBe(1)

    const after = captionAnimationState(layout, page, 2_000)
    expect(after).toEqual({ opacity: 0, scale: 1 })
  })

  it("interior pages are hard swaps — no fade despite animation config", () => {
    const text = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ")
    const layout = layoutFor({
      text,
      endMs: 30_000,
      canvas: { width: 1080, height: 1920, aspectRatio: "9:16" },
    })
    expect(layout.pages.length).toBeGreaterThan(1)
    const interior = layout.pages[1]
    const state = captionAnimationState(layout, interior, interior.startMs + 5)
    expect(state).toEqual({ opacity: 1, scale: 1 })
  })
})

describe("design resolution", () => {
  const captionClip: CaptionClip = {
    id: "c1",
    kind: "caption",
    assetId: "a1",
    startMs: 0,
    durationMs: 1_000,
    sourceInMs: 0,
    sourceOutMs: 1_000,
    speed: 1,
    text: "hello",
    style: "boxed",
    placement: "top",
  }
  const track = (overrides: Partial<TimelineTrack>): TimelineTrack =>
    ({
      id: "t",
      kind: "captions",
      name: "Captions",
      muted: false,
      locked: false,
      solo: false,
      volume: 1,
      clips: [captionClip],
      ...overrides,
    }) as TimelineTrack

  it("returns defaults for a missing track", () => {
    expect(resolveCaptionDesign(undefined)).toEqual(DEFAULT_CAPTION_DESIGN)
  })

  it("legacy fallback reads the first caption clip", () => {
    const design = resolveCaptionDesign(track({}))
    expect(design.preset).toBe("boxed")
    expect(design.placement).toBe("top")
  })

  it("track captionDesign wins over clip fallback", () => {
    const design = resolveCaptionDesign(
      track({ captionDesign: { preset: "pop", sizeScale: 1, placement: "bottom", offsetY: 0 } }),
    )
    expect(design.preset).toBe("pop")
    expect(design.placement).toBe("bottom")
  })

  it("clip style overrides the track design, 'default' inherits", () => {
    const t = track({
      captionDesign: { preset: "focus", sizeScale: 1, placement: "center", offsetY: 0 },
    })
    const overridden = resolveClipDesign(t, { ...captionClip, style: "minimal" })
    expect(overridden.preset).toBe("minimal")
    expect(overridden.placement).toBe("top") // clip.placement wins too
    const inherited = resolveClipDesign(t, {
      ...captionClip,
      style: "default",
      placement: undefined,
    })
    expect(inherited.preset).toBe("focus")
    expect(inherited.placement).toBe("center")
  })

  it("legacy tracks keep the clip style authoritative, including 'default'", () => {
    // No captionDesign: clip2's literal "default" must not inherit clip1's
    // "boxed" — pre-design projects render exactly what their clips say.
    const t = track({})
    const defaultClip = resolveClipDesign(t, { ...captionClip, style: "default" })
    expect(defaultClip.preset).toBe("default")
    const boxedClip = resolveClipDesign(t, { ...captionClip, style: "boxed" })
    expect(boxedClip.preset).toBe("boxed")
  })
})
