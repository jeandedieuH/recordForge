import { describe, expect, it } from "vitest"
import type { AudioClip, ScreenClip, TimelineState, TimelineTrack } from "@recordforge/contracts"
import {
  analyzeSilenceRanges,
  combinedWaveformEnvelope,
  estimateSilenceThresholdDb,
  mapSourceRangesToTimeline,
  type SmartCutWaveform,
} from "./smart-cut"

const WINDOW_MS = 20

// Build a waveform: `silentWindows` (source-ms spans) drop to 0 amplitude,
// everything else rides at a loud 0.5.
function makeWaveform(
  durationMs: number,
  silentSpans: { startMs: number; endMs: number }[] = [],
): SmartCutWaveform {
  const count = Math.ceil(durationMs / WINDOW_MS)
  const peaks: number[] = new Array(count).fill(0.5)
  for (const span of silentSpans) {
    for (
      let i = Math.floor(span.startMs / WINDOW_MS);
      i < Math.min(count, Math.ceil(span.endMs / WINDOW_MS));
      i++
    ) {
      peaks[i] = 0
    }
  }
  return { sampleRate: 1000, samplesPerPeak: WINDOW_MS, peaks }
}

function audioClip(partial: Partial<AudioClip> & { streamIndex?: number }): AudioClip {
  return {
    id: crypto.randomUUID(),
    assetId: "audio-asset",
    kind: "audio",
    startMs: 0,
    durationMs: 20_000,
    sourceInMs: 0,
    sourceOutMs: 20_000,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    streamIndex: 1,
    ...partial,
  } as AudioClip
}

function audioTrack(clips: AudioClip[], partial?: Partial<TimelineTrack>): TimelineTrack {
  return {
    id: crypto.randomUUID(),
    kind: "audio",
    name: "Microphone",
    muted: false,
    locked: false,
    solo: false,
    volume: 1,
    clips,
    ...partial,
  }
}

function makeState(tracks: TimelineTrack[]): TimelineState {
  return {
    version: 1,
    id: "tl",
    name: "t",
    recordingId: "rec",
    canvas: { width: 1920, height: 1080, fps: 30 } as TimelineState["canvas"],
    tracks,
    markers: [],
    zoomSegments: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  } as TimelineState
}

const screenTrack: TimelineTrack = {
  id: "screen",
  kind: "screen",
  name: "Screen",
  muted: false,
  locked: false,
  solo: false,
  volume: 1,
  clips: [
    {
      id: "s1",
      assetId: "screen-asset",
      kind: "screen",
      startMs: 0,
      durationMs: 20_000,
      sourceInMs: 0,
      sourceOutMs: 20_000,
      speed: 1,
    } as ScreenClip,
  ],
}

const OPTS = { thresholdDb: -40, minDurationMs: 500, paddingMs: 80 }

describe("analyzeSilenceRanges", () => {
  it("detects a silent window with edge padding applied", () => {
    const state = makeState([screenTrack, audioTrack([audioClip({})])])
    const waveforms = new Map([[1, makeWaveform(20_000, [{ startMs: 5_000, endMs: 10_000 }])]])

    const result = analyzeSilenceRanges(state, waveforms, OPTS)
    expect(result.ranges).toEqual([{ startMs: 5_080, endMs: 9_920 }])
    expect(result.removedMs).toBe(9_920 - 5_080)
    expect(result.audibleCoverageMs).toBe(20_000)
    expect(result.hasLockedBlockers).toBe(false)
  })

  it("only reports silence when EVERY covering capture stream is silent", () => {
    const state = makeState([
      screenTrack,
      audioTrack([audioClip({ streamIndex: 1 })]),
      audioTrack([audioClip({ streamIndex: 2 })]),
    ])
    const waveforms = new Map([
      [1, makeWaveform(20_000, [{ startMs: 5_000, endMs: 10_000 }])],
      [2, makeWaveform(20_000)], // system audio keeps playing through
    ])

    const result = analyzeSilenceRanges(state, waveforms, OPTS)
    expect(result.ranges).toEqual([])
  })

  it("intersects dual-stream silence and reports the shared dead air", () => {
    const state = makeState([
      screenTrack,
      audioTrack([audioClip({ streamIndex: 1 })]),
      audioTrack([audioClip({ streamIndex: 2 })]),
    ])
    const waveforms = new Map([
      [1, makeWaveform(20_000, [{ startMs: 5_000, endMs: 10_000 }])],
      [2, makeWaveform(20_000, [{ startMs: 7_000, endMs: 12_000 }])],
    ])

    const result = analyzeSilenceRanges(state, waveforms, OPTS)
    // Both silent in [7000, 10000] → padded to [7080, 9920].
    expect(result.ranges).toEqual([{ startMs: 7_080, endMs: 9_920 }])
  })

  it("respects clip trims — silence outside the clip's source window is ignored", () => {
    const state = makeState([
      screenTrack,
      audioTrack([audioClip({ sourceInMs: 5_000, sourceOutMs: 15_000, durationMs: 10_000 })]),
    ])
    const waveforms = new Map([
      [
        1,
        makeWaveform(20_000, [
          { startMs: 1_000, endMs: 4_000 }, // trimmed away — not on the timeline
          { startMs: 7_000, endMs: 9_000 },
        ]),
      ],
    ])

    const result = analyzeSilenceRanges(state, waveforms, OPTS)
    // Source 7000–9000 → timeline 2000–4000 → padded.
    expect(result.ranges).toEqual([{ startMs: 2_080, endMs: 3_920 }])
  })

  it("maps through clip speed changes", () => {
    const state = makeState([
      screenTrack,
      // 2× clip: 20 s of source plays in 10 s of timeline.
      audioTrack([audioClip({ speed: 2, sourceOutMs: 20_000, durationMs: 10_000 })]),
    ])
    const waveforms = new Map([[1, makeWaveform(20_000, [{ startMs: 6_000, endMs: 10_000 }])]])

    const result = analyzeSilenceRanges(state, waveforms, OPTS)
    // Source 6000–10000 → timeline 3000–5000 → padded.
    expect(result.ranges).toEqual([{ startMs: 3_080, endMs: 4_920 }])
  })

  it("ignores muted tracks entirely", () => {
    const state = makeState([screenTrack, audioTrack([audioClip({})], { muted: true })])
    const waveforms = new Map([[1, makeWaveform(20_000, [{ startMs: 5_000, endMs: 10_000 }])]])

    const result = analyzeSilenceRanges(state, waveforms, OPTS)
    expect(result.ranges).toEqual([])
    expect(result.audibleCoverageMs).toBe(0)
  })

  it("never cuts through a covered clip whose waveform is missing", () => {
    const state = makeState([
      screenTrack,
      audioTrack([audioClip({ streamIndex: 1, durationMs: 10_000, sourceOutMs: 10_000 })]),
      audioTrack([
        audioClip({ streamIndex: 9, startMs: 4_000, durationMs: 10_000, sourceOutMs: 10_000 }),
      ]),
    ])
    const waveforms = new Map([[1, makeWaveform(20_000, [{ startMs: 0, endMs: 10_000 }])]])

    const result = analyzeSilenceRanges(state, waveforms, OPTS)
    // 4000–10000 protected by the unanalyzable clip; only 0–4000 remains silent.
    expect(result.ranges).toEqual([{ startMs: 80, endMs: 3_920 }])
  })

  it("drops silences shorter than minDurationMs and ranges too small after padding", () => {
    const state = makeState([screenTrack, audioTrack([audioClip({})])])
    const waveforms = new Map([
      [
        1,
        makeWaveform(20_000, [
          { startMs: 1_000, endMs: 1_300 }, // 300 ms < 500 min
          { startMs: 5_000, endMs: 6_000 },
        ]),
      ],
    ])

    const result = analyzeSilenceRanges(state, waveforms, OPTS)
    expect(result.ranges).toEqual([{ startMs: 5_080, endMs: 5_920 }])
  })

  it("flags locked clips and locked tracks as blockers", () => {
    const lockedClipState = makeState([
      screenTrack,
      audioTrack([audioClip({ locked: true } as Partial<AudioClip>)]),
    ])
    const waveforms = new Map([[1, makeWaveform(20_000, [{ startMs: 5_000, endMs: 10_000 }])]])
    expect(analyzeSilenceRanges(lockedClipState, waveforms, OPTS).hasLockedBlockers).toBe(true)

    const lockedTrackState = makeState([screenTrack, audioTrack([audioClip({})], { locked: true })])
    expect(analyzeSilenceRanges(lockedTrackState, waveforms, OPTS).hasLockedBlockers).toBe(true)
  })

  it("excludes imported audio clips that carry no stream index", () => {
    const state = makeState([
      screenTrack,
      audioTrack([audioClip({})]),
      // Imported music asset — clip has no streamIndex, so it neither covers
      // nor vetoes anything.
      audioTrack([audioClip({ streamIndex: undefined })]),
    ])
    const waveforms = new Map([[1, makeWaveform(20_000, [{ startMs: 5_000, endMs: 10_000 }])]])

    const result = analyzeSilenceRanges(state, waveforms, OPTS)
    expect(result.ranges).toEqual([{ startMs: 5_080, endMs: 9_920 }])
  })
})

describe("estimateSilenceThresholdDb", () => {
  it("sits ~12 dB above the low-percentile noise floor", () => {
    // Noise floor of 0.01 → threshold = 20*log10(0.04) ≈ -28.
    const quiet = makeWaveform(10_000, [])
    quiet.peaks = quiet.peaks.map((_, i) => (i % 5 === 0 ? 0.4 : 0.01))
    const estimate = estimateSilenceThresholdDb([quiet])
    expect(estimate).toBeGreaterThanOrEqual(-30)
    expect(estimate).toBeLessThanOrEqual(-26)
  })

  it("clamps into the usable range for very quiet and loud content", () => {
    const silent = makeWaveform(5_000, [{ startMs: 0, endMs: 5_000 }])
    expect(estimateSilenceThresholdDb([silent])).toBe(-58)
    const loud: SmartCutWaveform = { sampleRate: 1000, samplesPerPeak: 20, peaks: [0.9] }
    expect(estimateSilenceThresholdDb([loud])).toBe(-24)
    expect(estimateSilenceThresholdDb([])).toBe(-38)
  })
})

describe("mapSourceRangesToTimeline", () => {
  it("maps source-time ranges through trim and speed for the ffmpeg fallback", () => {
    const state = makeState([
      screenTrack,
      audioTrack([
        audioClip({ startMs: 2_000, sourceInMs: 5_000, sourceOutMs: 15_000, durationMs: 10_000 }),
      ]),
    ])

    const mapped = mapSourceRangesToTimeline(
      state,
      [
        { startMs: 4_000, endMs: 6_000 }, // partially outside coverage
        { startMs: 8_000, endMs: 9_000 },
      ],
      { paddingMs: 100 },
    )
    // [5000..6000] → timeline 2000–3000, [8000..9000] → timeline 5000–6000.
    expect(mapped).toEqual([
      { startMs: 2_100, endMs: 2_900 },
      { startMs: 5_100, endMs: 5_900 },
    ])
  })
})

describe("combinedWaveformEnvelope", () => {
  it("takes the max across streams at the finest window resolution", () => {
    const a = makeWaveform(1_000, [{ startMs: 0, endMs: 500 }])
    const b = makeWaveform(1_000, [{ startMs: 500, endMs: 1_000 }])
    const { windowMs, amplitudes } = combinedWaveformEnvelope([a, b])
    expect(windowMs).toBe(WINDOW_MS)
    expect(amplitudes.length).toBe(50)
    expect(amplitudes[0]).toBe(0.5) // b is loud in the first half
    expect(amplitudes[49]).toBe(0.5) // a is loud in the second half
  })
})
