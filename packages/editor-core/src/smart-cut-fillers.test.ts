import { describe, expect, it } from "vitest"
import {
  MIN_FILLER_RANGE_MS,
  detectFillerWords,
  fillerRemovedMs,
  mergeFillerCandidates,
  normalizeFillerWord,
  type FillerWord,
} from "./smart-cut-fillers"

/** Build timeline words sequentially: each entry is [text, durationMs]. */
function words(...entries: Array<[string, number]>): FillerWord[] {
  let cursor = 1_000
  return entries.map(([text, duration]) => {
    const word = { text, startMs: cursor, endMs: cursor + duration }
    cursor += duration + 20
    return word
  })
}

describe("normalizeFillerWord", () => {
  it("lowercases, strips accents and punctuation", () => {
    expect(normalizeFillerWord("Äh,")).toBe("ah")
    expect(normalizeFillerWord("You know?")).toBe("youknow")
    expect(normalizeFillerWord("—")).toBe("")
  })
})

describe("detectFillerWords", () => {
  it("finds strict English disfluencies with padding", () => {
    const input = words(["so", 200], ["um", 180], ["the", 160], ["build", 240])
    const candidates = detectFillerWords(input, {
      language: "en",
      paddingMs: 30,
      mergeSilenceMs: 0,
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ text: "um", kind: "strict", wordIndex: 1 })
    expect(candidates[0]!.startMs).toBe(input[1]!.startMs - 30)
    expect(candidates[0]!.endMs).toBe(input[1]!.endMs + 30)
    // Context shows the neighbouring words, not the whole sentence.
    expect(candidates[0]!.context).toContain("so")
    expect(candidates[0]!.context).toContain("the")
  })

  it("keeps phrases and repeats opt-in", () => {
    const input = words(
      ["it", 150],
      ["is", 120],
      ["like", 180],
      ["you", 140],
      ["know", 140],
      ["done", 200],
    )
    expect(detectFillerWords(input, { language: "en" })).toHaveLength(0)

    const phrases = detectFillerWords(input, {
      language: "en",
      includePhrases: true,
      mergeSilenceMs: 0,
    })
    expect(phrases.map((candidate) => candidate.text)).toEqual(["like", "you know"])
    expect(phrases[1]).toMatchObject({ kind: "phrase", wordIndex: 3 })
  })

  it("removes the repeated word rather than the first one", () => {
    const input = words(["I", 120], ["I", 120], ["think", 200])
    const candidates = detectFillerWords(input, {
      language: "en",
      includeRepeats: true,
      mergeSilenceMs: 0,
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ kind: "repeat", wordIndex: 1 })
  })

  it("ignores repeats separated by a pause", () => {
    const input: FillerWord[] = [
      { text: "no", startMs: 1_000, endMs: 1_120 },
      { text: "no", startMs: 1_400, endMs: 1_520 },
    ]
    expect(detectFillerWords(input, { language: "en", includeRepeats: true })).toHaveLength(0)
  })

  it("supports the other bundled languages", () => {
    const french = detectFillerWords(words(["euh", 200], ["oui", 200]), { language: "fr" })
    expect(french.map((candidate) => candidate.text)).toEqual(["euh"])

    const german = detectFillerWords(words(["ähm", 220], ["ja", 180]), { language: "de" })
    expect(german.map((candidate) => candidate.text)).toEqual(["ähm"])

    const spanish = detectFillerWords(words(["este", 240], ["sí", 180]), { language: "es" })
    expect(spanish.map((candidate) => candidate.text)).toEqual(["este"])
  })

  it("absorbs adjacent silence so the splice lands in the pause", () => {
    const input = words(["um", 160], ["next", 200])
    const silence = [{ startMs: input[0]!.endMs, endMs: input[0]!.endMs + 180 }]
    const candidates = detectFillerWords(
      input,
      { language: "en", paddingMs: 0, mergeSilenceMs: 220 },
      silence,
    )
    expect(candidates[0]!.endMs).toBe(silence[0]!.endMs)
  })

  it("drops candidates too short to be worth a splice", () => {
    const input: FillerWord[] = [{ text: "um", startMs: 1_000, endMs: 1_010 }]
    expect(detectFillerWords(input, { language: "en", paddingMs: 0 })).toHaveLength(0)
  })

  it("snaps range edges to the frame grid", () => {
    const input: FillerWord[] = [{ text: "uh", startMs: 1_001, endMs: 1_161 }]
    const [candidate] = detectFillerWords(input, {
      language: "en",
      paddingMs: 0,
      fps: 30,
    })
    const frames = (ms: number) => (ms * 30) / 1000
    expect(
      Math.abs(frames(candidate!.startMs) - Math.round(frames(candidate!.startMs))),
    ).toBeLessThan(0.02)
    expect(Math.abs(frames(candidate!.endMs) - Math.round(frames(candidate!.endMs)))).toBeLessThan(
      0.02,
    )
  })
})

describe("mergeFillerCandidates", () => {
  it("merges touching and overlapping candidates", () => {
    const ranges = mergeFillerCandidates([
      { id: "a", startMs: 100, endMs: 300, text: "um", context: "", kind: "strict", wordIndex: 0 },
      { id: "b", startMs: 290, endMs: 420, text: "uh", context: "", kind: "strict", wordIndex: 1 },
      {
        id: "c",
        startMs: 900,
        endMs: 1_000,
        text: "like",
        context: "",
        kind: "phrase",
        wordIndex: 4,
      },
    ])
    expect(ranges).toEqual([
      { startMs: 100, endMs: 420 },
      { startMs: 900, endMs: 1_000 },
    ])
  })

  it("reports the removed duration of the merged ranges", () => {
    const removed = fillerRemovedMs([
      { id: "a", startMs: 100, endMs: 300, text: "um", context: "", kind: "strict", wordIndex: 0 },
      { id: "b", startMs: 300, endMs: 400, text: "uh", context: "", kind: "strict", wordIndex: 1 },
    ])
    expect(removed).toBe(300)
  })

  it("keeps the minimum range floor at a sensible value", () => {
    expect(MIN_FILLER_RANGE_MS).toBe(60)
  })
})
