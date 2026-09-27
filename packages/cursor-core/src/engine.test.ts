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

  it("uses event timestamps for smooth interpolation across irregular sample intervals", () => {
    const irregular = normalizeCursorTelemetry({
      recordingId: "irregular",
      sourceWidth: 1920,
      sourceHeight: 1080,
      sampleRateHz: 60,
      events: [
        v2Event(0, 0, 0, "none"),
        v2Event(10, 10, 0, "none"),
        v2Event(20, 20, 0, "none"),
        v2Event(120, 120, 0, "none"),
      ],
    })
    const engine = createCursorEngine(irregular)
    const frame = engine.evaluate(15, { ...defaultCursorSettings, smoothMovement: false })

    // A time-aware cubic path remains at the midpoint of the 10ms–20ms
    // interval; uniform Catmull-Rom would be pulled backward by the distant
    // 120ms sample.
    expect(frame.sourceX).toBeCloseTo(15, 5)
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
    // expand = 1-(1-p)^3 (ease-out cubic), fade = (1-p)^2 — shared with the
    // Rust engine and the export renderer.
    expect(mid.activeClicks[0].expand).toBeCloseTo(0.875)
    expect(mid.activeClicks[0].fade).toBeCloseTo(0.25)
    expect(atClick.activeClicks[0].expand).toBeCloseTo(0)
    expect(atClick.activeClicks[0].fade).toBeCloseTo(1)

    const later = engine.evaluate(500, settings)
    expect(later.activeClicks.length).toBe(0)
  })

  it("anchors the cursor position exactly at click events without phase lag offset", () => {
    const clickTelemetry = normalizeCursorTelemetry({
      recordingId: "click-test",
      sourceWidth: 1920,
      sourceHeight: 1080,
      sampleRateHz: 60,
      events: [
        v2Event(0, 0, 0, "none"),
        v2Event(100, 350, 200, "left-down", true),
        v2Event(200, 600, 400, "none"),
      ],
    })
    const engine = createCursorEngine(clickTelemetry)
    const settings = { ...defaultCursorSettings, smoothMovement: true, smoothFactor: 0.15 }

    // At exactly t = 100ms (the click event), the evaluated position MUST equal the click coordinate
    const atClick = engine.evaluate(100, settings)
    expect(atClick.sourceX).toBeCloseTo(350, 2)
    expect(atClick.sourceY).toBeCloseTo(200, 2)
    expect(atClick.activeClicks.length).toBe(1)
    expect(atClick.activeClicks[0].sourceX).toBeCloseTo(350, 2)
    expect(atClick.activeClicks[0].sourceY).toBeCloseTo(200, 2)
  })

  it("produces zero-phase symmetric deceleration when stopping", () => {
    const motionTelemetry = normalizeCursorTelemetry({
      recordingId: "motion-test",
      sourceWidth: 1920,
      sourceHeight: 1080,
      sampleRateHz: 60,
      events: [
        v2Event(0, 0, 0, "none"),
        v2Event(50, 50, 0, "none"),
        v2Event(100, 100, 0, "none"),
        v2Event(150, 100, 0, "none"),
        v2Event(200, 100, 0, "none"),
      ],
    })
    const engine = createCursorEngine(motionTelemetry)
    const settings = { ...defaultCursorSettings, smoothMovement: true, smoothFactor: 0.25 }

    // At t = 100ms when mouse reaches 100.0 and stops, zero-phase smoothing is responsive
    const atStop = engine.evaluate(100, settings)
    expect(atStop.sourceX).toBeGreaterThan(85)

    // At t = 50ms midpoint, position should be centered ~50.0
    const atMid = engine.evaluate(50, settings)
    expect(Math.abs(atMid.sourceX - 50)).toBeLessThan(10)
  })

  it("fits the source point to a target canvas consistently", () => {
    const engine = createCursorEngine(telemetry)
    const frame = engine.evaluate(100, defaultCursorSettings)
    const fitted = fitCursorPoint({ x: frame.sourceX, y: frame.sourceY }, telemetry, 1920, 1080)
    expect(fitted.visible).toBe(true)
    expect(fitted.x).toBeGreaterThanOrEqual(0)
    expect(fitted.y).toBeGreaterThanOrEqual(0)
  })

  it("calculates micro-press and spring clickScale", () => {
    const engine = createCursorEngine(telemetry)
    // t=90 before click (click is at t=100)
    expect(engine.evaluate(90, defaultCursorSettings).clickScale).toBeCloseTo(1.0, 3)
    // t=100 at click down
    expect(engine.evaluate(100, defaultCursorSettings).clickScale).toBeCloseTo(1.0, 3)
    // t=150 (50ms after click): peak ~0.86 compression
    expect(engine.evaluate(150, defaultCursorSettings).clickScale).toBeCloseTo(0.86, 2)
    // t=245 (145ms after click): spring rebound overshoot > 1.0
    const rebound = engine.evaluate(245, defaultCursorSettings).clickScale
    expect(rebound).toBeGreaterThan(1.01)
    expect(rebound).toBeLessThan(1.03)
    // t=320 (220ms after click): settled
    expect(engine.evaluate(320, defaultCursorSettings).clickScale).toBeCloseTo(1.0, 2)
    // When disabled
    const disabled = engine.evaluate(150, { ...defaultCursorSettings, clickPressAnimation: false })
    expect(disabled.clickScale).toBe(1.0)
  })

  it("stabilizes dwell and applies micro-tap dip in cinematic mode", () => {
    const movingEvents = []
    for (let t = 0; t <= 2000; t += 16) {
      const isClick = t === 1008
      movingEvents.push(
        v2Event(t, (t / 2000) * 1000, (t / 2000) * 500, isClick ? "left-down" : "none", isClick),
      )
    }
    const movingTelemetry = normalizeCursorTelemetry({
      recordingId: "moving-cinematic",
      sourceWidth: 1920,
      sourceHeight: 1080,
      sampleRateHz: 60,
      events: movingEvents,
    })
    const engine = createCursorEngine(movingTelemetry)
    const cinematic = {
      ...defaultCursorSettings,
      smoothMovement: true,
      smoothFactor: 0.15,
      clickPressAnimation: true,
    }

    // At click instant t = 1008
    const frameClick = engine.evaluate(1008, cinematic)
    expect(frameClick.sourceX).toBeCloseTo(504, 0)
    expect(frameClick.sourceY).toBeCloseTo(252, 0)

    // At t = 1048 (40ms after click), dwell anchors the cursor exactly on the
    // click position; the press is visual-only (clickScale), never a dip.
    const framePress = engine.evaluate(1048, cinematic)
    expect(framePress.clickScale).toBeLessThan(0.88)
    expect(framePress.sourceX).toBe(504)
    expect(framePress.sourceY).toBe(252)

    // When disabled, no press animation state is produced
    const frameNoPress = engine.evaluate(1048, { ...cinematic, clickPressAnimation: false })
    expect(frameNoPress.clickScale).toBe(1.0)
  })

  it("smooths the same path consistently at 60 Hz and 120 Hz", () => {
    // Zero-phase smoothing is driven by a fixed 60 Hz reference interval, so
    // the same preset must produce equivalent results at either capture rate.
    const curve = (t: number) => {
      const u = t / 2_000
      const s = u * u * (3 - 2 * u)
      return { x: 200 + 600 * s, y: 100 + 400 * s }
    }
    const build = (stepMs: number, rateHz: number) => {
      const events = []
      for (let t = 0; t <= 2_000; t += stepMs) {
        const tMs = Math.round(t)
        const { x, y } = curve(tMs)
        // rawX/rawY must be integers in the schema; the engine reads the
        // fractional sourceX/sourceY path the same way for both rates.
        events.push({
          ...v2Event(tMs, Math.round(x), Math.round(y), "none"),
          sourceX: x,
          sourceY: y,
        })
      }
      return createCursorEngine(
        normalizeCursorTelemetry({
          recordingId: "s-curve",
          sourceWidth: 1920,
          sourceHeight: 1080,
          sampleRateHz: rateHz,
          events,
        }),
        // Denoise disabled so only the smoothing rate can differ.
        { jitterThresholdPx: 0 },
      )
    }
    const engine60 = build(1_000 / 60, 60)
    const engine120 = build(1_000 / 120, 120)
    const settings = { ...defaultCursorSettings, smoothMovement: true, smoothFactor: 0.15 }

    for (const t of [400, 800, 1_000, 1_400, 1_800]) {
      const frame60 = engine60.evaluate(t, settings)
      const frame120 = engine120.evaluate(t, settings)
      expect(Math.abs(frame60.sourceX - frame120.sourceX)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(frame60.sourceY - frame120.sourceY)).toBeLessThanOrEqual(0.5)
    }
  })

  it("fades the cursor back in over 150ms when motion resumes after idle", () => {
    const idleTelemetry = normalizeCursorTelemetry({
      recordingId: "idle-resume",
      sourceWidth: 1000,
      sourceHeight: 500,
      events: [
        v2Event(0, 100, 100, "none"),
        v2Event(100, 200, 100, "none"),
        v2Event(5_000, 300, 100, "none"),
        v2Event(5_500, 400, 100, "none"),
      ],
    })
    const engine = createCursorEngine(idleTelemetry)
    const settings = {
      ...defaultCursorSettings,
      autoHideIdle: true,
      idleTimeoutMs: 1_000,
      smoothMovement: false,
    }

    // Long idle fades the cursor fully out.
    expect(engine.evaluate(4_900, settings).opacity).toBe(0)
    // Motion resumes at 5000: a stateless 150ms fade-in restores opacity.
    expect(engine.evaluate(5_000, settings).opacity).toBeCloseTo(0, 2)
    expect(engine.evaluate(5_075, settings).opacity).toBeCloseTo(0.5, 2)
    expect(engine.evaluate(5_150, settings).opacity).toBe(1)
  })

  it("keeps a stationary cursor exactly on the click point during the press window", () => {
    const stationary = normalizeCursorTelemetry({
      recordingId: "recording",
      sourceWidth: 1000,
      sourceHeight: 500,
      events: [
        v2Event(0, 350, 200, "none"),
        v2Event(100, 350, 200, "left-down", true),
        v2Event(300, 350, 200, "none"),
      ],
    })
    const engine = createCursorEngine(stationary)
    const settings = {
      ...defaultCursorSettings,
      smoothMovement: false,
      clickPressAnimation: true,
    }

    // 40ms into the press: clickScale is engaged, but the tip must not dip.
    const frame = engine.evaluate(140, settings)
    expect(frame.clickScale).toBeLessThan(1.0)
    expect(frame.sourceX).toBe(350)
    expect(frame.sourceY).toBe(200)
  })
})
