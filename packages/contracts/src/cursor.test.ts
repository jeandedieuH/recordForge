import { describe, expect, it } from "vitest"
import { cursorTelemetryFileSchema, defaultCursorSettings } from "./cursor"

describe("cursor contracts", () => {
  it("keeps the custom cursor enabled by default", () => {
    expect(defaultCursorSettings.preset).toBe("modern-neon")
    expect(defaultCursorSettings.hideNativeCursor).toBe(true)
  })

  it("accepts telemetry emitted by the Rust tracker", () => {
    const telemetry = cursorTelemetryFileSchema.parse({
      recordingId: "recording-1",
      sourceWidth: 1920,
      sourceHeight: 1080,
      sampleRateHz: 60,
      events: [
        {
          tMs: 0,
          x: 320,
          y: 180,
          clicked: false,
          button: "none",
          visible: true,
        },
      ],
    })

    expect(telemetry.events[0]).toMatchObject({ x: 320, y: 180, visible: true })
  })

  it("rejects telemetry without valid source dimensions", () => {
    const result = cursorTelemetryFileSchema.safeParse({
      recordingId: "recording-1",
      sourceWidth: 0,
      sourceHeight: 1080,
      events: [],
    })

    expect(result.success).toBe(false)
  })
})
