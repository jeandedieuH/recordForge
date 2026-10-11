import { describe, expect, it } from "vitest"
import {
  balanceLines,
  captionWords,
  joinCaptionWords,
  normalizeCueText,
  paginateWords,
  reflowCueText,
  sliceCaptionText,
  splitCaptionText,
  splitOversized,
} from "./caption-text"

const uniformWidth = (text: string) => [...text].length // 1px per char — easy math

describe("normalizeCueText", () => {
  it("unifies newlines, strips controls, collapses whitespace", () => {
    expect(normalizeCueText("  a   b\r\nc\r d\t e ")).toBe("a b\nc\nd e")
    expect(normalizeCueText("abc")).toBe("abc")
  })
})

describe("reflowCueText", () => {
  it("joins wrapped lines with spaces", () => {
    expect(reflowCueText("hello\nworld")).toBe("hello world")
  })

  it("keeps dialogue-dash line breaks", () => {
    expect(reflowCueText("- first\n- second")).toBe("- first\n- second")
    expect(reflowCueText("– first\n— second")).toBe("– first\n— second")
  })

  it("reflows when only some lines are dialogue dashes", () => {
    expect(reflowCueText("- first\nplain")).toBe("- first plain")
  })
})

describe("captionWords", () => {
  it("splits on whitespace with spaceBefore", () => {
    expect(captionWords("hello  world")).toEqual([
      { text: "hello", spaceBefore: false },
      { text: "world", spaceBefore: true },
    ])
  })

  it("breaks spaceless scripts per char and keeps closing punctuation", () => {
    expect(captionWords("こんにちは、世界")).toEqual([
      { text: "こ", spaceBefore: false },
      { text: "ん", spaceBefore: false },
      { text: "に", spaceBefore: false },
      { text: "ち", spaceBefore: false },
      { text: "は、", spaceBefore: false },
      { text: "世", spaceBefore: false },
      { text: "界", spaceBefore: false },
    ])
  })

  it("handles mixed Latin/CJK chunks", () => {
    const words = captionWords("abc世界def")
    expect(words.map((w) => w.text)).toEqual(["abc", "世", "界", "def"])
  })
})

describe("splitCaptionText", () => {
  it("splits near the ratio at a word boundary", () => {
    const [left, right] = splitCaptionText("one two three four", 0.5)
    expect(left).toBe("one two")
    expect(right).toBe("three four")
  })

  it("prefers a boundary after clause punctuation", () => {
    // Boundaries sit at chars 10 (after the comma, within ±15% of ideal) and
    // 12 — the punctuation boundary wins over the marginally nearer plain one.
    const [left, right] = splitCaptionText("wwwwwwwww, w wwwwwww", 0.575)
    expect(left).toBe("wwwwwwwww,")
    expect(right).toBe("w wwwwwww")
    // Outside the ±15% window the plain nearest boundary is used.
    const [farLeft, farRight] = splitCaptionText("one two three, four five six", 0.25)
    expect(farLeft).toBe("one two")
    expect(farRight).toBe("three, four five six")
  })

  it("single-word text returns [text, text]", () => {
    expect(splitCaptionText("hello", 0.5)).toEqual(["hello", "hello"])
  })
})

describe("sliceCaptionText", () => {
  it("slices at word boundaries only", () => {
    const text = "one two three four five"
    expect(sliceCaptionText(text, 0, 0.5)).toBe("one two three")
    expect(sliceCaptionText(text, 0.5, 1)).toBe("four five")
  })

  it("returns empty string for an empty range", () => {
    expect(sliceCaptionText("one two", 0.5, 0.5)).toBe("")
  })
})

describe("balanceLines", () => {
  const words = captionWords("one two three four five six")

  it("never exceeds the width budget", () => {
    const lines = balanceLines(words, uniformWidth, 11, 3)
    for (const line of lines) {
      const width = line.reduce((sum, w) => sum + w.text.length, 0) + line.length - 1
      expect(width).toBeLessThanOrEqual(11)
    }
  })

  it("produces the minimal line count, balanced", () => {
    // Total folded width 27px: a 14px cap needs exactly 2 lines, balanced to
    // [one two three][four five six] rather than leaving a runt.
    const lines = balanceLines(words, uniformWidth, 14, 3)
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      const width = line.reduce((sum, w) => sum + w.text.length, 0) + line.length - 1
      expect(width).toBeLessThanOrEqual(14)
    }
    // When the line cap is impossible the greedy overflow comes back so the
    // caller can paginate instead of overflowing the width.
    const overflow = balanceLines(words, uniformWidth, 12, 1)
    expect(overflow.length).toBeGreaterThan(1)
  })
})

describe("paginateWords", () => {
  it("paginates over maxLines and prefers punctuation page breaks", () => {
    const words = captionWords("first sentence here. second part follows now. third tail.")
    const pages = paginateWords(words, uniformWidth, 20, 1)
    expect(pages.length).toBeGreaterThan(1)
    // Joined page text round-trips to the normalized original.
    const joined = pages.map((p) => p.map((l) => joinCaptionWords(l)).join(" ")).join(" ")
    expect(joined).toBe("first sentence here. second part follows now. third tail.")
  })

  it("hard-splits a word wider than the line", () => {
    const pages = paginateWords(captionWords("supercalifragilistic"), uniformWidth, 5, 2)
    const text = pages
      .flat(2)
      .map((w) => w.text)
      .join("")
    expect(text).toBe("supercalifragilistic")
  })
})

describe("splitOversized", () => {
  it("prefers breaking after URL/path hint characters", () => {
    const [word] = captionWords("https://example.com/tutorials")
    const pieces = splitOversized([word], uniformWidth, 8)
    expect(pieces.length).toBeGreaterThan(1)
    // Every piece fits; break positions land right after hint chars.
    for (const piece of pieces) expect(piece.text.length).toBeLessThanOrEqual(8)
    expect(pieces.map((p) => p.text).join("")).toBe("https://example.com/tutorials")
    // Only the first fragment keeps the word's space flag.
    expect(pieces[0].spaceBefore).toBe(word.spaceBefore)
    expect(pieces.slice(1).every((p) => p.spaceBefore === false)).toBe(true)
    // At least one piece ends on a hint char rather than mid-word.
    expect(pieces.some((p) => /[/\\\-_.?&=#]$/.test(p.text))).toBe(true)
  })

  it("falls back to a character split when no hint exists", () => {
    const [word] = captionWords("abcdefghijklmnop")
    const pieces = splitOversized([word], uniformWidth, 5)
    expect(pieces.map((p) => p.text).join("")).toBe("abcdefghijklmnop")
    expect(pieces.every((p) => p.text.length <= 5)).toBe(true)
  })
})
