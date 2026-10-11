import { describe, expect, it } from "vitest"
import {
  defaultCursorSettings,
  type AudioClip,
  type CaptionClip,
  type TimelineState,
  type TimelineTrack,
} from "@recordforge/domain"
import {
  analyzeCaptionSync,
  captionWords,
  countCaptionTextMatches,
  createAddCaptionClipCommand,
  createDeleteClipCommand,
  createEngine,
  createImportCaptionCuesCommand,
  createMergeCaptionClipsCommand,
  createMoveClipCommand,
  createReplaceCaptionTextCommand,
  createResyncCaptionsCommand,
  createShiftCaptionsCommand,
  createSplitClipCommand,
  createDeleteRangeCommand,
  createTrimClipCommand,
  createUpdateCaptionClipCommand,
  createUpdateCaptionTrackCommand,
  executeCommand,
  reflowCueText,
  undoCommand,
} from "../index"

function makeState(): TimelineState {
  const now = "2026-08-10T00:00:00.000Z"
  return {
    version: 1,
    id: "caption-commands",
    name: "Caption commands",
    recordingId: "recording",
    canvas: {
      width: 1920,
      height: 1080,
      fps: 30,
      background: "#000000",
      padding: 0,
      borderRadius: 0,
      shadow: false,
      cursorSettings: defaultCursorSettings,
    },
    tracks: [
      {
        id: "screen",
        kind: "screen",
        name: "Screen",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "screen-clip",
            kind: "screen",
            assetId: "recording",
            startMs: 0,
            durationMs: 20_000,
            sourceInMs: 0,
            sourceOutMs: 20_000,
            speed: 1,
          },
        ],
      },
    ],
    markers: [],
    zoomSegments: [],
    createdAt: now,
    updatedAt: now,
  }
}

function captionsTrack(state: TimelineState): TimelineTrack | undefined {
  return state.tracks.find((track) => track.kind === "captions")
}

function captionClips(state: TimelineState): CaptionClip[] {
  return (captionsTrack(state)?.clips ?? []).filter(
    (clip): clip is CaptionClip => clip.kind === "caption",
  )
}

function withCaptions(state: TimelineState, clips: Partial<CaptionClip>[]): TimelineState {
  const track: TimelineTrack = {
    id: "track:captions",
    kind: "captions",
    name: "Captions",
    muted: false,
    locked: false,
    solo: false,
    volume: 1,
    clips: clips.map(
      (clip, i): CaptionClip =>
        ({
          id: `cap-${i}`,
          kind: "caption",
          assetId: "track:captions",
          startMs: i * 2_000,
          durationMs: 1_000,
          sourceInMs: i * 2_000,
          // sourceOutMs must cover durationMs (source==timeline at speed 1).
          sourceOutMs: i * 2_000 + (clip.durationMs ?? 1_000),
          speed: 1,
          text: `cue ${i}`,
          style: "default",
          ...clip,
        }) as CaptionClip,
    ),
  }
  return { ...state, tracks: [...state.tracks, track] }
}

describe("import-caption-cues", () => {
  const cues = [
    { id: "one", startMs: 0, endMs: 900, text: "First cue" },
    { id: "two", startMs: 1_000, endMs: 1_900, text: "Second cue" },
  ]

  it("stamps the design on a newly created track and drops baked clip defaults", () => {
    const result = executeCommand(
      createEngine(makeState()),
      createImportCaptionCuesCommand(cues, { design: { preset: "pop", offsetY: -0.05 } }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const track = captionsTrack(result.value.history.present)!
    expect(track.captionDesign).toMatchObject({
      preset: "pop",
      offsetY: -0.05,
      placement: "bottom",
    })
    for (const clip of track.clips) {
      expect(clip).not.toHaveProperty("placement")
      expect(clip).not.toHaveProperty("safeAreaMargin")
    }
  })

  it("replace mode clears existing cues and one undo restores them", () => {
    const base = withCaptions(makeState(), [{ text: "old one" }, { text: "old two" }])
    const engine = createEngine(base)
    const replaced = executeCommand(
      engine,
      createImportCaptionCuesCommand(cues, { mode: "replace" }),
    )
    expect(replaced.ok).toBe(true)
    if (!replaced.ok) return
    const clips = captionClips(replaced.value.history.present)
    expect(clips.map((c) => c.text)).toEqual(["First cue", "Second cue"])
    const undone = undoCommand(replaced.value)
    expect(undone.ok).toBe(true)
    if (undone.ok) {
      expect(captionClips(undone.value.history.present).map((c) => c.text)).toEqual([
        "old one",
        "old two",
      ])
    }
  })

  it("rejects overlapping cues in replace mode and on locked tracks", () => {
    const engine = createEngine(withCaptions(makeState(), [{ text: "keep" }]))
    const overlapping = executeCommand(
      engine,
      createImportCaptionCuesCommand(
        [
          { id: "a", startMs: 0, endMs: 1_000, text: "x" },
          { id: "b", startMs: 500, endMs: 1_500, text: "y" },
        ],
        { mode: "replace" },
      ),
    )
    expect(overlapping.ok).toBe(false)

    const lockedState = withCaptions(makeState(), [{ text: "keep" }])
    const lockedTrack = captionsTrack(lockedState)!
    lockedState.tracks = lockedState.tracks.map((t) =>
      t.id === lockedTrack.id ? { ...t, locked: true } : t,
    )
    const blocked = executeCommand(
      createEngine(lockedState),
      createImportCaptionCuesCommand(cues, { mode: "replace" }),
    )
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.error.code).toBe("track_locked")
  })
})

describe("add-caption-clip", () => {
  it("creates a captions track carrying the default design, no baked overrides", () => {
    const result = executeCommand(
      createEngine(makeState()),
      createAddCaptionClipCommand("hello there", 0, 1_000),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const track = captionsTrack(result.value.history.present)!
    expect(track.captionDesign).toMatchObject({ preset: "default", placement: "bottom" })
    const clip = track.clips[0] as CaptionClip
    expect(clip.style).toBe("default")
    expect(clip).not.toHaveProperty("placement")
    expect(clip).not.toHaveProperty("safeAreaMargin")
  })
})

describe("update-caption-track design merging", () => {
  it("migrates a legacy track on first design edit", () => {
    const state = withCaptions(makeState(), [{ text: "one", style: "boxed" }])
    const result = executeCommand(
      createEngine(state),
      createUpdateCaptionTrackCommand("track:captions", {
        design: { sizeScale: 1.3 },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Legacy fallback resolved "boxed" from the first clip — sizeScale merges in.
    expect(captionsTrack(result.value.history.present)?.captionDesign).toMatchObject({
      preset: "boxed",
      sizeScale: 1.3,
      placement: "bottom",
    })
  })

  it("resets clip styles when the design preset changes and clears placement overrides", () => {
    const state = withCaptions(makeState(), [
      { text: "a", style: "boxed", placement: "top" },
      { text: "b", style: "highlight" },
    ])
    const result = executeCommand(
      createEngine(state),
      createUpdateCaptionTrackCommand("track:captions", {
        design: { preset: "focus", placement: "center" },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const clips = captionClips(result.value.history.present)
    expect(clips.every((clip) => clip.style === "default")).toBe(true)
    expect(clips.every((clip) => !("placement" in clip))).toBe(true)
    expect(captionsTrack(result.value.history.present)?.captionDesign).toMatchObject({
      preset: "focus",
      placement: "center",
    })
  })

  it("null clears uppercase/accentColor back to the look default", () => {
    const state = withCaptions(makeState(), [{ text: "one" }])
    const engine = createEngine(state)
    const set = executeCommand(
      engine,
      createUpdateCaptionTrackCommand("track:captions", {
        design: { uppercase: true, accentColor: "#22D3EE" },
      }),
    )
    expect(set.ok).toBe(true)
    if (!set.ok) return
    expect(captionsTrack(set.value.history.present)?.captionDesign).toMatchObject({
      uppercase: true,
      accentColor: "#22D3EE",
    })
    const cleared = executeCommand(
      set.value,
      createUpdateCaptionTrackCommand("track:captions", {
        design: { uppercase: null, accentColor: null },
      }),
    )
    expect(cleared.ok).toBe(true)
    if (!cleared.ok) return
    const design = captionsTrack(cleared.value.history.present)?.captionDesign
    expect(design).not.toHaveProperty("uppercase")
    expect(design).not.toHaveProperty("accentColor")
  })

  it("legacy style/placement fields mirror into the design", () => {
    const state = withCaptions(makeState(), [{ text: "one", style: "minimal" }])
    const result = executeCommand(
      createEngine(state),
      createUpdateCaptionTrackCommand("track:captions", { style: "boxed" }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(captionsTrack(result.value.history.present)?.captionDesign?.preset).toBe("boxed")
    expect(captionClips(result.value.history.present).every((c) => c.style === "default")).toBe(
      true,
    )
  })

  it("coalesces continuous design changes only", () => {
    const continuous = createUpdateCaptionTrackCommand("t1", { design: { sizeScale: 1.4 } })
    expect(continuous.coalesce).toBe(true)
    expect(continuous.coalesceKey).toBe("caption-design:t1")
    const discrete = createUpdateCaptionTrackCommand("t1", {
      design: { preset: "pop", sizeScale: 1.4 },
    })
    expect(discrete.coalesce).toBe(false)
    const legacy = createUpdateCaptionTrackCommand("t1", { style: "boxed" })
    expect(legacy.coalesce).toBe(false)
  })
})

describe("smart caption text on splits and range deletes", () => {
  it("splits a multi-word cue at the nearest word boundary", () => {
    const state = withCaptions(makeState(), [
      { id: "cap-0", text: "first part then the rest", startMs: 0, durationMs: 2_000 },
    ])
    const result = executeCommand(createEngine(state), createSplitClipCommand("cap-0", 1_000))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const texts = captionClips(result.value.history.present).map((clip) => clip.text)
    expect(texts).toHaveLength(2)
    expect(`${texts[0]} ${texts[1]}`).toBe("first part then the rest")
  })

  it("slices straddled cue text on range delete and drops empty sides", () => {
    const state = withCaptions(makeState(), [
      { id: "cap-0", text: "one two three four five six", startMs: 0, durationMs: 6_000 },
    ])
    // Delete the middle third — left/right pieces keep their own words.
    const result = executeCommand(createEngine(state), createDeleteRangeCommand(2_000, 4_000))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const texts = captionClips(result.value.history.present).map((clip) => clip.text)
    expect(texts).toHaveLength(2)
    expect(texts[0]).toBe("one two")
    expect(texts[1]).toBe("five six")
  })

  it("keeps the longer piece with full text when both slices are empty", () => {
    const state = withCaptions(makeState(), [
      { id: "cap-0", text: "one", startMs: 0, durationMs: 6_000 },
    ])
    // Deleting 4s–5s leaves a 4s left piece and a 1s right piece; the single
    // word lands in neither slice, so the longer (left) piece keeps the text.
    const result = executeCommand(createEngine(state), createDeleteRangeCommand(4_000, 5_000))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const clips = captionClips(result.value.history.present)
    expect(clips).toHaveLength(1)
    expect(clips[0].text).toBe("one")
    expect(clips[0].startMs).toBe(0)
    expect(clips[0].durationMs).toBe(4_000)
  })
})

describe("merge-caption-clips", () => {
  it("merges adjacent cues keeping the first clip's overrides", () => {
    const state = withCaptions(makeState(), [
      { id: "cap-0", text: "hello", startMs: 0, style: "boxed", placement: "top" },
      { id: "cap-1", text: "world", startMs: 1_000, durationMs: 800 },
      { id: "cap-2", text: "there", startMs: 1_800, durationMs: 500 },
    ])
    const result = executeCommand(
      createEngine(state),
      createMergeCaptionClipsCommand(["cap-1", "cap-0"]),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const clips = captionClips(result.value.history.present)
    expect(clips).toHaveLength(2)
    const merged = clips.find((clip) => clip.id === "cap-0")!
    expect(merged.text).toBe("hello world")
    expect(merged.startMs).toBe(0)
    expect(merged.startMs + merged.durationMs).toBe(1_800)
    expect(merged.style).toBe("boxed")
    expect(merged.placement).toBe("top")
  })

  it("rejects a selection with an unselected cue inside the span", () => {
    const state = withCaptions(makeState(), [
      { id: "cap-0", text: "a", startMs: 0 },
      { id: "cap-1", text: "b", startMs: 1_000 },
      { id: "cap-2", text: "c", startMs: 2_000 },
    ])
    const result = executeCommand(
      createEngine(state),
      createMergeCaptionClipsCommand(["cap-0", "cap-2"]),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("not_adjacent")
  })

  it("rejects merges on locked tracks", () => {
    const state = withCaptions(makeState(), [
      { id: "cap-0", text: "a", startMs: 0 },
      { id: "cap-1", text: "b", startMs: 1_000 },
    ])
    state.tracks = state.tracks.map((t) => (t.kind === "captions" ? { ...t, locked: true } : t))
    const result = executeCommand(
      createEngine(state),
      createMergeCaptionClipsCommand(["cap-0", "cap-1"]),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("track_locked")
  })
})

describe("replace-caption-text", () => {
  const state = () =>
    withCaptions(makeState(), [
      { id: "cap-0", text: "The cat sat there" },
      { id: "cap-1", text: "another cat, another CAT", startMs: 2_000 },
    ])

  it("replaces case-insensitively by default and honours matchCase", () => {
    const result = executeCommand(
      createEngine(state()),
      createReplaceCaptionTextCommand({ find: "cat", replace: "dog" }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const texts = captionClips(result.value.history.present).map((c) => c.text)
    expect(texts).toEqual(["The dog sat there", "another dog, another dog"])

    const exact = executeCommand(
      createEngine(state()),
      createReplaceCaptionTextCommand({ find: "cat", replace: "dog", matchCase: true }),
    )
    expect(exact.ok).toBe(true)
    if (!exact.ok) return
    const exactTexts = captionClips(exact.value.history.present).map((c) => c.text)
    expect(exactTexts).toEqual(["The dog sat there", "another dog, another CAT"])
  })

  it("wholeWord skips substrings and handles Unicode boundaries", () => {
    const unicode = withCaptions(makeState(), [{ id: "cap-0", text: "concatenate the cat café" }])
    const result = executeCommand(
      createEngine(unicode),
      createReplaceCaptionTextCommand({ find: "cat", replace: "dog", wholeWord: true }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(captionClips(result.value.history.present)[0].text).toBe("concatenate the dog café")
  })

  it("returns no_matches when nothing changes", () => {
    const result = executeCommand(
      createEngine(state()),
      createReplaceCaptionTextCommand({ find: "zebra", replace: "x" }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("no_matches")
  })

  it("keeps a clip's text when the replacement would empty it", () => {
    const solo = withCaptions(makeState(), [{ id: "cap-0", text: "cat" }])
    const result = executeCommand(
      createEngine(solo),
      createReplaceCaptionTextCommand({ find: "cat", replace: "" }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("no_matches")
  })

  it("countCaptionTextMatches counts matches and cues live", () => {
    const clips = captionsTrack(state())!.clips
    expect(
      countCaptionTextMatches(clips, { find: "cat", matchCase: false, wholeWord: false }),
    ).toEqual({ matches: 3, cues: 2 })
    expect(
      countCaptionTextMatches(clips, { find: "cat", matchCase: true, wholeWord: false }),
    ).toEqual({ matches: 2, cues: 2 })
    expect(
      countCaptionTextMatches(clips, { find: "cat", matchCase: true, wholeWord: true }),
    ).toEqual({ matches: 2, cues: 2 })
    expect(
      countCaptionTextMatches(clips, { find: "", matchCase: false, wholeWord: false }),
    ).toEqual({ matches: 0, cues: 0 })
  })
})

describe("caption word timings across edits", () => {
  const timed = (count: number, step = 500) =>
    Array.from({ length: count }, (_, i) => ({
      text: `w${i}`,
      startMs: i * step,
      endMs: i * step + 400,
    }))

  it("import-caption-cues stores cue.words on the clip verbatim", () => {
    const cues = [
      {
        id: "one",
        startMs: 0,
        endMs: 1_000,
        text: "one two",
        words: timed(2),
      },
    ]
    const result = executeCommand(createEngine(makeState()), createImportCaptionCuesCommand(cues))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const clip = captionClips(result.value.history.present)[0]
    expect(clip.words).toEqual(timed(2))
  })

  it("split partitions stored words by index and rebases the right half", () => {
    const state = withCaptions(makeState(), [
      {
        id: "cap-0",
        text: "first part then the rest",
        startMs: 0,
        durationMs: 2_000,
        words: timed(5, 400),
      },
    ])
    const result = executeCommand(createEngine(state), createSplitClipCommand("cap-0", 1_000))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const clips = captionClips(result.value.history.present).sort((a, b) => a.startMs - b.startMs)
    const left = clips[0]
    const right = clips[1]
    // "first part" (2 tokens) / "then the rest" (3 tokens).
    expect(left.text).toBe("first part")
    expect(right.text).toBe("then the rest")
    expect(left.words?.map((x) => x.text)).toEqual(["w0", "w1"])
    expect(right.words?.map((x) => x.text)).toEqual(["w2", "w3", "w4"])
    // Right half rebased to its own start (split at 1000ms) — w2 straddles
    // the cut and clamps to 0; w3 lands cleanly at 200..600.
    expect(right.words![0]).toMatchObject({ text: "w2", startMs: 0, endMs: 200 })
    expect(right.words![1]).toMatchObject({ text: "w3", startMs: 200, endMs: 600 })
    expect(right.words?.every((x) => x.startMs >= 0)).toBe(true)
  })

  it("drops stored words on both halves when the partition can't cover them", () => {
    const state = withCaptions(makeState(), [
      {
        id: "cap-0",
        text: "first part then the rest",
        startMs: 0,
        durationMs: 2_000,
        // Three stored words can't cover five display tokens.
        words: timed(3, 400),
      },
    ])
    const result = executeCommand(createEngine(state), createSplitClipCommand("cap-0", 1_000))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (const clip of captionClips(result.value.history.present)) {
      expect(clip.words).toBeUndefined()
    }
  })

  it("merge concatenates rebased words when every clip carries them", () => {
    const state = withCaptions(makeState(), [
      {
        id: "cap-0",
        text: "hello",
        startMs: 0,
        durationMs: 1_000,
        words: timed(1),
      },
      {
        id: "cap-1",
        text: "world",
        startMs: 1_000,
        durationMs: 1_000,
        sourceInMs: 1_000,
        sourceOutMs: 2_000,
        words: timed(1, 300),
      },
    ])
    const result = executeCommand(
      createEngine(state),
      createMergeCaptionClipsCommand(["cap-0", "cap-1"]),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const merged = captionClips(result.value.history.present)[0]
    expect(merged.words).toEqual([
      { text: "w0", startMs: 0, endMs: 400 },
      // Second clip's word rebased by +1000 (its start − first clip start).
      { text: "w0", startMs: 1_000, endMs: 1_400 },
    ])
  })

  it("merge drops words when any merged clip lacks them", () => {
    const state = withCaptions(makeState(), [
      { id: "cap-0", text: "hello", startMs: 0, words: timed(1) },
      { id: "cap-1", text: "world", startMs: 1_000, sourceInMs: 1_000, sourceOutMs: 2_000 },
    ])
    const result = executeCommand(
      createEngine(state),
      createMergeCaptionClipsCommand(["cap-0", "cap-1"]),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(captionClips(result.value.history.present)[0].words).toBeUndefined()
  })

  it("update-caption-clip clears words on text edits and null clears placement", () => {
    const state = withCaptions(makeState(), [
      {
        id: "cap-0",
        text: "old text",
        startMs: 0,
        placement: "top",
        words: timed(2),
      },
    ])
    const edited = executeCommand(
      createEngine(state),
      createUpdateCaptionClipCommand("cap-0", { text: "new text" }),
    )
    expect(edited.ok).toBe(true)
    if (!edited.ok) return
    const clip = captionClips(edited.value.history.present)[0]
    expect(clip.text).toBe("new text")
    expect(clip.words).toBeUndefined()
    expect(clip.placement).toBe("top")

    const cleared = executeCommand(
      edited.value,
      createUpdateCaptionClipCommand("cap-0", { placement: null }),
    )
    expect(cleared.ok).toBe(true)
    if (!cleared.ok) return
    const reset = captionClips(cleared.value.history.present)[0]
    expect(reset).not.toHaveProperty("placement")
  })

  it("trim drops words past the new end and clamps the last one", () => {
    const state = withCaptions(makeState(), [
      {
        id: "cap-0",
        text: "one two three",
        startMs: 0,
        durationMs: 1_500,
        sourceInMs: 0,
        sourceOutMs: 1_500,
        words: timed(3, 500),
      },
    ])
    const result = executeCommand(createEngine(state), createTrimClipCommand("cap-0", 0, 1_100))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const clip = captionClips(result.value.history.present)[0]
    expect(clip.durationMs).toBe(1_100)
    // Third word (1000..1400) overlaps the window — kept and clamped.
    expect(clip.words).toEqual([
      { text: "w0", startMs: 0, endMs: 400 },
      { text: "w1", startMs: 500, endMs: 900 },
      { text: "w2", startMs: 1_000, endMs: 1_100 },
    ])
  })

  it("range-delete keeps per-piece words rebased to each piece", () => {
    const state = withCaptions(makeState(), [
      {
        id: "cap-0",
        text: "one two three four five six",
        startMs: 0,
        durationMs: 6_000,
        sourceInMs: 0,
        sourceOutMs: 6_000,
        words: timed(6, 1_000),
      },
    ])
    const result = executeCommand(createEngine(state), createDeleteRangeCommand(2_000, 4_000))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const clips = captionClips(result.value.history.present).sort((a, b) => a.startMs - b.startMs)
    expect(clips).toHaveLength(2)
    expect(clips[0].text).toBe("one two")
    expect(clips[0].words?.map((x) => x.text)).toEqual(["w0", "w1"])
    expect(clips[1].text).toBe("five six")
    expect(clips[1].words?.map((x) => x.text)).toEqual(["w4", "w5"])
    // Right piece rebased to its own start (4000ms into the original clip).
    expect(clips[1].words![0].startMs).toBe(4_000 - 4_000)
    expect(clips[1].words![0].endMs).toBe(4_400 - 4_000)
  })
})

describe("createShiftCaptionsCommand", () => {
  it("emits a move-clips record and clamps the delta to -minStart", () => {
    const state = withCaptions(makeState(), [
      { id: "cap-0", startMs: 300 },
      { id: "cap-1", startMs: 2_000 },
    ])
    const track = captionsTrack(state)!
    const forward = createShiftCaptionsCommand(track, 500)
    expect(forward).toMatchObject({ kind: "move-clips", deltaMs: 500 })
    const backward = createShiftCaptionsCommand(track, -1_000)
    expect(backward).toMatchObject({ kind: "move-clips", deltaMs: -300 })
    // -300 lands cap-0 exactly at 0 — still a valid shift; only deltas that
    // clamp all the way to 0 (or pass 0) produce no command.
    expect(createShiftCaptionsCommand(track, -300)).toMatchObject({ deltaMs: -300 })
    expect(createShiftCaptionsCommand(track, 0)).toBeNull()
    const atZero = withCaptions(makeState(), [{ id: "cap-0", startMs: 0 }])
    expect(createShiftCaptionsCommand(captionsTrack(atZero)!, -500)).toBeNull()
  })

  it("the clamped shift applies cleanly through executeCommand", () => {
    const state = withCaptions(makeState(), [
      { id: "cap-0", startMs: 300 },
      { id: "cap-1", startMs: 2_000 },
    ])
    const command = createShiftCaptionsCommand(captionsTrack(state)!, -1_000)!
    const result = executeCommand(createEngine(state), command)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const starts = captionClips(result.value.history.present).map((clip) => clip.startMs)
    expect(starts).toEqual([0, 1_700])
  })
})

// --- Caption provenance + resync -------------------------------------------

/** Recording-owned audio clip on stream 1 covering container [0,10000]. */
function withAudio(state: TimelineState, clips: Partial<AudioClip>[]): TimelineState {
  const track: TimelineTrack = {
    id: "track:audio",
    kind: "audio",
    name: "Audio",
    muted: false,
    locked: false,
    solo: false,
    volume: 1,
    clips: clips.map(
      (clip, i): AudioClip =>
        ({
          id: `aud-${i}`,
          kind: "audio",
          assetId: "recording",
          streamIndex: 1,
          startMs: 0,
          durationMs: 10_000,
          sourceInMs: 0,
          sourceOutMs: 10_000,
          speed: 1,
          volume: 1,
          fadeInMs: 0,
          fadeOutMs: 0,
          ...clip,
        }) as AudioClip,
    ),
  }
  return { ...state, tracks: [...state.tracks, track] }
}

/**
 * AI cue "hello there world" whose display tokens were generated from
 * container [1000,2100] on stream 1 — timeline position [940,2260] follows
 * the identity audio placement (word times = container times here).
 */
function aiCue(overrides: Partial<CaptionClip> = {}): Partial<CaptionClip> {
  return {
    startMs: 940,
    durationMs: 1_320,
    sourceInMs: 1_000,
    sourceOutMs: 2_100,
    text: "hello there world",
    words: [
      { text: "hello", startMs: 60, endMs: 360 },
      { text: "there", startMs: 460, endMs: 760 },
      { text: "world", startMs: 860, endMs: 1_160 },
    ],
    sourceWords: [
      { text: "hello", startMs: 1_000, endMs: 1_300 },
      { text: "there", startMs: 1_400, endMs: 1_700 },
      { text: "world", startMs: 1_800, endMs: 2_100 },
    ],
    sourceStreamIndex: 1,
    ...overrides,
  }
}

/** words/sourceWords must stay index-aligned with the cue's display tokens. */
function expectAligned(clip: CaptionClip) {
  const tokens = captionWords(reflowCueText(clip.text))
  expect(clip.words).toHaveLength(tokens.length)
  expect(clip.sourceWords).toHaveLength(tokens.length)
}

describe("caption provenance through edits", () => {
  it("splits keep absolute sourceWords while words rebase to each piece", () => {
    const state = withAudio(withCaptions(makeState(), [aiCue()]), [{ id: "aud-0" }])
    // Split at t=1500 — lands between "there" and "world" tokens.
    const result = executeCommand(createEngine(state), createSplitClipCommand("cap-0", 1_500))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const clips = captionClips(result.value.history.present)
    expect(clips).toHaveLength(2)
    expectAligned(clips[0])
    expectAligned(clips[1])
    expect(clips[0].text).toBe("hello")
    expect(clips[0].sourceWords).toEqual([{ text: "hello", startMs: 1_000, endMs: 1_300 }])
    expect(clips[0].words).toEqual([{ text: "hello", startMs: 60, endMs: 360 }])
    expect(clips[0].sourceInMs).toBe(1_000)
    expect(clips[0].sourceOutMs).toBe(1_300)
    expect(clips[1].text).toBe("there world")
    // Absolute container times are verbatim — never rebased by the split.
    expect(clips[1].sourceWords).toEqual([
      { text: "there", startMs: 1_400, endMs: 1_700 },
      { text: "world", startMs: 1_800, endMs: 2_100 },
    ])
    // Container span, not the timeline position (right piece starts at 1500).
    expect(clips[1].sourceInMs).toBe(1_400)
    expect(clips[1].sourceOutMs).toBe(2_100)
    expect(clips[1].sourceStreamIndex).toBe(1)
  })

  it("trims keep sourceWords verbatim while words clamp to the window", () => {
    const state = withAudio(withCaptions(makeState(), [aiCue()]), [{ id: "aud-0" }])
    // Left-trim the caption edge to t=1460 — drops "hello" from the window.
    const result = executeCommand(
      createEngine(state),
      createTrimClipCommand("cap-0", 1_520, 2_100, { startMs: 1_460 }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [clip] = captionClips(result.value.history.present)
    expect(clip.startMs).toBe(1_460)
    expect(clip.durationMs).toBe(800)
    expect(clip.words).toEqual([
      { text: "there", startMs: 0, endMs: 240 },
      { text: "world", startMs: 340, endMs: 640 },
    ])
    // Provenance is absolute — trimming the cue edge never shifts it.
    expect(clip.sourceWords).toEqual([
      { text: "there", startMs: 1_400, endMs: 1_700 },
      { text: "world", startMs: 1_800, endMs: 2_100 },
    ])
    expect(clip.sourceInMs).toBe(1_400)
    expect(clip.sourceOutMs).toBe(2_100)
  })

  it("moves keep provenance untouched", () => {
    const state = withAudio(withCaptions(makeState(), [aiCue()]), [{ id: "aud-0" }])
    const result = executeCommand(createEngine(state), createMoveClipCommand("cap-0", 5_000))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [clip] = captionClips(result.value.history.present)
    expect(clip.startMs).toBe(5_000)
    expect(clip.sourceWords).toEqual([
      { text: "hello", startMs: 1_000, endMs: 1_300 },
      { text: "there", startMs: 1_400, endMs: 1_700 },
      { text: "world", startMs: 1_800, endMs: 2_100 },
    ])
    expect(clip.sourceInMs).toBe(1_000)
    expect(clip.sourceOutMs).toBe(2_100)
    expectAligned(clip)
  })

  it("range deletes partition words and sourceWords by the same token index set", () => {
    const state = withAudio(withCaptions(makeState(), [aiCue()]), [{ id: "aud-0" }])
    // Cut the middle of the cue's text span ([1460,1740] on the timeline).
    const result = executeCommand(createEngine(state), createDeleteRangeCommand(1_460, 1_740))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const clips = captionClips(result.value.history.present)
    for (const clip of clips) {
      expectAligned(clip)
      // Every kept token keeps its original container window verbatim.
      for (const src of clip.sourceWords ?? []) {
        expect(src.startMs).toBeGreaterThanOrEqual(1_000)
        expect(src.endMs).toBeLessThanOrEqual(2_100)
      }
    }
  })

  it("merges concatenate sourceWords verbatim when the stream matches", () => {
    const state = withAudio(
      withCaptions(makeState(), [
        aiCue({
          id: "cap-0",
          durationMs: 800,
          sourceOutMs: 1_300,
          text: "hello",
          words: [{ text: "hello", startMs: 60, endMs: 360 }],
          sourceWords: [{ text: "hello", startMs: 1_000, endMs: 1_300 }],
        }),
        {
          id: "cap-1",
          startMs: 1_740,
          durationMs: 800,
          sourceInMs: 1_400,
          sourceOutMs: 1_700,
          text: "there",
          words: [{ text: "there", startMs: 60, endMs: 360 }],
          sourceWords: [{ text: "there", startMs: 1_400, endMs: 1_700 }],
          sourceStreamIndex: 1,
        },
      ]),
      [{ id: "aud-0" }],
    )
    const result = executeCommand(
      createEngine(state),
      createMergeCaptionClipsCommand(["cap-0", "cap-1"]),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [clip] = captionClips(result.value.history.present)
    expect(clip.text).toBe("hello there")
    // Container times are absolute — the second cue's words are NOT rebased.
    expect(clip.sourceWords).toEqual([
      { text: "hello", startMs: 1_000, endMs: 1_300 },
      { text: "there", startMs: 1_400, endMs: 1_700 },
    ])
    expect(clip.words).toEqual([
      { text: "hello", startMs: 60, endMs: 360 },
      { text: "there", startMs: 860, endMs: 1_160 },
    ])
    expect(clip.sourceInMs).toBe(1_000)
    expect(clip.sourceOutMs).toBe(1_700)
    expectAligned(clip)
  })

  it("mixed-stream merges drop provenance instead of guessing", () => {
    const state = withAudio(
      withCaptions(makeState(), [
        aiCue({
          id: "cap-0",
          durationMs: 800,
          sourceOutMs: 1_300,
          text: "hello",
          words: [{ text: "hello", startMs: 60, endMs: 360 }],
          sourceWords: [{ text: "hello", startMs: 1_000, endMs: 1_300 }],
        }),
        {
          id: "cap-1",
          startMs: 1_740,
          durationMs: 800,
          sourceInMs: 1_400,
          sourceOutMs: 1_700,
          text: "there",
          words: [{ text: "there", startMs: 60, endMs: 360 }],
          sourceWords: [{ text: "there", startMs: 1_400, endMs: 1_700 }],
          sourceStreamIndex: 2,
        },
      ]),
      [{ id: "aud-0" }],
    )
    const result = executeCommand(
      createEngine(state),
      createMergeCaptionClipsCommand(["cap-0", "cap-1"]),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [clip] = captionClips(result.value.history.present)
    expect(clip.sourceWords).toBeUndefined()
    expect(clip.sourceStreamIndex).toBeUndefined()
    // Fallback to timeline base — the cue is manual for resync purposes.
    expect(clip.sourceInMs).toBe(clip.startMs)
    expect(clip.sourceOutMs).toBe(clip.startMs + clip.durationMs)
  })

  it("text edits clear timing fields and drop resyncability", () => {
    const state = withAudio(withCaptions(makeState(), [aiCue()]), [{ id: "aud-0" }])
    const result = executeCommand(
      createEngine(state),
      createUpdateCaptionClipCommand("cap-0", { text: "rewritten text" }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [clip] = captionClips(result.value.history.present)
    expect(clip.text).toBe("rewritten text")
    expect(clip.words).toBeUndefined()
    expect(clip.sourceWords).toBeUndefined()
    expect(clip.sourceStreamIndex).toBeUndefined()
    expect(clip.sourceInMs).toBe(clip.startMs)
    expect(clip.sourceOutMs).toBe(clip.startMs + clip.durationMs)
  })

  it("imports AI cues with container-base source fields and SRT cues with timeline base", () => {
    const result = executeCommand(
      createEngine(makeState()),
      createImportCaptionCuesCommand(
        [
          {
            id: "ai",
            startMs: 940,
            endMs: 2_260,
            text: "hello world",
            sourceWords: [
              { text: "hello", startMs: 1_000, endMs: 1_300 },
              { text: "world", startMs: 1_800, endMs: 2_100 },
            ],
            sourceStreamIndex: 1,
          },
          { id: "srt", startMs: 5_000, endMs: 6_000, text: "manual line" },
        ],
        {},
      ),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const clips = captionClips(result.value.history.present)
    expect(clips[0].sourceInMs).toBe(1_000)
    expect(clips[0].sourceOutMs).toBe(2_100)
    expect(clips[0].sourceStreamIndex).toBe(1)
    expect(clips[1].sourceInMs).toBe(5_000)
    expect(clips[1].sourceOutMs).toBe(6_000)
    expect(clips[1].sourceWords).toBeUndefined()
    expect(clips[1].sourceStreamIndex).toBeUndefined()
  })
})

describe("resync-caption-track", () => {
  it("re-times AI captions through the moved audio clip", () => {
    const state = withAudio(withCaptions(makeState(), [aiCue()]), [{ startMs: 2_000 }])
    expect(analyzeCaptionSync(state, captionsTrack(state)!)).toEqual({
      total: 1,
      displaced: 1,
      dropped: 0,
    })
    const result = executeCommand(
      createEngine(state),
      createResyncCaptionsCommand("track:captions"),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [clip] = captionClips(result.value.history.present)
    // "hello" lands at 2000+1000 → cue start 3000−lead.
    expect(clip.startMs).toBe(2_940)
    expect(clip.durationMs).toBe(1_320)
    expect(clip.text).toBe("hello there world")
    expect(clip.words).toEqual([
      { text: "hello", startMs: 60, endMs: 360 },
      { text: "there", startMs: 460, endMs: 760 },
      { text: "world", startMs: 860, endMs: 1_160 },
    ])
    // Container provenance and the source span stay absolute.
    expect(clip.sourceWords).toEqual([
      { text: "hello", startMs: 1_000, endMs: 1_300 },
      { text: "there", startMs: 1_400, endMs: 1_700 },
      { text: "world", startMs: 1_800, endMs: 2_100 },
    ])
    expect(clip.sourceInMs).toBe(1_000)
    expect(clip.sourceOutMs).toBe(2_100)
    // Staleness clears once aligned.
    const next = result.value.history.present
    expect(analyzeCaptionSync(next, captionsTrack(next)!)).toEqual({
      total: 1,
      displaced: 0,
      dropped: 0,
    })
  })

  it("drops cue words whose container range was trimmed away", () => {
    // Audio keeps only container [1500,10000] → "hello" is gone.
    const state = withAudio(withCaptions(makeState(), [aiCue()]), [
      { sourceInMs: 1_500, sourceOutMs: 10_000, durationMs: 8_500 },
    ])
    const result = executeCommand(
      createEngine(state),
      createResyncCaptionsCommand("track:captions"),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [clip] = captionClips(result.value.history.present)
    expect(clip.text).toBe("there world")
    // "there" lands at the clip start (clamped), then "world" at +300.
    expect(clip.words).toEqual([
      { text: "there", startMs: 0, endMs: 200 },
      { text: "world", startMs: 300, endMs: 600 },
    ])
    expect(clip.sourceWords).toEqual([
      { text: "there", startMs: 1_400, endMs: 1_700 },
      { text: "world", startMs: 1_800, endMs: 2_100 },
    ])
    expect(clip.sourceInMs).toBe(1_400)
    expect(clip.sourceOutMs).toBe(2_100)
    expectAligned(clip)
  })

  it("splits one cue into contiguous pieces across a mid-cue audio cut", () => {
    // a1 keeps src [0,1500] in place; a2 keeps src [1500,10000] moved to t=4000.
    const state = withAudio(withCaptions(makeState(), [aiCue()]), [
      { id: "a1", sourceInMs: 0, sourceOutMs: 1_500, durationMs: 1_500 },
      { id: "a2", sourceInMs: 1_500, sourceOutMs: 10_000, durationMs: 8_500, startMs: 4_000 },
    ])
    const result = executeCommand(
      createEngine(state),
      createResyncCaptionsCommand("track:captions"),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const clips = captionClips(result.value.history.present)
    expect(clips).toHaveLength(2)
    expect(clips[0].id).toBe("cap-0")
    expect(clips[1].id).toBe("cap-0:resync:1")
    expect(clips[0].text).toBe("hello")
    expect(clips[0].startMs).toBe(940)
    expect(clips[0].sourceWords).toEqual([{ text: "hello", startMs: 1_000, endMs: 1_300 }])
    expect(clips[1].text).toBe("there world")
    expect(clips[1].startMs).toBe(3_940)
    expect(clips[1].sourceWords).toEqual([
      { text: "there", startMs: 1_400, endMs: 1_700 },
      { text: "world", startMs: 1_800, endMs: 2_100 },
    ])
    for (const clip of clips) expectAligned(clip)
  })

  it("removes the cue when its audio coverage is gone entirely", () => {
    const state = withAudio(withCaptions(makeState(), [aiCue()]), [])
    const before = analyzeCaptionSync(state, captionsTrack(state)!)
    expect(before).toEqual({ total: 1, displaced: 0, dropped: 1 })
    const result = executeCommand(
      createEngine(state),
      createResyncCaptionsCommand("track:captions"),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(captionClips(result.value.history.present)).toHaveLength(0)
  })

  it("leaves manual cues untouched and drops rebuilt pieces that collide", () => {
    // Manual cue parked where the resynced cue would land (audio at t=2000
    // → the AI cue wants [2940,4260]).
    const state = withAudio(
      withCaptions(makeState(), [
        aiCue(),
        {
          id: "manual",
          startMs: 2_940,
          durationMs: 1_320,
          sourceInMs: 2_940,
          sourceOutMs: 4_260,
          text: "user pinned",
        },
      ]),
      [{ startMs: 2_000 }],
    )
    const result = executeCommand(
      createEngine(state),
      createResyncCaptionsCommand("track:captions"),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const clips = captionClips(result.value.history.present)
    // The colliding rebuilt piece dropped; the user-authored cue survives.
    expect(clips).toHaveLength(1)
    expect(clips[0].text).toBe("user pinned")
  })

  it("undoes as one step restoring the pre-resync clips", () => {
    const state = withAudio(withCaptions(makeState(), [aiCue()]), [{ startMs: 2_000 }])
    const engine = createEngine(state)
    const before = captionClips(engine.history.present)
    const applied = executeCommand(engine, createResyncCaptionsCommand("track:captions"))
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    const undone = undoCommand(applied.value)
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    expect(captionClips(undone.value.history.present)).toEqual(before)
  })

  it("deleting the audio clip first makes resync remove the orphaned cue", () => {
    const state = withAudio(withCaptions(makeState(), [aiCue()]), [{}])
    const engine = createEngine(state)
    const deleted = executeCommand(engine, createDeleteClipCommand("aud-0"))
    expect(deleted.ok).toBe(true)
    if (!deleted.ok) return
    const result = executeCommand(deleted.value, createResyncCaptionsCommand("track:captions"))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(captionClips(result.value.history.present)).toHaveLength(0)
  })
})
