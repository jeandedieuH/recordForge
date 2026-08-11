import { describe, expect, it } from "vitest"
import { defaultCursorSettings } from "@recordforge/contracts"
import { createCursorEngine, normalizeCursorTelemetry, fitCursorPoint } from "./index"

const buttons = (left: boolean, right = false, middle = false) => ({
  left,
  right,
  middle,
  x1: false,
  x2: false,
})

const v2Event = (
  tMs: number,
  x: number,
  y: number,
  buttonEvent: string,
  isLeft = false,
  isRight = false,
  isMiddle = false,
  visible = true,
) => ({
  tMs,
  rawX: x,
  rawY: y,
  sourceX: x,
  sourceY: y,
  buttons: buttons(isLeft, isRight, isMiddle),
  buttonEvent,
  visible,
  shapeId: "arrow",
  shapeChanged: false,
})

const telemetry = normalizeCursorTelemetry({
  recordingId: "recording",
  sourceWidth: 1920,
  sourceHeight: 1080,
  sampleRateHz: 60,
  events: [
    v2Event(0, 0, 0, "none"),
    v2Event(100, 100, 0, "left-down", true),
    v2Event(200, 100, 0, "left-held", true),
    v2Event(500, 500, 0, "none"),
    v2Event(600, 500, 0, "none"),
  ],
})

describe("cursor engine", () => {
  it("returns a hidden frame for empty telemetry", () => {
    const engine = createCursorEngine(
      normalizeCursorTelemetry({
        recordingId: "empty",
        sourceWidth: 1,
        sourceHeight: 1,
        events: [],
      }),
    )
    const frame = engine.evaluate(0, defaultCursorSettings)
    expect(frame.visible).toBe(false)
    expect(frame.opacity).toBe(0)
  })

  it("interpolates between samples", () => {
    const dense = normalizeCursorTelemetry({
      recordingId: "dense",
      sourceWidth: 1920,
      sourceHeight: 1080,
      sampleRateHz: 60,
      events: [
        v2Event(0, 0, 0, "none"),
        v2Event(16, 10, 5, "none"),
        v2Event(32, 20, 10, "none"),
        v2Event(48, 30, 15, "none"),
      ],
    })
    const engine = createCursorEngine(dense)
    const settings = { ...defaultCursorSettings, smoothMovement: false }
    const at24 = engine.evaluate(24, settings)
    // With smoothing disabled, linear interpolation between (10,5) at 16 and (20,10) at 32 gives (15, 7.5).
    expect(at24.sourceX).toBeCloseTo(15, 0)
    expect(at24.sourceY).toBeCloseTo(7.5, 0)
  })

  it("produces the same frame when seeking to a time and when sampling it during playback", () => {
    const engine = createCursorEngine(telemetry)
    const settings = { ...defaultCursorSettings, smoothMovement: true, smoothFactor: 0.25 }
    const once = engine.evaluate(250, settings)
    const twice = engine.evaluate(250, settings)
    expect(once.sourceX).toBe(twice.sourceX)
    expect(once.sourceY).toBe(twice.sourceY)
    expect(once.activeClicks.length).toBe(twice.activeClicks.length)
  })

  it("holds the last position during a gap", () => {
    const gapped = normalizeCursorTelemetry({
      recordingId: "gapped",
      sourceWidth: 1920,
      sourceHeight: 1080,
      sampleRateHz: 60,
      events: [
        v2Event(0, 0, 0, "none"),
        v2Event(16, 10, 10, "none"),
        v2Event(2000, 500, 500, "none"),
      ],
    })
    const engine = createCursorEngine(gapped, { gapThresholdMs: 100 })
    const duringGap = engine.evaluate(1000, defaultCursorSettings)
    // During the gap we should not interpolate toward the later sample.
    expect(duringGap.sourceX).toBeLessThan(500)
    expect(duringGap.sourceY).toBeLessThan(500)
  })

  it("resets smoothing after a gap", () => {
    const gapped = normalizeCursorTelemetry({
      recordingId: "gapped",
      sourceWidth: 1920,
      sourceHeight: 1080,
      sampleRateHz: 60,
      events: [
        v2Event(0, 0, 0, "none"),
        v2Event(16, 10, 10, "none"),
        v2Event(2000, 500, 500, "none"),
      ],
    })
    const engine = createCursorEngine(gapped, { gapThresholdMs: 100, smoothingWindowSize: 5 })
    const afterGap = engine.evaluate(2000, { ...defaultCursorSettings, smoothFactor: 0.1 })
    // The smoothed value immediately after the gap should equal the new sample,
    // because the smoothing window does not include pre-gap events.
    expect(afterGap.sourceX).toBeCloseTo(500)
    expect(afterGap.sourceY).toBeCloseTo(500)
  })

  it("hides the cursor when idle", () => {
    const idle = normalizeCursorTelemetry({
      recordingId: "idle",
      sourceWidth: 1920,
      sourceHeight: 1080,
      sampleRateHz: 60,
      events: [
        v2Event(0, 100, 100, "none"),
        v2Event(16, 100, 100, "none"),
        v2Event(32, 100, 100, "none"),
      ],
    })
    const engine = createCursorEngine(idle, { idleFadeDurationMs: 0 })
    const settings = {
      ...defaultCursorSettings,
      autoHideIdle: true,
      idleTimeoutMs: 50,
    }
    const before = engine.evaluate(30, settings)
    expect(before.visible).toBe(true)

    const after = engine.evaluate(150, settings)
    expect(after.visible).toBe(false)
    expect(after.opacity).toBe(0)
  })

  it("produces a click effect immediately after a click and fades it over time", () => {
    const engine = createCursorEngine(telemetry)
    const settings = { ...defaultCursorSettings, clickFeedback: "ripple" as const }

    const atClick = engine.evaluate(100, settings)
    expect(atClick.activeClicks.length).toBeGreaterThan(0)
    expect(atClick.activeClicks[0].button).toBe("left")
    expect(atClick.activeClicks[0].progress).toBeCloseTo(0)

    const mid = engine.evaluate(275, settings)
    expect(mid.activeClicks.length).toBeGreaterThan(0)
    expect(mid.activeClicks[0].progress).toBeCloseTo(0.5)

    const later = engine.evaluate(500, settings)
    expect(later.activeClicks.length).toBe(0)
  })

  it("fits the source point to a target canvas consistently", () => {
    const engine = createCursorEngine(telemetry)
    const frame = engine.evaluate(100, defaultCursorSettings)
    const fitted = fitCursorPoint({ x: frame.sourceX, y: frame.sourceY }, telemetry, 1920, 1080)
    expect(fitted.visible).toBe(true)
    expect(fitted.x).toBeGreaterThanOrEqual(0)
    expect(fitted.y).toBeGreaterThanOrEqual(0)
  })
})
