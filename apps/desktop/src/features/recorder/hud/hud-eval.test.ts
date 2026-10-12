import { describe, expect, it } from "vitest"
import type { CaptureDiagnostics } from "@recordforge/contracts"
import {
  CAPTURE_HEALTH_INITIAL,
  CAPTURE_HEALTH_MESSAGE,
  MIC_SILENCE_INITIAL,
  dismissCaptureHealth,
  dismissMicSilence,
  evaluateCaptureHealth,
  evaluateMicSilence,
  hudSourceLabel,
} from "./hud-eval"

const DIAGNOSTICS: CaptureDiagnostics = {
  processId: 1,
  encoder: "h264_nvenc",
  backend: "ffmpeg",
  requestedFps: 30,
  requestedCameraMode: null,
  fallbackReason: null,
  progress: { outputFrames: 300, outputFps: 30, speed: 1.0 },
  progressAgeMs: null,
  exited: false,
  startupReadyMs: null,
  previewFps: null,
  cameraFirstFrameOffsetMs: null,
  cameraTimingRejection: null,
}

describe("hudSourceLabel", () => {
  it("labels camera recordings with a video glyph", () => {
    const label = hudSourceLabel({
      state: "recording",
      sourceKind: "camera",
      sourceName: "Integrated Webcam",
    })
    expect(label).toEqual({ state: "Recording", name: "Integrated Webcam", glyph: "video" })
  })

  it("keeps screen sources unchanged", () => {
    const label = hudSourceLabel({
      state: "paused",
      sourceKind: "display",
      sourceName: "Display 1",
    })
    expect(label).toEqual({ state: "Paused", name: "Display 1", glyph: null })
    expect(hudSourceLabel(null).name).toBe("Screen capture")
  })
})

describe("evaluateMicSilence", () => {
  it("alarms after 8 s of continuous silence while recording", () => {
    let state = MIC_SILENCE_INITIAL
    for (let i = 0; i < 90; i++) {
      state = evaluateMicSilence(state, { listening: true, peak: 0, at: i * 100 })
    }
    expect(state.alarming).toBe(true)
  })

  it("respects real timestamps, not tick counts", () => {
    let state = evaluateMicSilence(MIC_SILENCE_INITIAL, { listening: true, peak: 0, at: 0 })
    state = evaluateMicSilence(state, { listening: true, peak: 0, at: 7_999 })
    expect(state.alarming).toBe(false)
    state = evaluateMicSilence(state, { listening: true, peak: 0, at: 8_000 })
    expect(state.alarming).toBe(true)
  })

  it("clears on real signal (hysteresis)", () => {
    let state = evaluateMicSilence(MIC_SILENCE_INITIAL, { listening: true, peak: 0, at: 0 })
    state = evaluateMicSilence(state, { listening: true, peak: 0, at: 10_000 })
    expect(state.alarming).toBe(true)
    // 0.002 is in the hysteresis band — keeps alarming.
    state = evaluateMicSilence(state, { listening: true, peak: 0.002, at: 10_100 })
    expect(state.alarming).toBe(true)
    state = evaluateMicSilence(state, { listening: true, peak: 0.01, at: 10_200 })
    expect(state.alarming).toBe(false)
    expect(state.silentSince).toBeNull()
  })

  it("resets the timer when paused/stopped but keeps the dismissal", () => {
    let state = evaluateMicSilence(MIC_SILENCE_INITIAL, { listening: true, peak: 0, at: 0 })
    state = evaluateMicSilence(state, { listening: true, peak: 0, at: 9_000 })
    expect(state.alarming).toBe(true)
    state = dismissMicSilence(state)
    expect(state.alarming).toBe(false)
    // Still silent — dismissal blocks re-alarming even past the threshold.
    state = evaluateMicSilence(state, { listening: true, peak: 0, at: 20_000 })
    expect(state.alarming).toBe(false)
    // Signal returns -> dismissal resets.
    state = evaluateMicSilence(state, { listening: true, peak: 0.01, at: 21_000 })
    expect(state.dismissed).toBe(false)
  })

  it("does not count silence while paused or mic inactive", () => {
    let state = evaluateMicSilence(MIC_SILENCE_INITIAL, { listening: false, peak: 0, at: 0 })
    state = evaluateMicSilence(state, { listening: false, peak: 0, at: 60_000 })
    expect(state.alarming).toBe(false)
  })
})

describe("evaluateCaptureHealth", () => {
  const input = (overrides: Partial<Parameters<typeof evaluateCaptureHealth>[1]> = {}) => ({
    at: 0,
    recording: true,
    recordingAgeMs: 30_000,
    diagnostics: DIAGNOSTICS,
    ...overrides,
  })

  it("degrades after 3 consecutive slow polls", () => {
    let state = CAPTURE_HEALTH_INITIAL
    const slow = {
      ...DIAGNOSTICS,
      progress: { ...DIAGNOSTICS.progress, speed: 0.5 },
    }
    for (let i = 0; i < 3; i++) {
      state = evaluateCaptureHealth(state, input({ diagnostics: slow }))
    }
    expect(state.degraded).toBe(true)
    expect(CAPTURE_HEALTH_MESSAGE).toContain("can't keep up")
  })

  it("degrades on output-fps starvation even at full speed", () => {
    let state = CAPTURE_HEALTH_INITIAL
    const starved = {
      ...DIAGNOSTICS,
      progress: { ...DIAGNOSTICS.progress, outputFps: 20 }, // < 0.85*30
    }
    for (let i = 0; i < 3; i++)
      state = evaluateCaptureHealth(state, input({ diagnostics: starved }))
    expect(state.degraded).toBe(true)
  })

  it("ignores missing counters and the first 3 s of recording", () => {
    let state = CAPTURE_HEALTH_INITIAL
    const noProgress = { ...DIAGNOSTICS, progress: { outputFps: null, speed: null } }
    for (let i = 0; i < 5; i++)
      state = evaluateCaptureHealth(state, input({ diagnostics: noProgress }))
    expect(state.degraded).toBe(false)
    const slow = { ...DIAGNOSTICS, progress: { ...DIAGNOSTICS.progress, speed: 0.1 } }
    for (let i = 0; i < 5; i++) {
      state = evaluateCaptureHealth(state, input({ recordingAgeMs: 1_000, diagnostics: slow }))
    }
    expect(state.degraded).toBe(false)
  })

  it("recovers after 3 healthy polls and clears dismissal", () => {
    let state = CAPTURE_HEALTH_INITIAL
    const slow = { ...DIAGNOSTICS, progress: { ...DIAGNOSTICS.progress, speed: 0.5 } }
    for (let i = 0; i < 3; i++) state = evaluateCaptureHealth(state, input({ diagnostics: slow }))
    expect(state.degraded).toBe(true)
    state = dismissCaptureHealth(state)
    for (let i = 0; i < 3; i++) state = evaluateCaptureHealth(state, input())
    expect(state.degraded).toBe(false)
    expect(state.dismissed).toBe(false)
  })

  it("resets counters when not recording", () => {
    let state = CAPTURE_HEALTH_INITIAL
    const slow = { ...DIAGNOSTICS, progress: { ...DIAGNOSTICS.progress, speed: 0.5 } }
    for (let i = 0; i < 2; i++) state = evaluateCaptureHealth(state, input({ diagnostics: slow }))
    state = evaluateCaptureHealth(state, input({ recording: false }))
    for (let i = 0; i < 2; i++) state = evaluateCaptureHealth(state, input({ diagnostics: slow }))
    expect(state.degraded).toBe(false) // only 2 bad polls after reset
  })
})
