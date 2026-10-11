import { describe, expect, it } from "vitest"
import {
  AI_CAPTIONS_PROGRESS_EVENT,
  aiCaptionsProgressSchema,
  aiCaptionsStatusSchema,
  captionCueSchema,
  captionDesignSchema,
  captionStylePresetSchema,
  captionWordTimingSchema,
  DEFAULT_CAPTION_DESIGN,
  transcribeRequestSchema,
  transcriptSchema,
  transcriptWordSchema,
} from "./captions"

const validWord = {
  text: "Hello",
  startMs: 120,
  endMs: 520,
  spaceBefore: false,
  confidence: 0.92,
}

const validTranscript = {
  language: "en",
  model: "base",
  streamIndex: 1,
  durationMs: 22_060,
  words: [validWord],
  cached: false,
}

describe("transcript contracts", () => {
  it("parses a word-level transcript", () => {
    const parsed = transcriptSchema.parse(validTranscript)
    expect(parsed.language).toBe("en")
    expect(parsed.words[0].text).toBe("Hello")
    expect(parsed.words[0].spaceBefore).toBe(false)
  })

  it("allows a missing word confidence", () => {
    const { confidence: _confidence, ...word } = validWord
    expect(() => transcriptWordSchema.parse(word)).not.toThrow()
  })

  it("rejects empty words and out-of-range confidence", () => {
    expect(() => transcriptWordSchema.parse({ ...validWord, text: "" })).toThrow()
    expect(() => transcriptWordSchema.parse({ ...validWord, confidence: 1.5 })).toThrow()
    expect(() => transcriptWordSchema.parse({ ...validWord, confidence: -0.1 })).toThrow()
  })

  it("rejects malformed transcripts", () => {
    expect(() => transcriptSchema.parse({ ...validTranscript, language: "" })).toThrow()
    expect(() => transcriptSchema.parse({ ...validTranscript, streamIndex: -1 })).toThrow()
    expect(() => transcriptSchema.parse({ ...validTranscript, durationMs: -1 })).toThrow()
    expect(() => transcriptSchema.parse({ ...validTranscript, cached: "yes" })).toThrow()
  })
})

describe("transcribe request contract", () => {
  const base = {
    jobId: "job-1",
    recordingId: "rec-1",
    model: "base",
    language: "auto",
    force: false,
  }

  it("accepts auto and ISO-639 language codes", () => {
    expect(transcribeRequestSchema.parse(base).language).toBe("auto")
    expect(transcribeRequestSchema.parse({ ...base, language: "en" }).language).toBe("en")
    expect(transcribeRequestSchema.parse({ ...base, language: "deu" }).language).toBe("deu")
  })

  it("rejects unvalidated language strings", () => {
    expect(() => transcribeRequestSchema.parse({ ...base, language: "EN" })).toThrow()
    expect(() => transcribeRequestSchema.parse({ ...base, language: "en-US" })).toThrow()
    expect(() => transcribeRequestSchema.parse({ ...base, language: "english" })).toThrow()
    expect(() => transcribeRequestSchema.parse({ ...base, language: "-rf" })).toThrow()
  })

  it("rejects invalid stream indexes and missing fields", () => {
    expect(transcribeRequestSchema.parse({ ...base, streamIndex: 2 }).streamIndex).toBe(2)
    expect(() => transcribeRequestSchema.parse({ ...base, streamIndex: -1 })).toThrow()
    expect(() => transcribeRequestSchema.parse({ ...base, jobId: "" })).toThrow()
    expect(() => transcribeRequestSchema.parse({ ...base, force: "yes" })).toThrow()
  })
})

describe("ai-captions progress contract", () => {
  it("parses progress events for every phase", () => {
    for (const phase of ["preparing", "transcribing", "finalizing"] as const) {
      const parsed = aiCaptionsProgressSchema.parse({ jobId: "j1", phase, percent: 42 })
      expect(parsed.phase).toBe(phase)
    }
    expect(AI_CAPTIONS_PROGRESS_EVENT).toBe("ai-captions-progress")
  })

  it("rejects bad phases and percents", () => {
    expect(() =>
      aiCaptionsProgressSchema.parse({ jobId: "j1", phase: "done", percent: 50 }),
    ).toThrow()
    expect(() =>
      aiCaptionsProgressSchema.parse({ jobId: "j1", phase: "transcribing", percent: 101 }),
    ).toThrow()
    expect(() =>
      aiCaptionsProgressSchema.parse({ jobId: "j1", phase: "transcribing", percent: -1 }),
    ).toThrow()
  })
})

describe("caption design contract", () => {
  it("accepts all six preset ids including the four legacy ones", () => {
    for (const id of ["default", "minimal", "boxed", "highlight", "pop", "focus"]) {
      expect(captionStylePresetSchema.parse(id)).toBe(id)
    }
    expect(() => captionStylePresetSchema.parse("fancy")).toThrow()
  })

  it("fills design defaults from an empty object", () => {
    expect(captionDesignSchema.parse({})).toEqual(DEFAULT_CAPTION_DESIGN)
  })

  it("keeps explicit overrides and resolves accent casing", () => {
    const design = captionDesignSchema.parse({
      preset: "pop",
      sizeScale: 1.4,
      placement: "top",
      offsetY: -0.1,
      uppercase: false,
      accentColor: "#4ade80",
    })
    expect(design).toMatchObject({
      preset: "pop",
      sizeScale: 1.4,
      placement: "top",
      offsetY: -0.1,
      uppercase: false,
      accentColor: "#4ade80",
    })
  })

  it("rejects invalid design values", () => {
    expect(() => captionDesignSchema.parse({ sizeScale: 0.2 })).toThrow()
    expect(() => captionDesignSchema.parse({ sizeScale: 3 })).toThrow()
    expect(() => captionDesignSchema.parse({ offsetY: 0.6 })).toThrow()
    expect(() => captionDesignSchema.parse({ placement: "left" })).toThrow()
    expect(() => captionDesignSchema.parse({ accentColor: "yellow" })).toThrow()
    expect(() => captionDesignSchema.parse({ accentColor: "#FFF" })).toThrow()
  })
})

describe("caption cue word timings", () => {
  const cue = { id: "c1", startMs: 1_000, endMs: 2_500, text: "one two" }

  it("keeps optional words on a cue and round-trips them", () => {
    const words = [
      { text: "one", startMs: 0, endMs: 700 },
      { text: "two", startMs: 800, endMs: 1_500 },
    ]
    const parsed = captionCueSchema.parse({ ...cue, words })
    expect(parsed.words).toEqual(words)
    expect(JSON.parse(JSON.stringify(parsed)).words).toEqual(words)
  })

  it("leaves words absent when the cue has none", () => {
    expect(captionCueSchema.parse(cue).words).toBeUndefined()
  })

  it("rejects bad word times", () => {
    expect(() =>
      captionCueSchema.parse({
        ...cue,
        words: [{ text: "one", startMs: -1, endMs: 500 }],
      }),
    ).toThrow()
    expect(() =>
      captionCueSchema.parse({
        ...cue,
        words: [{ text: "one", startMs: 0.5, endMs: 500 }],
      }),
    ).toThrow()
    expect(() =>
      captionCueSchema.parse({
        ...cue,
        words: [{ text: "one", startMs: 0, endMs: -5 }],
      }),
    ).toThrow()
    expect(() => captionWordTimingSchema.parse({ text: "", startMs: 0, endMs: 1 })).toThrow()
  })

  it("keeps container-time provenance fields and round-trips them", () => {
    const sourceWords = [
      { text: "one", startMs: 5_000, endMs: 5_400 },
      { text: "two", startMs: 5_500, endMs: 5_800 },
    ]
    const parsed = captionCueSchema.parse({ ...cue, sourceWords, sourceStreamIndex: 2 })
    expect(parsed.sourceWords).toEqual(sourceWords)
    expect(parsed.sourceStreamIndex).toBe(2)
    const roundTripped = captionCueSchema.parse(JSON.parse(JSON.stringify(parsed)))
    expect(roundTripped.sourceWords).toEqual(sourceWords)
    expect(roundTripped.sourceStreamIndex).toBe(2)
    // nullish — explicit null and absent both parse.
    expect(captionCueSchema.parse({ ...cue, sourceStreamIndex: null }).sourceStreamIndex).toBeNull()
    expect(captionCueSchema.parse(cue).sourceWords).toBeUndefined()
  })

  it("rejects bad provenance values", () => {
    expect(() => captionCueSchema.parse({ ...cue, sourceStreamIndex: -1 })).toThrow()
    expect(() => captionCueSchema.parse({ ...cue, sourceStreamIndex: 1.5 })).toThrow()
    expect(() => captionCueSchema.parse({ ...cue, sourceStreamIndex: "1" })).toThrow()
    expect(() =>
      captionCueSchema.parse({
        ...cue,
        sourceWords: [{ text: "one", startMs: 100.5, endMs: 500 }],
      }),
    ).toThrow()
    expect(() =>
      captionCueSchema.parse({
        ...cue,
        sourceWords: [{ text: "one", startMs: -10, endMs: 500 }],
      }),
    ).toThrow()
  })
})

describe("ai-captions status contract", () => {
  it("requires the VAD readiness flag", () => {
    const status = {
      supported: true,
      binaryReady: true,
      models: [{ id: "base", label: "Base", sizeBytes: 100, downloaded: true }],
      ready: true,
      vadReady: true,
    }
    expect(aiCaptionsStatusSchema.parse(status).vadReady).toBe(true)
    const { vadReady: _vadReady, ...withoutVad } = status
    expect(() => aiCaptionsStatusSchema.parse(withoutVad)).toThrow()
  })
})
