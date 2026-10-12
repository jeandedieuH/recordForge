import { describe, expect, it } from "vitest"
import { matchDeviceLabel } from "./device-match"

describe("matchDeviceLabel", () => {
  it("matches identical names case-insensitively", () => {
    expect(matchDeviceLabel("Integrated Webcam", "integrated webcam")).toBe(true)
    expect(matchDeviceLabel("  Cam  ", "cam")).toBe(true)
  })

  it("matches substring variations", () => {
    expect(matchDeviceLabel("Logitech C920 HD Pro Webcam", "C920")).toBe(true)
    expect(matchDeviceLabel("C920", "Logitech C920 HD Pro Webcam")).toBe(true)
  })

  it("matches after stripping USB id suffixes", () => {
    // DirectShow "HD Webcam (0c45:6a09)" vs browser label "HD Webcam".
    expect(matchDeviceLabel("HD Webcam (0c45:6a09)", "HD Webcam")).toBe(true)
    expect(matchDeviceLabel("HD Webcam", "HD Webcam (0c45:6a09)")).toBe(true)
  })

  it("rejects empty or unrelated names", () => {
    expect(matchDeviceLabel("", "Webcam")).toBe(false)
    expect(matchDeviceLabel("Webcam", "")).toBe(false)
    expect(matchDeviceLabel("DroidCam Video", "Integrated Webcam")).toBe(false)
  })
})
