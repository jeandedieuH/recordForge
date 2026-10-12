import { describe, expect, it } from "vitest"
import { classifyCameraError } from "./use-camera-preview"
import { peakToLevel, smoothMeterLevel } from "./use-mic-level"

describe("classifyCameraError", () => {
  const domError = (name: string) => new DOMException("x", name)

  it("maps permission errors to blocked", () => {
    expect(classifyCameraError(domError("NotAllowedError"))).toBe("blocked")
    expect(classifyCameraError(domError("SecurityError"))).toBe("blocked")
  })

  it("maps device-busy errors to in-use", () => {
    expect(classifyCameraError(domError("NotReadableError"))).toBe("in-use")
    expect(classifyCameraError(domError("TrackStartError"))).toBe("in-use")
  })

  it("maps missing-device errors to unavailable", () => {
    // A device the store knows about but the browser can't open is
    // "preview unavailable", never "no camera" — empty is reserved for
    // when the store lists no cameras at all.
    expect(classifyCameraError(domError("NotFoundError"))).toBe("unavailable")
    expect(classifyCameraError(domError("OverconstrainedError"))).toBe("unavailable")
  })

  it("maps anything else to error", () => {
    expect(classifyCameraError(domError("AbortError"))).toBe("error")
    expect(classifyCameraError(new Error("boom"))).toBe("error")
    expect(classifyCameraError("string error")).toBe("error")
    expect(classifyCameraError(undefined)).toBe("error")
  })
})

describe("peakToLevel", () => {
  it("maps silence and clipping to the ends", () => {
    expect(peakToLevel(0)).toBe(0)
    expect(peakToLevel(1)).toBe(1)
    expect(peakToLevel(2)).toBe(1) // clamped
    expect(peakToLevel(Number.NaN)).toBe(0)
  })

  it("uses the -60 dB floor", () => {
    // -60 dBFS -> 0, -30 dBFS -> 0.5
    expect(peakToLevel(0.001)).toBeCloseTo(0, 1)
    expect(peakToLevel(10 ** -1.5)).toBeCloseTo(0.5, 2)
  })
})

describe("smoothMeterLevel", () => {
  it("attacks instantly and releases exponentially", () => {
    expect(smoothMeterLevel(0.2, 0.8)).toBe(0.8)
    expect(smoothMeterLevel(0.8, 0.2)).toBeCloseTo(0.68, 3)
    expect(smoothMeterLevel(0.8, 0.2, 0.5)).toBeCloseTo(0.4, 3)
  })
})
