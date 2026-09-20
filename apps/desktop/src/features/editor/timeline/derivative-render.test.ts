import { describe, expect, it } from "vitest"
import {
  clipSourceTimeMs,
  displayAmplitude,
  filmstripFrameIndex,
  filmstripTileWidth,
  sampleWaveformEnvelope,
  visibleClipWindow,
  waveformNormalization,
  waveformWindowMs,
  type ClipTiming,
  type WaveformLike,
} from "./derivative-render"

const clip: ClipTiming = {
  startMs: 1000,
  durationMs: 2000,
  sourceInMs: 500,
  speed: 2,
}

describe("visibleClipWindow", () => {
  it("returns the clip∩viewport intersection", () => {
    expect(visibleClipWindow(clip, 0, 5000)).toEqual({ startMs: 1000, endMs: 3000 })
    expect(visibleClipWindow(clip, 1500, 2500)).toEqual({ startMs: 1500, endMs: 2500 })
  })

  it("returns null when the clip is outside the window", () => {
    expect(visibleClipWindow(clip, 4000, 5000)).toBeNull()
    expect(visibleClipWindow(clip, -500, 500)).toBeNull()
  })
})

describe("clipSourceTimeMs", () => {
  it("maps timeline time through trim offset and speed", () => {
    expect(clipSourceTimeMs(clip, 1000)).toBe(500)
    expect(clipSourceTimeMs(clip, 2000)).toBe(2500)
  })
})

describe("filmstripTileWidth", () => {
  it("keeps a constant screen-space pitch matched to clip height", () => {
    expect(filmstripTileWidth(52, 16 / 9)).toBe(92)
    expect(filmstripTileWidth(24, 16 / 9)).toBe(43)
  })

  it("clamps to sane bounds and survives bad input", () => {
    expect(filmstripTileWidth(500, 16 / 9)).toBe(240)
    expect(filmstripTileWidth(0, 0)).toBe(43)
    expect(filmstripTileWidth(Number.NaN, Number.NaN)).toBe(43)
  })
})

describe("filmstripFrameIndex", () => {
  it("selects the frame owning the instant (floor semantics)", () => {
    expect(filmstripFrameIndex(0, 1000, 10)).toBe(0)
    expect(filmstripFrameIndex(999, 1000, 10)).toBe(0)
    expect(filmstripFrameIndex(1000, 1000, 10)).toBe(1)
    expect(filmstripFrameIndex(2500, 500, 10)).toBe(5)
  })

  it("clamps to the available frame range", () => {
    expect(filmstripFrameIndex(999_999, 1000, 10)).toBe(9)
    expect(filmstripFrameIndex(-5, 1000, 10)).toBe(0)
  })

  it("returns -1 for an empty manifest", () => {
    expect(filmstripFrameIndex(0, 1000, 0)).toBe(-1)
  })
})

const waveform: WaveformLike = {
  sampleRate: 1000,
  samplesPerPeak: 20,
  peaks: [0.1, 0.9, 0.3, 0.5],
  mins: [-0.1, -0.8, -0.2, -0.4],
}

describe("waveformWindowMs", () => {
  it("converts samples-per-peak into milliseconds", () => {
    expect(waveformWindowMs(waveform)).toBe(20)
    expect(waveformWindowMs({ ...waveform, sampleRate: 0 })).toBe(100)
  })
})

describe("sampleWaveformEnvelope", () => {
  it("aggregates the full covered range when zoomed out", () => {
    // A column spanning peaks 0..4 keeps the loudest transient.
    expect(sampleWaveformEnvelope(waveform, 0, 4)).toEqual({ top: 0.9, bottom: -0.8 })
  })

  it("interpolates between peaks when zoomed past window resolution", () => {
    const { top, bottom } = sampleWaveformEnvelope(waveform, 0.25, 0.75)
    // midpoint f=0.5 → halfway between peak[0] and peak[1]
    expect(top).toBeCloseTo(0.5)
    expect(bottom).toBeCloseTo(-0.45)
  })

  it("mirrors peaks when no mins are stored (legacy files)", () => {
    const legacy: WaveformLike = { ...waveform, mins: undefined }
    expect(sampleWaveformEnvelope(legacy, 0, 2)).toEqual({ top: 0.9, bottom: -0.9 })
  })

  it("clamps ranges to the stored data", () => {
    expect(sampleWaveformEnvelope(waveform, -10, 100)).toEqual({ top: 0.9, bottom: -0.8 })
    expect(sampleWaveformEnvelope({ ...waveform, peaks: [] }, 0, 4)).toEqual({
      top: 0,
      bottom: 0,
    })
  })
})

describe("waveformNormalization", () => {
  it("uses the largest absolute excursion across both envelopes", () => {
    expect(waveformNormalization(waveform)).toBe(0.9)
    expect(waveformNormalization({ ...waveform, mins: [-1.2] })).toBe(1.2)
  })
})

describe("displayAmplitude", () => {
  it("maps full-scale input to 1 and applies the perceptual lift", () => {
    expect(displayAmplitude(0.9, 0.9)).toBe(1)
    expect(displayAmplitude(0, 0.9)).toBe(0)
    // Perceptual curve: half amplitude renders well above half height.
    expect(displayAmplitude(0.45, 0.9)).toBeGreaterThan(0.5)
  })

  it("never divides by zero", () => {
    expect(displayAmplitude(0.5, 0)).toBe(0)
  })
})
