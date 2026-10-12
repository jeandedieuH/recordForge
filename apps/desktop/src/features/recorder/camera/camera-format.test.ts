import { describe, expect, it } from "vitest"
import type { CameraCapturePlan } from "@recordforge/contracts"
import {
  estimateImpact,
  estimateMbPerMinute,
  estimateRecordingMinutes,
  formatBytes,
  formatDurationHuman,
  formatMbps,
  planSummary,
  resolutionLabel,
  AUDIO_PCM_KBPS_ESTIMATE,
} from "./camera-format"

const BASE_PLAN: CameraCapturePlan = {
  profileId: "camera-balanced",
  input: null,
  outputWidth: 1920,
  outputHeight: 1080,
  outputFps: 30,
  videoBitrateKbps: 6843,
  maxBitrateKbps: 10264,
  bufferKbps: 10264,
  crf: 21,
  limitedByCamera: false,
}

describe("camera-format", () => {
  it("labels common resolutions", () => {
    expect(resolutionLabel(1280, 720)).toBe("720p")
    expect(resolutionLabel(1920, 1080)).toBe("1080p")
    expect(resolutionLabel(2560, 1440)).toBe("1440p")
    expect(resolutionLabel(3840, 2160)).toBe("4K")
    expect(resolutionLabel(640, 480)).toBe("640x480")
  })

  it("formats kbps as approximate Mbps", () => {
    expect(formatMbps(6843)).toBe("≈ 6.8 Mbps")
    expect(formatMbps(3318)).toBe("≈ 3.3 Mbps")
    expect(formatMbps(24883)).toBe("≈ 24.9 Mbps")
  })

  it("estimates MB per minute from kbps", () => {
    // 6843 kbps * 60 s / 8 bits / 1000 = ~51.3 MB/min
    expect(estimateMbPerMinute(6843)).toBeCloseTo(51.3, 1)
  })

  it("estimates remaining recording minutes", () => {
    // 10 GiB free at ~51.3 MB/min -> about 199 min
    const minutes = estimateRecordingMinutes(10 * 1024 ** 3, 6843)
    expect(minutes).toBeGreaterThan(190)
    expect(minutes).toBeLessThan(210)
    // Mic adds the PCM estimate to the total rate.
    const withMic = estimateRecordingMinutes(10 * 1024 ** 3, 6843 + AUDIO_PCM_KBPS_ESTIMATE)
    expect(withMic).toBeLessThan(minutes)
    expect(estimateRecordingMinutes(0, 6843)).toBe(0)
    expect(estimateRecordingMinutes(1024 ** 3, 0)).toBe(Number.POSITIVE_INFINITY)
  })

  it("formats durations for humans", () => {
    expect(formatDurationHuman(42)).toBe("42 min")
    expect(formatDurationHuman(185)).toBe("3 h 5 min")
    expect(formatDurationHuman(120)).toBe("2 h")
    expect(formatDurationHuman(24 * 60)).toBe("24 h+")
    expect(formatDurationHuman(Number.POSITIVE_INFINITY)).toBe("24 h+")
  })

  it("formats bytes", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(1024 ** 2 * 3.5)).toBe("3.5 MB")
    expect(formatBytes(120 * 1024 ** 3)).toBe("120 GB")
  })

  it("estimates impact from pixel rate and encoder support", () => {
    const p720: CameraCapturePlan = { ...BASE_PLAN, outputWidth: 1280, outputHeight: 720 }
    const p4k: CameraCapturePlan = {
      ...BASE_PLAN,
      profileId: "camera-ultra",
      outputWidth: 3840,
      outputHeight: 2160,
    }
    const pHigh: CameraCapturePlan = { ...BASE_PLAN, profileId: "camera-high" }

    expect(estimateImpact(p720, true)).toBe("light")
    expect(estimateImpact(p720, false)).toBe("light")
    expect(estimateImpact(BASE_PLAN, true)).toBe("light")
    expect(estimateImpact(BASE_PLAN, false)).toBe("moderate")
    // camera-high bumps one level on software.
    expect(estimateImpact(pHigh, false)).toBe("heavy")
    expect(estimateImpact(p4k, true)).toBe("moderate")
    expect(estimateImpact(p4k, false)).toBe("heavy")
  })

  it("summarizes a plan or reports Auto", () => {
    expect(planSummary(BASE_PLAN)).toBe("1920×1080 · 30 fps")
    expect(planSummary({ ...BASE_PLAN, outputFps: 29.97 })).toBe("1920×1080 · 30 fps")
    expect(planSummary(null)).toBe("Auto")
    expect(planSummary(undefined)).toBe("Auto")
  })
})
