import { describe, expect, it } from "vitest"
import {
  adoptUserScroll,
  advanceScrollPosition,
  clamp,
  countWords,
  estimateReadSeconds,
  estimateRemainingSeconds,
  formatClock,
  MAX_FRAME_DELTA_MS,
  pxPerSecondFromWpm,
} from "./teleprompter-math"

describe("clamp", () => {
  it("bounds values", () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
  })
})

describe("countWords", () => {
  it("counts words and ignores punctuation", () => {
    expect(countWords("")).toBe(0)
    expect(countWords("   \n\t  ")).toBe(0)
    expect(countWords("!?, —")).toBe(0)
    expect(countWords("Hello, world — 3.14")).toBe(3)
    expect(countWords("one two\nthree  four")).toBe(4)
  })

  it("counts CJK text by segments, not spaces", () => {
    expect(countWords("今天天气很好我们去公园散步")).toBeGreaterThan(1)
  })
})

describe("pxPerSecondFromWpm", () => {
  it("converts a speaking rate into px/s for the layout", () => {
    // (120 wpm / 60) * (3000 px / 300 words) = 20 px/s
    expect(pxPerSecondFromWpm({ wpm: 120, wordCount: 300, textHeight: 3000 })).toBe(20)
  })

  it("returns 0 for degenerate input", () => {
    expect(pxPerSecondFromWpm({ wpm: 120, wordCount: 0, textHeight: 3000 })).toBe(0)
    expect(pxPerSecondFromWpm({ wpm: 120, wordCount: 300, textHeight: 0 })).toBe(0)
    expect(pxPerSecondFromWpm({ wpm: 120, wordCount: 300, textHeight: -5 })).toBe(0)
    expect(pxPerSecondFromWpm({ wpm: Number.NaN, wordCount: 300, textHeight: 3000 })).toBe(0)
    expect(
      pxPerSecondFromWpm({ wpm: 120, wordCount: Number.POSITIVE_INFINITY, textHeight: 3000 }),
    ).toBe(0)
  })
})

describe("advanceScrollPosition", () => {
  it("advances by px/s * dt", () => {
    const result = advanceScrollPosition({
      position: 0,
      pxPerSecond: 100,
      deltaMs: 16,
      maxScroll: 1000,
    })
    expect(result.position).toBeCloseTo(1.6)
    expect(result.reachedEnd).toBe(false)
  })

  it("clamps deltaMs so hidden-window stalls never jump", () => {
    const clamped = advanceScrollPosition({
      position: 0,
      pxPerSecond: 100,
      deltaMs: 5000,
      maxScroll: 1000,
    })
    expect(clamped.position).toBeCloseTo(100 * (MAX_FRAME_DELTA_MS / 1000))
  })

  it("clamps position into [0, maxScroll]", () => {
    expect(
      advanceScrollPosition({ position: 995, pxPerSecond: 100, deltaMs: 100, maxScroll: 1000 })
        .position,
    ).toBe(1000)
    expect(
      advanceScrollPosition({ position: -50, pxPerSecond: 0, deltaMs: 16, maxScroll: 1000 })
        .position,
    ).toBe(0)
  })

  it("detects the end within the epsilon", () => {
    const result = advanceScrollPosition({
      position: 999.5,
      pxPerSecond: 0,
      deltaMs: 16,
      maxScroll: 1000,
    })
    expect(result.reachedEnd).toBe(true)
    expect(
      advanceScrollPosition({ position: 990, pxPerSecond: 0, deltaMs: 16, maxScroll: 1000 })
        .reachedEnd,
    ).toBe(false)
  })

  it("treats a non-scrollable range as already at the end", () => {
    expect(
      advanceScrollPosition({ position: 0, pxPerSecond: 100, deltaMs: 16, maxScroll: 0 }),
    ).toEqual({ position: 0, reachedEnd: true })
    expect(
      advanceScrollPosition({ position: 0, pxPerSecond: 100, deltaMs: 16, maxScroll: -10 })
        .reachedEnd,
    ).toBe(true)
  })

  it("stands still at zero speed without ending early", () => {
    const result = advanceScrollPosition({
      position: 10,
      pxPerSecond: 0,
      deltaMs: 16,
      maxScroll: 1000,
    })
    expect(result.position).toBe(10)
    expect(result.reachedEnd).toBe(false)
  })
})

describe("adoptUserScroll", () => {
  it("adopts real user scrolls beyond the quantization threshold", () => {
    expect(adoptUserScroll({ position: 100, lastTop: 100, currentTop: 400 })).toBe(400)
    expect(adoptUserScroll({ position: 100, lastTop: 100, currentTop: 98.5 })).toBe(98.5)
  })

  it("ignores our own sub-pixel writes", () => {
    expect(adoptUserScroll({ position: 100.6, lastTop: 100, currentTop: 100 })).toBe(100.6)
    expect(adoptUserScroll({ position: 100.6, lastTop: 100, currentTop: 101 })).toBe(100.6)
  })
})

describe("estimateRemainingSeconds", () => {
  it("computes remaining time", () => {
    expect(estimateRemainingSeconds({ position: 0, maxScroll: 1000, pxPerSecond: 100 })).toBe(10)
    expect(estimateRemainingSeconds({ position: 500, maxScroll: 1000, pxPerSecond: 100 })).toBe(5)
  })

  it("returns 0 at the end or without speed", () => {
    expect(estimateRemainingSeconds({ position: 1000, maxScroll: 1000, pxPerSecond: 100 })).toBe(0)
    expect(estimateRemainingSeconds({ position: 0, maxScroll: 1000, pxPerSecond: 0 })).toBe(0)
  })
})

describe("estimateReadSeconds", () => {
  it("estimates script duration from wpm", () => {
    expect(estimateReadSeconds({ wordCount: 140, wpm: 140 })).toBe(60)
    expect(estimateReadSeconds({ wordCount: 0, wpm: 140 })).toBe(0)
    expect(estimateReadSeconds({ wordCount: 100, wpm: 0 })).toBe(0)
  })
})

describe("formatClock", () => {
  it("formats m:ss under an hour and h:mm:ss beyond", () => {
    expect(formatClock(0)).toBe("0:00")
    expect(formatClock(59.6)).toBe("1:00")
    expect(formatClock(61)).toBe("1:01")
    expect(formatClock(3599)).toBe("59:59")
    expect(formatClock(3600)).toBe("1:00:00")
  })

  it("handles invalid input", () => {
    expect(formatClock(Number.NaN)).toBe("0:00")
    expect(formatClock(-5)).toBe("0:00")
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe("0:00")
  })
})
