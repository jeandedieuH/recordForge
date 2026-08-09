import { describe, expect, it } from "vitest"
import { cursorTelemetryFileSchema, defaultCursorSettings } from "./cursor"
import { cursorEffectClipSchema } from "./timeline"

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
    expect(telemetry.assetId).toBe("cursor-events:recording-1")
    expect(telemetry.captureBounds).toMatchObject({ width: 1920, height: 1080 })
    expect(telemetry.timebase).toEqual({ unit: "ms", ticksPerSecond: 1000 })
  })

  it("distinguishes held samples from click edges", () => {
    const parsed = cursorTelemetryFileSchema.parse({
      recordingId: "recording-1",
      sourceWidth: 100,
      sourceHeight: 100,
      events: [
        { tMs: 0, x: 10, y: 10, button: "left", buttonEvent: "down", clicked: true },
        { tMs: 16, x: 10, y: 10, button: "left", buttonEvent: "held", clicked: false },
      ],
    })
    expect(parsed.events.map((event) => event.buttonEvent)).toEqual(["down", "held"])
  })

  it("accepts the durable cursor effect range shape", () => {
    const range = cursorEffectClipSchema.parse({
      id: "cursor-effect-default",
      kind: "cursor-effect",
      assetId: "asset-cursor-events",
      startMs: 0,
      durationMs: 9_000,
      presetId: "modern-neon",
      scale: 1.2,
      smoothing: "smooth",
      locked: false,
    })
    expect(range).toMatchObject({ durationMs: 9_000, presetId: "modern-neon" })
    expect(range.sourceOutMs).toBe(0)
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
