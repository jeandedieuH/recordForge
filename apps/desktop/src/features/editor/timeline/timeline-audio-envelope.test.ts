import { describe, expect, it } from "vitest"
import type { AudioClip, AudioVolumeKeyframe } from "@recordforge/contracts"
import { evaluateVolumeEnvelope } from "@recordforge/editor-core"

function createAudioClip(partial?: Partial<AudioClip>): AudioClip {
  return {
    id: "clip-audio-test",
    kind: "audio",
    assetId: "asset-1",
    startMs: 0,
    durationMs: 10000,
    sourceInMs: 0,
    sourceOutMs: 10000,
    speed: 1,
    volume: 1,
    fadeInMs: 1000,
    fadeOutMs: 2000,
    ...partial,
  }
}

describe("evaluateVolumeEnvelope", () => {
  it("returns 0 outside clip boundaries", () => {
    const clip = createAudioClip()
    expect(evaluateVolumeEnvelope(clip, -100)).toBe(0)
    expect(evaluateVolumeEnvelope(clip, 10500)).toBe(0)
  })

  it("evaluates fade-in ramp smoothly", () => {
    const clip = createAudioClip({ volume: 1, fadeInMs: 1000 })
    // At t=0, volume is 0
    expect(evaluateVolumeEnvelope(clip, 0)).toBeCloseTo(0, 2)
    // At t=500, volume is 0.5
    expect(evaluateVolumeEnvelope(clip, 500)).toBeCloseTo(0.5, 2)
    // At t=1000, volume reaches full 1.0
    expect(evaluateVolumeEnvelope(clip, 1000)).toBeCloseTo(1.0, 2)
  })

  it("evaluates sustained volume mid-clip", () => {
    const clip = createAudioClip({ volume: 1.5, fadeInMs: 1000, fadeOutMs: 2000 })
    // Between 1000ms and 8000ms, volume stays at 1.5
    expect(evaluateVolumeEnvelope(clip, 3000)).toBeCloseTo(1.5, 2)
    expect(evaluateVolumeEnvelope(clip, 5000)).toBeCloseTo(1.5, 2)
    expect(evaluateVolumeEnvelope(clip, 8000)).toBeCloseTo(1.5, 2)
  })

  it("evaluates fade-out ramp smoothly", () => {
    const clip = createAudioClip({ volume: 1, durationMs: 10000, fadeOutMs: 2000 })
    // Fade out begins at 8000ms
    expect(evaluateVolumeEnvelope(clip, 8000)).toBeCloseTo(1.0, 2)
    // Halfway through fade out at 9000ms: 0.5
    expect(evaluateVolumeEnvelope(clip, 9000)).toBeCloseTo(0.5, 2)
    // At end (10000ms): 0
    expect(evaluateVolumeEnvelope(clip, 10000)).toBeCloseTo(0, 2)
  })

  it("interpolates custom volume keyframes linearly", () => {
    const keyframes: AudioVolumeKeyframe[] = [
      { id: "k1", timeMs: 2000, volume: 0.4 },
      { id: "k2", timeMs: 6000, volume: 1.6 },
    ]
    const clip = createAudioClip({
      durationMs: 10000,
      fadeInMs: 0,
      fadeOutMs: 0,
      volumeKeyframes: keyframes,
    })

    // Before first keyframe
    expect(evaluateVolumeEnvelope(clip, 1000)).toBeCloseTo(0.4, 2)
    // Exactly at first keyframe
    expect(evaluateVolumeEnvelope(clip, 2000)).toBeCloseTo(0.4, 2)
    // Halfway between k1 and k2 (4000ms): (0.4 + 1.6) / 2 = 1.0
    expect(evaluateVolumeEnvelope(clip, 4000)).toBeCloseTo(1.0, 2)
    // Exactly at second keyframe
    expect(evaluateVolumeEnvelope(clip, 6000)).toBeCloseTo(1.6, 2)
    // After second keyframe
    expect(evaluateVolumeEnvelope(clip, 8000)).toBeCloseTo(1.6, 2)
  })
})
