import { describe, expect, it } from "vitest"
import { cursorTelemetryFileSchema, defaultCursorSettings } from "./cursor"
import { cursorEffectClipSchema } from "./timeline"

describe("cursor contracts", () => {
  it("keeps the custom cursor enabled by default", () => {
    expect(defaultCursorSettings.preset).toBe("recorded-system")
    expect(defaultCursorSettings.hideNativeCursor).toBe(true)
    expect(defaultCursorSettings.shapeMode).toBe("optimized")
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
          rawX: 320,
          rawY: 180,
          sourceX: 320,
          sourceY: 180,
          buttons: { left: false, right: false, middle: false, x1: false, x2: false },
          buttonEvent: "none",
          visible: true,
          shapeId: "arrow",
          shapeChanged: false,
        },
      ],
    })

    expect(telemetry.events[0]).toMatchObject({ sourceX: 320, sourceY: 180, visible: true })
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
        {
          tMs: 0,
          rawX: 10,
          rawY: 10,
          sourceX: 10,
          sourceY: 10,
          buttons: { left: true, right: false, middle: false, x1: false, x2: false },
          buttonEvent: "left-down",
          visible: true,
          shapeId: "arrow",
          shapeChanged: false,
        },
        {
          tMs: 16,
          rawX: 10,
          rawY: 10,
          sourceX: 10,
          sourceY: 10,
          buttons: { left: true, right: false, middle: false, x1: false, x2: false },
          buttonEvent: "left-held",
          visible: true,
          shapeId: "arrow",
          shapeChanged: false,
        },
      ],
    })
    expect(parsed.events.map((event) => event.buttonEvent)).toEqual(["left-down", "left-held"])
  })

  it("accepts the durable cursor effect range shape", () => {
    const range = cursorEffectClipSchema.parse({
      id: "cursor-effect-default",
      kind: "cursor-effect",
      assetId: "asset-cursor-events",
      startMs: 0,
      durationMs: 9_000,
      presetId: "recorded-system",
      scale: 1.2,
      smoothing: "smooth",
      locked: false,
    })
    expect(range).toMatchObject({ durationMs: 9_000, presetId: "recorded-system" })
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
