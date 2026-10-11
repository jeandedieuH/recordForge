import { describe, expect, it } from "vitest"
import { avgCharEm, measureCaptionTextEm, type CaptionFontWeight } from "./inter-metrics"

// HarfBuzz-shaped widths (em, kern+liga enabled) measured offline against the
// vendored static Inter instances — the estimator must stay within ±2.5%.
const SAMPLES: string[] = [
  "Welcome to Record Forge, the easiest way to record your screen.",
  "In 2026, we shipped 42 new features.",
  "Did you know that captions improve watch-time by 35 percent?",
  "Pause here for a moment. Then the video continues.",
  "Hello, world! The quick brown fox jumps over the lazy dog.",
  "Pack my box with five dozen liquor jugs.",
  "How vexingly quick daft zebras jump!",
  "Amazingly few discotheques provide jukeboxes.",
  "The fifth boxing wizards jump quickly.",
  "Twelve ziggurats quickly jumped a finch box.",
  "Recording your screen has never been simpler or faster than this.",
  "Every frame matters; every word counts. 100% accurate timing.",
  "Welcome",
  "transcription",
  "UPPERCASE SHORT",
]
const SHAPED: Record<CaptionFontWeight, number[]> = {
  600: [
    31.39258, 18.17139, 30.49805, 25.1665, 28.23975, 19.3623, 18.0498, 23.36035, 18.35254, 21.76025,
    31.49219, 30.75586, 4.50586, 6.18311, 9.69775,
  ],
  700: [
    31.65088, 18.33691, 30.80859, 25.39062, 28.49365, 19.53955, 18.24219, 23.66113, 18.58105,
    22.00684, 31.81055, 31.11768, 4.56445, 6.29736, 9.73145,
  ],
  800: [
    31.96387, 18.53955, 31.1875, 25.6665, 28.81299, 19.76221, 18.479, 24.02979, 18.86523, 22.31055,
    32.20361, 31.55859, 4.63525, 6.43701, 9.77295,
  ],
}

describe("Inter advance-width estimator", () => {
  it("tracks HarfBuzz-shaped widths within ±2.5%", () => {
    for (const weight of [600, 700, 800] as const) {
      for (const [i, text] of SAMPLES.entries()) {
        const expected = SHAPED[weight][i]
        const measured = measureCaptionTextEm(text, weight)
        const error = Math.abs(measured - expected) / expected
        expect(error, `"${text}" at w${weight}`).toBeLessThanOrEqual(0.025)
      }
    }
  })

  it("orders weights: heavier is wider", () => {
    expect(measureCaptionTextEm("captions", 800)).toBeGreaterThan(
      measureCaptionTextEm("captions", 700),
    )
    expect(measureCaptionTextEm("captions", 700)).toBeGreaterThan(
      measureCaptionTextEm("captions", 600),
    )
  })

  it("falls back by script class for non-ASCII", () => {
    // Accented Latin measures like the base letter.
    expect(measureCaptionTextEm("é", 700)).toBeCloseTo(measureCaptionTextEm("e", 700), 5)
    // CJK chars are full-width.
    expect(measureCaptionTextEm("世", 700)).toBeCloseTo(1, 5)
    expect(measureCaptionTextEm("世", 800)).toBeCloseTo(1, 5)
    // Emoji run slightly wide.
    expect(measureCaptionTextEm("🔥", 700)).toBeCloseTo(1.15, 5)
  })

  it("avgCharEm stays in a sane Latin-prose band", () => {
    for (const weight of [600, 700, 800] as const) {
      expect(avgCharEm(weight)).toBeGreaterThan(0.45)
      expect(avgCharEm(weight)).toBeLessThan(0.7)
    }
  })
})
