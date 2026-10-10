import { describe, expect, it } from "vitest"
import { defaultCursorSettings, type CursorSettings } from "@recordforge/contracts"
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

interface PressSpec {
  button: "left" | "right" | "middle"
  downMs: number
  upMs: number
}

// Dense stationary telemetry at (500, 400) on a 1920x1080 source sampled
// every 8 ms (120 Hz), plus an event at every press edge. Samples inside a
// press carry `{button}-held` and the matching `buttons` flag.
const pressTelemetry = (presses: PressSpec[], durationMs = 4_000) => {
  const times = new Set<number>()
  for (let t = 0; t <= durationMs; t += 8) times.add(t)
  for (const press of presses) {
    times.add(press.downMs)
    times.add(press.upMs)
  }
  const events = [...times]
    .sort((left, right) => left - right)
    .map((tMs) => {
      let buttonEvent = "none"
      const state = { left: false, right: false, middle: false, x1: false, x2: false }
      for (const press of presses) {
        if (tMs === press.downMs) buttonEvent = `${press.button}-down`
        else if (tMs === press.upMs) buttonEvent = `${press.button}-up`
        else if (tMs > press.downMs && tMs < press.upMs) buttonEvent = `${press.button}-held`
        if (tMs >= press.downMs && tMs < press.upMs) state[press.button] = true
      }
      return {
        tMs,
        rawX: 500,
        rawY: 400,
        sourceX: 500,
        sourceY: 400,
        buttons: state,
        buttonEvent,
        visible: true,
        shapeId: "arrow",
        shapeChanged: false,
      }
    })
  return normalizeCursorTelemetry({
    recordingId: "press",
    sourceWidth: 1920,
    sourceHeight: 1080,
    sampleRateHz: 120,
    events,
  })
}

const engineAt = (presses: PressSpec[], durationMs = 4_000) =>
  createCursorEngine(pressTelemetry(presses, durationMs))

const expectScale = (
  engine: ReturnType<typeof createCursorEngine>,
  settings: CursorSettings,
  timeMs: number,
  expected: number,
  tolerance = 0.002,
) => {
  const actual = engine.evaluate(timeMs, settings).clickScale
  expect(
    Math.abs(actual - expected),
    `clickScale at ${timeMs}ms: expected ${expected}, got ${actual}`,
  ).toBeLessThanOrEqual(tolerance)
}

// Oracle for the canonical tap (down 1000, up 1090), computed from the
// closed-form spring reference implementation.
const TAP_ORACLE: [number, number][] = [
  [20, 0.9146],
  [50, 0.82],
  [90, 0.8004],
  [110, 0.819],
  [150, 0.9186],
  [200, 1.0208],
  [250, 1.0392],
  [300, 1.0148],
  [400, 0.9921],
  [500, 1.0012],
]

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

  it("matches the spring oracle for a canonical tap", () => {
    const engine = engineAt([{ button: "left", downMs: 1_000, upMs: 1_090 }])
    // Exactly 1.0 before and at the press edge.
    expect(engine.evaluate(999, defaultCursorSettings).clickScale).toBe(1.0)
    expect(engine.evaluate(1_000, defaultCursorSettings).clickScale).toBe(1.0)
    for (const [offset, expected] of TAP_ORACLE) {
      expectScale(engine, defaultCursorSettings, 1_000 + offset, expected)
    }

    // One soft overshoot peaking near 1.041 (~+237ms); the press bottoms out
    // at the held scale of 0.80.
    let peak = 0
    let trough = Number.MAX_VALUE
    for (let t = 0; t <= 900; t++) {
      const scale = engine.evaluate(1_000 + t, defaultCursorSettings).clickScale
      peak = Math.max(peak, scale)
      trough = Math.min(trough, scale)
    }
    expect(Math.abs(peak - 1.041)).toBeLessThanOrEqual(0.002)
    expect(trough).toBeGreaterThanOrEqual(0.7995)
    expect(trough).toBeLessThanOrEqual(0.801)

    // Exactly settled one settle window after the release edge.
    expect(engine.evaluate(1_790, defaultCursorSettings).clickScale).toBe(1.0)
    expect(engine.evaluate(2_500, defaultCursorSettings).clickScale).toBe(1.0)
  })

  it("returns 1.0 when the press animation is explicitly disabled", () => {
    const engine = engineAt([{ button: "left", downMs: 1_000, upMs: 1_090 }])
    const disabled = { ...defaultCursorSettings, clickPressAnimation: false }
    for (const t of [999, 1_000, 1_050, 1_150, 1_250, 2_000]) {
      expect(engine.evaluate(t, disabled).clickScale).toBe(1.0)
    }
  })

  it("treats a missing clickPressAnimation flag as enabled", () => {
    const engine = engineAt([{ button: "left", downMs: 1_000, upMs: 1_090 }])
    const withoutFlag: Partial<CursorSettings> = { ...defaultCursorSettings }
    delete withoutFlag.clickPressAnimation
    const settings = withoutFlag as CursorSettings
    expect(engine.evaluate(1_000, settings).clickScale).toBe(1.0)
    for (const [offset, expected] of TAP_ORACLE) {
      expectScale(engine, settings, 1_000 + offset, expected)
    }
  })

  it("stretches sub-frame taps to the minimum hold", () => {
    const canonical = engineAt([{ button: "left", downMs: 1_000, upMs: 1_090 }])
    // A one-sample tap (8 ms hold) produces the identical curve.
    const stretched = engineAt([{ button: "left", downMs: 1_000, upMs: 1_008 }])
    for (const offset of [0, 20, 50, 90, 150, 237, 400]) {
      expect(stretched.evaluate(1_000 + offset, defaultCursorSettings).clickScale).toBe(
        canonical.evaluate(1_000 + offset, defaultCursorSettings).clickScale,
      )
    }

    // A legacy single-sample press (`-down` then a plain sample 17 ms later)
    // produces the same curve shifted to its own start.
    const legacy = createCursorEngine(
      normalizeCursorTelemetry({
        recordingId: "legacy-press",
        sourceWidth: 1920,
        sourceHeight: 1080,
        sampleRateHz: 60,
        events: [
          v2Event(0, 500, 400, "none"),
          v2Event(100, 500, 400, "left-down", true),
          v2Event(117, 500, 400, "none"),
          v2Event(600, 500, 400, "none"),
        ],
      }),
    )
    for (const [offset, expected] of TAP_ORACLE) {
      expectScale(legacy, defaultCursorSettings, 100 + offset, expected)
    }
  })

  it("composes a double click without discontinuity", () => {
    // Effective ends are stretched to 1090 and 1240 by the minimum hold.
    const engine = engineAt([
      { button: "left", downMs: 1_000, upMs: 1_070 },
      { button: "left", downMs: 1_150, upMs: 1_220 },
    ])
    const oracle: [number, number][] = [
      [100, 0.8051],
      [120, 0.8395],
      [140, 0.8913],
      [149, 0.9159],
      [155, 0.9225],
      [170, 0.8821],
      [200, 0.8157],
      [230, 0.8014],
      [300, 0.9188],
      [400, 1.0392],
    ]
    for (const [offset, expected] of oracle) {
      expectScale(engine, defaultCursorSettings, 1_000 + offset, expected)
    }

    // Position and velocity carry across the second press edge (C1).
    const before = engine.evaluate(1_149.99, defaultCursorSettings).clickScale
    const after = engine.evaluate(1_150.01, defaultCursorSettings).clickScale
    expect(Math.abs(before - after)).toBeLessThan(1e-3)
  })

  it("holds the press scale for a whole drag and springs back on release", () => {
    const engine = engineAt([{ button: "left", downMs: 1_000, upMs: 2_500 }], 5_000)
    for (const offset of [100, 500, 1_000, 1_499, 1_500]) {
      const scale = engine.evaluate(1_000 + offset, defaultCursorSettings).clickScale
      expect(Math.abs(scale - 0.8), `held scale at +${offset}: ${scale}`).toBeLessThanOrEqual(0.001)
    }

    const releaseOracle: [number, number][] = [
      [1_550, 0.8926],
      [1_600, 1.008],
      [1_650, 1.0409],
      [1_700, 1.0201],
      [1_800, 0.9917],
      [2_000, 1.0007],
    ]
    for (const [offset, expected] of releaseOracle) {
      expectScale(engine, defaultCursorSettings, 1_000 + offset, expected)
    }
    expect(engine.evaluate(4_200, defaultCursorSettings).clickScale).toBe(1.0)
  })

  it("restarts from rest for presses separated by more than the settle window", () => {
    const engine = engineAt([
      { button: "left", downMs: 1_000, upMs: 1_090 },
      { button: "left", downMs: 3_000, upMs: 3_090 },
    ])
    // The second click replays the canonical curve exactly.
    const first = engine.evaluate(1_050, defaultCursorSettings).clickScale
    const second = engine.evaluate(3_050, defaultCursorSettings).clickScale
    expect(Math.abs(first - 0.82)).toBeLessThanOrEqual(0.002)
    expect(second).toBe(first)
  })

  it("follows the left/right button toggles while middle always animates", () => {
    const right = engineAt([{ button: "right", downMs: 1_000, upMs: 1_090 }])
    const rightOff = { ...defaultCursorSettings, rightClickEnabled: false }
    for (const t of [1_050, 1_100, 1_250, 1_500]) {
      expect(right.evaluate(t, rightOff).clickScale).toBe(1.0)
    }
    for (const [offset, expected] of TAP_ORACLE) {
      expectScale(right, defaultCursorSettings, 1_000 + offset, expected)
    }

    const left = engineAt([{ button: "left", downMs: 1_000, upMs: 1_090 }])
    const leftOff = { ...defaultCursorSettings, leftClickEnabled: false }
    for (const t of [1_050, 1_100, 1_250, 1_500]) {
      expect(left.evaluate(t, leftOff).clickScale).toBe(1.0)
    }

    const middle = engineAt([{ button: "middle", downMs: 1_000, upMs: 1_090 }])
    const bothOff = { ...defaultCursorSettings, leftClickEnabled: false, rightClickEnabled: false }
    for (const [offset, expected] of TAP_ORACLE) {
      expectScale(middle, bothOff, 1_000 + offset, expected)
    }
  })

  it("merges overlapping presses on different buttons into one hold", () => {
    const engine = engineAt([
      { button: "left", downMs: 1_000, upMs: 1_300 },
      { button: "right", downMs: 1_100, upMs: 1_200 },
    ])
    const held = engine.evaluate(1_250, defaultCursorSettings).clickScale
    expect(Math.abs(held - 0.8)).toBeLessThanOrEqual(0.002)
    // Release begins at the merged end (1300): +50 ms matches the drag
    // release oracle.
    expectScale(engine, defaultCursorSettings, 1_350, 0.8926)
  })

  it("closes an open press at a telemetry gap", () => {
    // Dense samples through 1008 with a press at 1000, then a silent gap
    // until 3000 where held samples resume until release at 3500.
    const events = []
    for (let t = 0; t <= 1_008; t += 8) {
      events.push(
        v2Event(
          t,
          500,
          400,
          t === 1_000 ? "left-down" : t > 1_000 ? "left-held" : "none",
          t >= 1_000,
        ),
      )
    }
    for (let t = 3_000; t < 3_500; t += 8) {
      events.push(v2Event(t, 500, 400, "left-held", true))
    }
    events.push(v2Event(3_500, 500, 400, "left-up"))
    events.push(v2Event(4_000, 500, 400, "none"))
    const engine = createCursorEngine(
      normalizeCursorTelemetry({
        recordingId: "gap-press",
        sourceWidth: 1920,
        sourceHeight: 1080,
        sampleRateHz: 120,
        events,
      }),
    )

    // The pre-gap press was closed at the last pre-gap sample (1008) and
    // stretched to 1090, so by 2000 the spring is long settled.
    expect(engine.evaluate(2_000, defaultCursorSettings).clickScale).toBe(1.0)
    // The held samples after the gap re-open the press.
    expect(
      Math.abs(engine.evaluate(3_200, defaultCursorSettings).clickScale - 0.8),
    ).toBeLessThanOrEqual(0.002)
    // A normal release follows the -up at 3500.
    expectScale(engine, defaultCursorSettings, 3_550, 0.8926)
  })

  it("is stateless: seek order never changes the evaluated scale", () => {
    const engine = engineAt([
      { button: "left", downMs: 1_000, upMs: 1_090 },
      { button: "right", downMs: 1_400, upMs: 1_600 },
      { button: "left", downMs: 2_000, upMs: 3_500 },
    ])
    const times = Array.from({ length: 40 }, (_, i) => 500 + i * 87.31)
    const expected = times.map((t) => engine.evaluate(t, defaultCursorSettings).clickScale)

    for (let i = times.length - 1; i >= 0; i--) {
      expect(engine.evaluate(times[i], defaultCursorSettings).clickScale).toBe(expected[i])
    }
    const order = times.map((_, index) => index)
    for (let i = order.length - 1; i > 0; i--) {
      const swap = (i * 31 + 7) % (i + 1)
      ;[order[i], order[swap]] = [order[swap], order[i]]
    }
    for (const index of order) {
      expect(engine.evaluate(times[index], defaultCursorSettings).clickScale).toBe(expected[index])
    }
  })

  it("stays bounded and finite through long press chains", () => {
    const presses: PressSpec[] = Array.from({ length: 300 }, (_, i) => ({
      button: "left" as const,
      downMs: i * 100,
      upMs: i * 100 + 40,
    }))
    const engine = engineAt(presses, 31_000)
    for (const t of [5_000, 14_950, 29_950, 30_500]) {
      const scale = engine.evaluate(t, defaultCursorSettings).clickScale
      expect(Number.isFinite(scale)).toBe(true)
      expect(scale).toBeGreaterThanOrEqual(0.5)
      expect(scale).toBeLessThanOrEqual(1.25)
    }
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
