import { describe, expect, it } from "vitest"
import type {
  AudioClip,
  CaptionClip,
  TimelineState,
  TimelineTrack,
  TranscriptWord,
} from "@recordforge/contracts"
import { DEFAULT_CAPTION_DESIGN } from "@recordforge/contracts"
import {
  analyzeCaptionCue,
  analyzeCaptionSync,
  applyCueTiming,
  buildCaptionCuesFromTranscript,
  captionSegmentationProfile,
  cleanTranscriptWords,
  collectAudioClipsForStream,
  displayWordTimings,
  listCaptionAudioSources,
  mapTranscriptToTimeline,
  pickDefaultCaptionSource,
  segmentCaptionWords,
  type CaptionSegmentationProfile,
  type TimelineWord,
} from "./caption-transcript"
import { captionWords, reflowCueText } from "./caption-text"

function w(text: string, startMs: number, endMs: number, spaceBefore = true): TimelineWord {
  return { text, startMs, endMs, spaceBefore }
}

function audioClip(overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    id: "ac1",
    kind: "audio",
    assetId: "rec1",
    streamIndex: 1,
    startMs: 0,
    durationMs: 10_000,
    sourceInMs: 0,
    sourceOutMs: 10_000,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    ...overrides,
  } as AudioClip
}

function audioTrack(overrides: Partial<TimelineTrack>): TimelineTrack {
  return {
    id: "at1",
    kind: "audio",
    name: "Audio",
    muted: false,
    locked: false,
    solo: false,
    volume: 1,
    clips: [],
    ...overrides,
  } as TimelineTrack
}

function timelineWith(tracks: TimelineTrack[]): TimelineState {
  return {
    recordingId: "rec1",
    canvas: { width: 1920, height: 1080, aspectRatio: "16:9" },
    tracks,
    durationMs: 60_000,
    effects: [],
    cursorRanges: [],
  } as unknown as TimelineState
}

const PROFILE: CaptionSegmentationProfile = {
  maxCharsPerLine: 30,
  maxLines: 2,
  maxDurationMs: 6_000,
  minDurationMs: 800,
  hardPauseMs: 700,
  softPauseMs: 320,
  leadMs: 60,
  tailMs: 160,
  maxWords: Infinity,
}

describe("listCaptionAudioSources", () => {
  it("groups clips per distinct stream index", () => {
    const timeline = timelineWith([
      audioTrack({
        clips: [
          audioClip({ streamIndex: 1, role: "microphone" }),
          audioClip({ id: "ac2", streamIndex: 2, role: "system_audio" }),
        ],
      }),
    ])
    const sources = listCaptionAudioSources(timeline, "rec1")
    expect(sources.map((s) => s.streamIndex).sort()).toEqual([1, 2])
    expect(sources.find((s) => s.streamIndex === 1)?.role).toBe("microphone")
    expect(sources.every((s) => s.muted === false)).toBe(true)
  })

  it("marks tracks muted by mute or by another track's solo", () => {
    const timeline = timelineWith([
      audioTrack({ id: "t-mic", muted: true, clips: [audioClip({ streamIndex: 1 })] }),
      audioTrack({
        id: "t-sys",
        solo: true,
        clips: [audioClip({ id: "ac2", streamIndex: 2 })],
      }),
    ])
    const sources = listCaptionAudioSources(timeline, "rec1")
    expect(sources.find((s) => s.streamIndex === 1)?.muted).toBe(true)
    expect(sources.find((s) => s.streamIndex === 2)?.muted).toBe(false)
  })

  it("reports a null-stream pseudo-source when the recording's only audio track lacks indices", () => {
    const timeline = timelineWith([audioTrack({ clips: [audioClip({ streamIndex: undefined })] })])
    const sources = listCaptionAudioSources(timeline, "rec1")
    expect(sources).toHaveLength(1)
    expect(sources[0].streamIndex).toBeNull()
    expect(sources[0].clipCount).toBe(1)
  })

  it("skips unindexed clips when indexed sources exist", () => {
    const timeline = timelineWith([
      audioTrack({
        clips: [audioClip({ streamIndex: 1 }), audioClip({ id: "ac2", streamIndex: undefined })],
      }),
      audioTrack({ id: "t2", clips: [audioClip({ id: "ac3", streamIndex: 2 })] }),
    ])
    const sources = listCaptionAudioSources(timeline, "rec1")
    expect(sources.map((s) => s.streamIndex).sort()).toEqual([1, 2])
  })

  it("recognizes stream-asset ids — the shape persisted projects actually carry", () => {
    // createProjectFromRecording rewrites clip.assetId to
    // `${recordingId}:${role}:${streamIndex}`; exact-id matching would hide
    // every indexed source behind "No audio on the timeline".
    const timeline = timelineWith([
      audioTrack({
        clips: [audioClip({ streamIndex: 1, role: "microphone", assetId: "rec1:microphone:1" })],
      }),
      audioTrack({
        id: "t-ext",
        clips: [audioClip({ id: "ac2", streamIndex: undefined, assetId: "ext-asset-9" })],
      }),
    ])
    const sources = listCaptionAudioSources(timeline, "rec1")
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({ streamIndex: 1, role: "microphone" })
  })

  it("pickDefaultCaptionSource prefers the first audible microphone", () => {
    const timeline = timelineWith([
      audioTrack({
        id: "t-sys",
        clips: [audioClip({ streamIndex: 2, role: "system_audio" })],
      }),
      audioTrack({
        id: "t-mic",
        clips: [audioClip({ id: "ac2", streamIndex: 1, role: "microphone" })],
      }),
    ])
    const pick = pickDefaultCaptionSource(listCaptionAudioSources(timeline, "rec1"))
    expect(pick?.streamIndex).toBe(1)
    expect(pickDefaultCaptionSource([])).toBeNull()
  })
})

describe("mapTranscriptToTimeline", () => {
  const word = (text: string, s: number, e: number): TranscriptWord => ({
    text,
    startMs: s,
    endMs: e,
    spaceBefore: true,
  })

  it("maps identity when clip covers the full source", () => {
    const { words, droppedCount } = mapTranscriptToTimeline(
      [word("a", 0, 100), word("b", 100, 300)],
      [audioClip()],
    )
    expect(droppedCount).toBe(0)
    expect(words.map((x) => [x.startMs, x.endMs])).toEqual([
      [0, 100],
      [100, 300],
    ])
  })

  it("drops words in a trimmed-away source section", () => {
    const { words, droppedCount } = mapTranscriptToTimeline(
      [word("gone", 1_000, 2_000), word("kept", 5_000, 6_000)],
      [audioClip({ sourceInMs: 4_000, sourceOutMs: 8_000, durationMs: 4_000 })],
    )
    expect(droppedCount).toBe(1)
    // Container 5000 lands at timeline start + 1000.
    expect(words[0]).toMatchObject({ text: "kept", startMs: 1_000, endMs: 2_000 })
  })

  it("honours speed 2× and sourceInMs > 0", () => {
    const { words } = mapTranscriptToTimeline(
      [word("x", 2_000, 3_000)],
      [
        audioClip({
          sourceInMs: 1_000,
          sourceOutMs: 5_000,
          speed: 2,
          startMs: 500,
          durationMs: 2_000,
        }),
      ],
    )
    // Container 2000 → (2000-1000)/2 = 500 ms into the clip → timeline 1000.
    expect(words[0].startMs).toBe(1_000)
    expect(words[0].endMs).toBe(1_500)
  })

  it("captions a duplicated source range twice", () => {
    const { words } = mapTranscriptToTimeline(
      [word("echo", 100, 400)],
      [
        audioClip({ startMs: 0, durationMs: 1_000, sourceInMs: 0, sourceOutMs: 1_000 }),
        audioClip({
          id: "ac2",
          startMs: 5_000,
          durationMs: 1_000,
          sourceInMs: 0,
          sourceOutMs: 1_000,
        }),
      ],
    )
    expect(words).toHaveLength(2)
    // Container 100 ms maps to clip start + 100 on each occurrence.
    expect(words.map((x) => x.startMs)).toEqual([100, 5_100])
  })
})

describe("cleanTranscriptWords", () => {
  const tw = (text: string, i: number): TranscriptWord => ({
    text,
    startMs: i * 100,
    endMs: i * 100 + 90,
    spaceBefore: true,
  })

  it("removes a whisper repetition loop but keeps the first pass", () => {
    const looped = ["the", "same", "the", "same", "the", "same", "the", "same", "end"].map(tw)
    const cleaned = cleanTranscriptWords(looped)
    expect(cleaned.map((x) => x.text)).toEqual(["the", "same", "end"])
  })

  it("leaves two or three repetitions alone", () => {
    const words = ["echo", "echo", "echo", "ok"].map(tw)
    expect(cleanTranscriptWords(words).map((x) => x.text)).toEqual(["echo", "echo", "echo", "ok"])
  })

  it("drops words with no letter or digit", () => {
    const words = [tw("hello", 0), tw("♪", 1), tw("...", 2), tw("world", 3)]
    expect(cleanTranscriptWords(words).map((x) => x.text)).toEqual(["hello", "world"])
  })
})

describe("segmentCaptionWords", () => {
  const flat = (texts: string[], step = 300): TimelineWord[] =>
    texts.map((t, i) => w(t, i * step, i * step + 250))

  it("returns no cues for empty input", () => {
    expect(segmentCaptionWords([], PROFILE)).toEqual([])
  })

  it("splits at sentence-final punctuation past half capacity", () => {
    // "aaaaaaa bbbbbbb ccccccc dddddd." is 31 chars ≥ 50% of 60-char capacity.
    const words = flat(["aaaaaaa", "bbbbbbb", "ccccccc", "dddddd.", "eeee", "ffffff", "gggggg."])
    const cues = segmentCaptionWords(words, PROFILE)
    expect(cues.length).toBe(2)
    expect(cues[0].text).toBe("aaaaaaa bbbbbbb ccccccc dddddd.")
    expect(cues[1].text).toBe("eeee ffffff gggggg.")
  })

  it("always splits on a hard pause", () => {
    const words = [
      ...flat(["short", "cue"], 200),
      w("after", 2_000, 2_300),
      w("pause", 2_400, 2_700),
    ]
    const cues = segmentCaptionWords(words, PROFILE)
    expect(cues.length).toBe(2)
    expect(cues[1].text).toBe("after pause")
  })

  it("caps cue duration and word capacity", () => {
    const long = flat(
      Array.from({ length: 40 }, (_, i) => `w${i}`),
      250,
    ) // 10s total
    const cues = segmentCaptionWords(long, PROFILE)
    for (const cue of cues) expect(cue.endMs - cue.startMs).toBeLessThanOrEqual(6_000 + 300)
    const capped = segmentCaptionWords(flat(["a", "b", "c", "d", "e", "f", "g", "h"]), {
      ...PROFILE,
      maxWords: 4,
    })
    for (const cue of capped) expect(cue.text.split(" ").length).toBeLessThanOrEqual(4)
  })

  it("prefers a break before a conjunction over a mid-phrase cut", () => {
    // 7 × 9-char words = 69 chars > 60 capacity — forces a break; the
    // conjunction bonus should open the second cue at "but".
    const words = flat([
      "aaaaaaaaa",
      "bbbbbbbbb",
      "ccccccccc",
      "but",
      "ddddddddd",
      "eeeeeeeee",
      "fffffffff",
    ])
    const cues = segmentCaptionWords(words, PROFILE)
    expect(cues.length).toBe(2)
    expect(cues[1].text.startsWith("but")).toBe(true)
  })

  it("extends short cues up to minDurationMs without overlapping the next cue", () => {
    const words = [w("hi.", 0, 200), w("bye.", 1_000, 1_200)]
    const cues = segmentCaptionWords(words, PROFILE)
    expect(cues[0].endMs - cues[0].startMs).toBeLessThanOrEqual(800)
    expect(cues[1].startMs).toBeGreaterThanOrEqual(cues[0].endMs - 1)
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i].startMs).toBeGreaterThanOrEqual(cues[i - 1].endMs)
    }
  })

  it("assembles spaceless scripts without spaces", () => {
    const words = [
      w("今", 0, 300, false),
      w("日", 300, 600, false),
      w("は", 600, 900, false),
      w("。", 900, 1_000, false),
      w("good", 1_000, 1_400),
    ]
    const cues = segmentCaptionWords(words, PROFILE)
    // No spaces inside the CJK run; a spaceless-script word that IS closing
    // punctuation attaches without a space either.
    expect(cues[0].text).toContain("今日は。")
  })

  it("produces sorted non-overlapping cues with sequential ids", () => {
    const words = flat(
      Array.from({ length: 30 }, (_, i) => `word${i}`),
      200,
    )
    const cues = segmentCaptionWords(words, PROFILE)
    cues.forEach((cue, i) => {
      expect(cue.id).toBe(`ai-${i + 1}`)
      if (i > 0) expect(cue.startMs).toBeGreaterThanOrEqual(cues[i - 1].endMs - 1)
    })
  })
})

describe("segmentCaptionWords — attached word timings", () => {
  it("attaches display-token timings rebased to the cue start", () => {
    const words = [w("Welcome", 500, 800), w("to", 820, 1_000), w("RecordForge", 1_020, 1_500)]
    const cues = segmentCaptionWords(words, PROFILE)
    expect(cues).toHaveLength(1)
    const cue = cues[0]
    expect(cue.words).toBeDefined()
    // One stored entry per DISPLAY token of the reflowed text — the same
    // pipeline the layout engine tokenizes with.
    const display = captionWords(reflowCueText(cue.text))
    expect(cue.words!.map((x) => x.text)).toEqual(display.map((x) => x.text))
    // Cue-relative (0-based), inside [0, duration], monotone.
    const duration = cue.endMs - cue.startMs
    let prevStart = -1
    for (const [i, stored] of cue.words!.entries()) {
      expect(stored.startMs).toBeGreaterThanOrEqual(prevStart)
      expect(stored.startMs).toBeGreaterThanOrEqual(0)
      expect(stored.endMs).toBeGreaterThanOrEqual(stored.startMs)
      expect(stored.endMs).toBeLessThanOrEqual(duration)
      prevStart = stored.startMs
      // First word's window matches its transcript time rebased to the cue.
      if (i === 0) {
        expect(stored.startMs).toBe(500 - cue.startMs)
        expect(stored.endMs).toBe(800 - cue.startMs)
      }
    }
  })

  it("covers every display token even when a transcript word never matches", () => {
    // assembleCueText joins with spaces; a stray group word absent from the
    // reflowed text gives no coverage — neighbours interpolate.
    const words = [w("alpha", 0, 300), w("beta", 400, 800)]
    const timings = displayWordTimings("alpha beta", words, 0, 1_200)
    expect(timings).toHaveLength(2)
    expect(timings![0]).toMatchObject({ text: "alpha", startMs: 0, endMs: 300 })
    expect(timings![1].startMs).toBeGreaterThanOrEqual(300)
  })

  it("omits words entirely when no token maps", () => {
    const timings = displayWordTimings("alpha beta", [w("zzz", 0, 100)], 0, 1_000)
    expect(timings).toBeUndefined()
  })
})

describe("captionSegmentationProfile + shape effects", () => {
  const transcript = (count: number): TranscriptWord[] =>
    Array.from({ length: count }, (_, i) => ({
      text: i % 9 === 8 ? `word${i}.` : `word${i}`,
      startMs: i * 300,
      endMs: i * 300 + 260,
      spaceBefore: true,
    }))

  it("9:16 yields more, shorter cues than 16:9 for the same transcript", () => {
    const words = transcript(50)
    const wide = segmentCaptionWords(
      words,
      captionSegmentationProfile(
        { width: 1920, height: 1080, aspectRatio: "16:9" },
        { ...DEFAULT_CAPTION_DESIGN },
      ),
    )
    const tall = segmentCaptionWords(
      words,
      captionSegmentationProfile(
        { width: 1080, height: 1920, aspectRatio: "9:16" },
        { ...DEFAULT_CAPTION_DESIGN },
      ),
    )
    expect(tall.length).toBeGreaterThan(wide.length)
  })

  it("highlight looks cap cues at 7 words and 4.2s", () => {
    const words = transcript(30)
    const cues = segmentCaptionWords(
      words,
      captionSegmentationProfile(
        { width: 1920, height: 1080, aspectRatio: "16:9" },
        { ...DEFAULT_CAPTION_DESIGN, preset: "pop" },
      ),
    )
    for (const cue of cues) {
      expect(cue.text.split(" ").length).toBeLessThanOrEqual(7)
      expect(cue.endMs - cue.startMs).toBeLessThanOrEqual(4_200 + 300)
    }
  })
})

describe("buildCaptionCuesFromTranscript", () => {
  it("maps a realistic transcript through the timeline", () => {
    // Shaped like the real H2 whisper output: attached punctuation + flags.
    const transcript = {
      language: "en",
      model: "base",
      streamIndex: 1,
      durationMs: 6_000,
      cached: false,
      words: [
        { text: "Welcome", startMs: 0, endMs: 300, spaceBefore: false },
        { text: "to", startMs: 320, endMs: 500, spaceBefore: true },
        { text: "Record", startMs: 520, endMs: 800, spaceBefore: true },
        { text: "Forge.", startMs: 820, endMs: 1_100, spaceBefore: true },
        { text: "It", startMs: 1_200, endMs: 1_400, spaceBefore: true },
        { text: "records", startMs: 1_420, endMs: 1_800, spaceBefore: true },
        { text: "your", startMs: 1_820, endMs: 2_000, spaceBefore: true },
        { text: "screen.", startMs: 2_020, endMs: 2_400, spaceBefore: true },
      ],
    }
    const timeline = timelineWith([
      audioTrack({ clips: [audioClip({ streamIndex: 1, durationMs: 10_000 })] }),
    ])
    const result = buildCaptionCuesFromTranscript({
      transcript,
      timeline,
      canvas: { width: 1920, height: 1080, aspectRatio: "16:9" },
      design: { ...DEFAULT_CAPTION_DESIGN },
    })
    expect(result.language).toBe("en")
    expect(result.sourceClipCount).toBe(1)
    expect(result.droppedWords).toBe(0)
    expect(result.cues.length).toBeGreaterThan(0)
    expect(result.cues[0].text).toContain("Welcome")
  })

  it("maps words onto unindexed clips when the transcript carries the resolved stream", () => {
    // Pseudo-source regression: when a recording's audio clips are all
    // unindexed, listCaptionAudioSources reports streamIndex null and the
    // caller passes streamIndex: undefined — Rust then resolves the first
    // audio stream, so transcript.streamIndex (here 1) never matches any
    // clip literally. Every unindexed clip must map as the resolved stream.
    const transcript = {
      language: "en",
      model: "base",
      streamIndex: 1,
      durationMs: 6_000,
      cached: false,
      words: [
        { text: "Hello", startMs: 0, endMs: 300, spaceBefore: false },
        { text: "from", startMs: 320, endMs: 500, spaceBefore: true },
        { text: "the", startMs: 520, endMs: 700, spaceBefore: true },
        { text: "unindexed", startMs: 720, endMs: 1_100, spaceBefore: true },
        { text: "clip.", startMs: 1_120, endMs: 1_500, spaceBefore: true },
      ],
    }
    const timeline = timelineWith([audioTrack({ clips: [audioClip({ streamIndex: undefined })] })])
    const result = buildCaptionCuesFromTranscript({
      transcript,
      timeline,
      canvas: { width: 1920, height: 1080, aspectRatio: "16:9" },
      design: { ...DEFAULT_CAPTION_DESIGN },
    })
    expect(result.sourceClipCount).toBe(1)
    expect(result.droppedWords).toBe(0)
    expect(result.cues.length).toBeGreaterThan(0)
    expect(result.cues[0].text).toContain("Hello")
  })

  it("still respects stream indices when indexed clips exist", () => {
    const words = [
      { text: "kept", startMs: 0, endMs: 400, spaceBefore: false },
      { text: "word.", startMs: 420, endMs: 800, spaceBefore: true },
    ]
    const transcript = {
      language: "en",
      model: "base",
      streamIndex: 1,
      durationMs: 2_000,
      cached: false,
      words,
    }
    const timeline = timelineWith([
      audioTrack({
        clips: [
          audioClip({ streamIndex: 1 }),
          audioClip({ id: "ac2", streamIndex: undefined }),
          audioClip({ id: "ac3", streamIndex: 2 }),
        ],
      }),
    ])
    const result = buildCaptionCuesFromTranscript({
      transcript,
      timeline,
      canvas: { width: 1920, height: 1080, aspectRatio: "16:9" },
      design: { ...DEFAULT_CAPTION_DESIGN },
    })
    // Only the literal stream-1 clip maps — the unindexed clip is excluded
    // because indexed clips exist for this recording.
    expect(result.sourceClipCount).toBe(1)
    expect(result.droppedWords).toBe(0)
    expect(result.cues.length).toBeGreaterThan(0)
  })

  it("never throws on empty input", () => {
    const timeline = timelineWith([])
    const result = buildCaptionCuesFromTranscript({
      transcript: {
        language: "en",
        model: "base",
        streamIndex: 1,
        durationMs: 0,
        cached: false,
        words: [],
      },
      timeline,
      canvas: { width: 1920, height: 1080, aspectRatio: "16:9" },
      design: { ...DEFAULT_CAPTION_DESIGN },
    })
    expect(result).toMatchObject({ cues: [], droppedWords: 0, sourceClipCount: 0 })
  })
})

describe("analyzeCaptionCue", () => {
  const canvas = { width: 1920, height: 1080, aspectRatio: "16:9" as const }

  it("flags too-long, fast, and short cues", () => {
    const long = analyzeCaptionCue(
      {
        text: Array.from({ length: 60 }, (_, i) => `w${i}`).join(" "),
        startMs: 0,
        endMs: 4_000,
      },
      { ...DEFAULT_CAPTION_DESIGN, preset: "pop" },
      { width: 1080, height: 1920, aspectRatio: "9:16" },
    )
    expect(long.pages).toBeGreaterThan(1)
    expect(long.warnings).toContain("too-long")

    const fast = analyzeCaptionCue(
      { text: "this cue has far too many words for its short window", startMs: 0, endMs: 900 },
      { ...DEFAULT_CAPTION_DESIGN },
      canvas,
    )
    expect(fast.warnings).toContain("fast")

    const short = analyzeCaptionCue(
      { text: "hi", startMs: 0, endMs: 200 },
      { ...DEFAULT_CAPTION_DESIGN },
      canvas,
    )
    expect(short.warnings).toContain("short")
  })
})

describe("collectAudioClipsForStream", () => {
  it("filters to matching stream + recording id", () => {
    const timeline = timelineWith([
      audioTrack({
        clips: [
          audioClip({ streamIndex: 1 }),
          audioClip({ id: "ac2", streamIndex: 2 }),
          audioClip({ id: "ac3", streamIndex: 1, assetId: "other-recording" }),
        ],
      }),
    ])
    expect(collectAudioClipsForStream(timeline, "rec1", 1).map((c) => c.id)).toEqual(["ac1"])
    expect(collectAudioClipsForStream(timeline, "rec1", 2).map((c) => c.id)).toEqual(["ac2"])
  })

  it("selects stream-asset clips while still excluding other assets", () => {
    const timeline = timelineWith([
      audioTrack({
        clips: [
          audioClip({ streamIndex: 1, assetId: "rec1:microphone:1" }),
          audioClip({ id: "ac2", streamIndex: 2, assetId: "rec1:system_audio:2" }),
          audioClip({ id: "ac3", streamIndex: 1, assetId: "other-recording:microphone:1" }),
        ],
      }),
    ])
    expect(collectAudioClipsForStream(timeline, "rec1", 1).map((c) => c.id)).toEqual(["ac1"])
    expect(collectAudioClipsForStream(timeline, "rec1", 2).map((c) => c.id)).toEqual(["ac2"])
  })

  it("treats unindexed clips as the resolved pseudo-source when nothing is indexed", () => {
    const timeline = timelineWith([audioTrack({ clips: [audioClip({ streamIndex: undefined })] })])
    expect(collectAudioClipsForStream(timeline, "rec1", null)).toHaveLength(1)
    expect(collectAudioClipsForStream(timeline, "rec1", 1)).toHaveLength(1)
  })

  it("excludes unindexed clips once an indexed clip exists", () => {
    const timeline = timelineWith([
      audioTrack({
        clips: [audioClip({ streamIndex: 1 }), audioClip({ id: "ac2", streamIndex: undefined })],
      }),
    ])
    expect(collectAudioClipsForStream(timeline, "rec1", null)).toHaveLength(0)
    expect(collectAudioClipsForStream(timeline, "rec1", 1).map((c) => c.id)).toEqual(["ac1"])
  })
})

describe("applyCueTiming", () => {
  it("emits cue-relative words plus absolute container sourceWords for the same tokens", () => {
    const group: TimelineWord[] = [
      {
        text: "Hello",
        startMs: 100,
        endMs: 400,
        spaceBefore: false,
        srcStartMs: 5_000,
        srcEndMs: 5_300,
      },
      {
        text: "world",
        startMs: 500,
        endMs: 900,
        spaceBefore: true,
        srcStartMs: 5_400,
        srcEndMs: 5_800,
      },
    ]
    const [cue] = applyCueTiming([group], PROFILE)
    // lead 60 pads the start; `words` stays relative to the cue.
    expect(cue.startMs).toBe(40)
    expect(cue.endMs).toBe(1_060)
    expect(cue.words).toEqual([
      { text: "Hello", startMs: 60, endMs: 360 },
      { text: "world", startMs: 460, endMs: 860 },
    ])
    // `sourceWords` is verbatim absolute container time — never rebased.
    expect(cue.sourceWords).toEqual([
      { text: "Hello", startMs: 5_000, endMs: 5_300 },
      { text: "world", startMs: 5_400, endMs: 5_800 },
    ])
    // Both timing lists cover exactly the display tokens of the cue text.
    const tokens = captionWords(reflowCueText(cue.text))
    expect(cue.words).toHaveLength(tokens.length)
    expect(cue.sourceWords).toHaveLength(tokens.length)
  })

  it("omits sourceWords when the group carries no provenance", () => {
    const [cue] = applyCueTiming(
      [[{ text: "plain", startMs: 0, endMs: 300, spaceBefore: false }]],
      PROFILE,
    )
    expect(cue.words).toBeDefined()
    expect(cue.sourceWords).toBeUndefined()
  })

  it("splits a cue on a mapped gap without losing either timing basis", () => {
    const runs: TimelineWord[][] = [
      [
        {
          text: "one",
          startMs: 100,
          endMs: 400,
          spaceBefore: false,
          srcStartMs: 1_000,
          srcEndMs: 1_300,
        },
      ],
      [
        {
          text: "two",
          startMs: 5_000,
          endMs: 5_400,
          spaceBefore: true,
          srcStartMs: 2_000,
          srcEndMs: 2_400,
        },
      ],
    ]
    const cues = applyCueTiming(runs, PROFILE)
    expect(cues).toHaveLength(2)
    // Piece 1 extends to minDuration; piece 2 keeps its own container span.
    expect(cues[0].sourceWords).toEqual([{ text: "one", startMs: 1_000, endMs: 1_300 }])
    expect(cues[1].sourceWords).toEqual([{ text: "two", startMs: 2_000, endMs: 2_400 }])
  })
})

describe("caption provenance", () => {
  it("carries absolute source times through mapTranscriptToTimeline verbatim", () => {
    const { words } = mapTranscriptToTimeline(
      [{ text: "a", startMs: 2_000, endMs: 2_400, spaceBefore: false }],
      [
        audioClip({
          sourceInMs: 1_000,
          sourceOutMs: 5_000,
          speed: 2,
          startMs: 500,
          durationMs: 2_000,
        }),
      ],
    )
    // Output is clamped/compressed to the clip; provenance stays container ms.
    expect(words[0].srcStartMs).toBe(2_000)
    expect(words[0].srcEndMs).toBe(2_400)
  })

  it("stamps the resolved stream and container-time words on every generated cue", () => {
    const transcript = {
      language: "en",
      model: "base",
      streamIndex: 1,
      durationMs: 12_000,
      cached: false,
      words: [
        { text: "Deep", startMs: 5_000, endMs: 5_300, spaceBefore: false },
        { text: "inside", startMs: 5_400, endMs: 5_800, spaceBefore: true },
      ],
    }
    const timeline = timelineWith([
      audioTrack({ clips: [audioClip({ streamIndex: 1, startMs: 2_000 })] }),
    ])
    const result = buildCaptionCuesFromTranscript({
      transcript,
      timeline,
      canvas: { width: 1920, height: 1080, aspectRatio: "16:9" },
      design: { ...DEFAULT_CAPTION_DESIGN },
    })
    expect(result.cues).toHaveLength(1)
    const cue = result.cues[0]
    expect(cue.sourceStreamIndex).toBe(1)
    // Container 5000/5400 map to timeline 7000/7400 — provenance keeps 5000/5400.
    expect(cue.sourceWords).toEqual([
      { text: "Deep", startMs: 5_000, endMs: 5_300 },
      { text: "inside", startMs: 5_400, endMs: 5_800 },
    ])
    expect(cue.words?.map((entry) => entry.text)).toEqual(
      captionWords(reflowCueText(cue.text)).map((entry) => entry.text),
    )
  })
})

describe("analyzeCaptionSync", () => {
  function captionTrackWith(clips: CaptionClip[]): TimelineTrack {
    return {
      id: "ct1",
      kind: "captions",
      name: "Captions",
      muted: false,
      locked: false,
      solo: false,
      volume: 1,
      clips,
    } as TimelineTrack
  }

  function aiCaptionClip(overrides: Partial<CaptionClip> = {}): CaptionClip {
    return {
      id: "cap1",
      kind: "caption",
      assetId: "ct1",
      startMs: 940,
      durationMs: 920,
      sourceInMs: 1_000,
      sourceOutMs: 1_700,
      speed: 1,
      text: "one two",
      style: "default",
      words: [
        { text: "one", startMs: 60, endMs: 360 },
        { text: "two", startMs: 460, endMs: 760 },
      ],
      sourceWords: [
        { text: "one", startMs: 1_000, endMs: 1_300 },
        { text: "two", startMs: 1_400, endMs: 1_700 },
      ],
      sourceStreamIndex: 1,
      ...overrides,
    } as CaptionClip
  }

  it("reports a clean sync when the audio coverage is unchanged", () => {
    const track = captionTrackWith([aiCaptionClip()])
    const timeline = timelineWith([audioTrack({ clips: [audioClip()] }), track])
    expect(analyzeCaptionSync(timeline, track)).toEqual({ total: 1, displaced: 0, dropped: 0 })
  })

  it("flags a displaced cue when its audio moved", () => {
    const track = captionTrackWith([aiCaptionClip()])
    const timeline = timelineWith([audioTrack({ clips: [audioClip({ startMs: 5_000 })] }), track])
    expect(analyzeCaptionSync(timeline, track)).toEqual({ total: 1, displaced: 1, dropped: 0 })
  })

  it("flags a dropped cue when its audio coverage vanished", () => {
    const track = captionTrackWith([aiCaptionClip()])
    // The clip keeps only container [4000,10000] — both cue words are gone.
    const timeline = timelineWith([
      audioTrack({
        clips: [audioClip({ sourceInMs: 4_000, sourceOutMs: 10_000, durationMs: 6_000 })],
      }),
      track,
    ])
    expect(analyzeCaptionSync(timeline, track)).toEqual({ total: 1, displaced: 0, dropped: 1 })
  })

  it("counts a mid-cue cut as displaced, not dropped", () => {
    const track = captionTrackWith([aiCaptionClip()])
    // Only container [1500,10000] survives — "one" is cut, "two" survives.
    const timeline = timelineWith([
      audioTrack({
        clips: [audioClip({ sourceInMs: 1_500, sourceOutMs: 10_000, durationMs: 8_500 })],
      }),
      track,
    ])
    expect(analyzeCaptionSync(timeline, track)).toEqual({ total: 1, displaced: 1, dropped: 0 })
  })

  it("skips cues without provenance", () => {
    const track = captionTrackWith([
      aiCaptionClip({ sourceWords: undefined, sourceStreamIndex: undefined, words: undefined }),
    ])
    const timeline = timelineWith([audioTrack({ clips: [audioClip({ startMs: 9_000 })] }), track])
    expect(analyzeCaptionSync(timeline, track)).toEqual({ total: 0, displaced: 0, dropped: 0 })
  })
})
