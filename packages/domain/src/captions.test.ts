import { describe, expect, it } from "vitest"
import { parseCaptionText } from "./captions"

describe("caption parser", () => {
  it("normalizes SRT timestamps and ignores cue indexes", () => {
    const result = parseCaptionText(
      "1\n00:00:01,250 --> 00:00:03,500\nHello\n\n2\n00:00:04,000 --> 00:00:05,250\nWorld",
      "srt",
    )

    expect(result).toEqual({
      ok: true,
      value: {
        format: "srt",
        cues: [
          { id: "cue-1", startMs: 1_250, endMs: 3_500, text: "Hello" },
          { id: "cue-2", startMs: 4_000, endMs: 5_250, text: "World" },
        ],
      },
    })
  })

  it("accepts VTT headers, cue identifiers, and millisecond timestamps", () => {
    const result = parseCaptionText(
      "WEBVTT\n\nintro\n00:01.500 --> 00:03.000 align:center\nWelcome\n\n00:04.000 --> 00:05.000\nRecordForge",
      "vtt",
    )

    expect(result).toMatchObject({
      ok: true,
      value: {
        format: "vtt",
        cues: [
          { id: "intro", startMs: 1_500, endMs: 3_000, text: "Welcome" },
          { id: "cue-2", startMs: 4_000, endMs: 5_000, text: "RecordForge" },
        ],
      },
    })
  })

  it("reports malformed timing without exposing caption text", () => {
    const result = parseCaptionText("1\n00:00:03,000 --> 00:00:01,000\nSensitive UI text", "srt")

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("invalid_caption_file")
    expect(result.error.message).toContain("timing")
    expect(JSON.stringify(result.error)).not.toContain("Sensitive UI text")
  })

  it("rejects overlapping cues because one captions track is non-overlapping", () => {
    const result = parseCaptionText(
      "00:00:01.000 --> 00:00:03.000\nFirst\n\n00:00:02.000 --> 00:00:04.000\nSecond",
      "vtt",
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain("overlap")
  })
})
