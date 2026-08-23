import { describe, expect, it } from "vitest"
import { createCursorEngine, normalizeCursorTelemetry } from "@recordforge/cursor-core"
import { defaultCursorSettings, type TimelineState } from "@recordforge/domain"
import { resolveFollowCursorTargetAtTime, resolvePreviewComposition } from "./preview-composition"

function makeState(): TimelineState {
  const now = "2026-08-10T00:00:00Z"
  return {
    version: 1,
    id: "comp-project",
    name: "Composition project",
    recordingId: "recording",
    canvas: {
      width: 1920,
      height: 1080,
      fps: 30,
      background: "#000000",
      padding: 48,
      borderRadius: 0,
      shadow: false,
      cursorSettings: defaultCursorSettings,
    },
    tracks: [
      {
        id: "screen",
        kind: "screen",
        name: "Screen",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "screen-clip",
            kind: "screen",
            assetId: "recording",
            startMs: 0,
            durationMs: 10_000,
            sourceInMs: 0,
            sourceOutMs: 10_000,
            speed: 1,
          },
        ],
      },
      {
        id: "camera",
        kind: "camera",
        name: "Camera",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "camera-clip",
            kind: "camera",
            assetId: "camera",
            startMs: 1_000,
            durationMs: 5_000,
            sourceInMs: 0,
            sourceOutMs: 5_000,
            speed: 1,
            transform: {
              x: 100,
              y: 100,
              width: 320,
              height: 180,
              opacity: 1,
              shape: "rectangle",
            },
          },
        ],
      },
      {
        id: "masks",
        kind: "effects",
        name: "Privacy",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "mask-clip",
            kind: "mask",
            assetId: "recording",
            startMs: 2_000,
            durationMs: 2_000,
            sourceInMs: 0,
            sourceOutMs: 2_000,
            speed: 1,
            mode: "blur",
            rect: { x: 1500, y: 40, width: 420, height: 240 },
            blurRadius: 24,
            pixelSize: 12,
            redactColor: "black",
            enabled: true,
          },
        ],
      },
      {
        id: "captions",
        kind: "captions",
        name: "Captions",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "caption-clip",
            kind: "caption",
            assetId: "captions",
            startMs: 3_000,
            durationMs: 2_000,
            sourceInMs: 0,
            sourceOutMs: 2_000,
            speed: 1,
            text: "Hello",
            style: "default",
            placement: "bottom",
            safeAreaMargin: 48,
          },
        ],
      },
      {
        id: "cursor",
        kind: "cursor",
        name: "Cursor",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "cursor-range",
            kind: "cursor-effect",
            assetId: "cursor-events:recording",
            startMs: 0,
            durationMs: 10_000,
            sourceInMs: 0,
            sourceOutMs: 0,
            speed: 1,
            presetId: "recorded-system",
            scale: 1,
            smoothing: "smooth",
            settings: {},
            enabled: true,
            locked: false,
          },
        ],
      },
    ],
    zoomSegments: [
      {
        id: "zoom-1",
        startMs: 4_000,
        durationMs: 2_000,
        target: { x: 480, y: 270, width: 960, height: 540 },
        scale: 1,
        easing: "linear",
        enabled: true,
        locked: false,
      },
    ],
    markers: [],
    createdAt: now,
    updatedAt: now,
  }
}

const event = (tMs: number, x: number, y: number) => ({
  tMs,
  rawX: x,
  rawY: y,
  sourceX: x,
  sourceY: y,
  buttons: { left: false, right: false, middle: false, x1: false, x2: false } as const,
  buttonEvent: "none" as const,
  visible: true,
  shapeId: "arrow",
  shapeChanged: false,
})

const telemetry = {
  schemaVersion: 2,
  assetId: "cursor-events:recording",
  recordingId: "recording",
  sourceWidth: 1920,
  sourceHeight: 1080,
  captureBounds: { x: 0, y: 0, width: 1920, height: 1080 },
  coordinateTransform: {
    a00: 1,
    a01: 0,
    a10: 0,
    a11: 1,
    b0: 0,
    b1: 0,
  },
  shapes: [],
  timebase: { unit: "ms" as const, ticksPerSecond: 1000 },
  sampleRateHz: 60,
  clickWindowMs: 350,
  health: "healthy" as const,
  eventCount: 2,
  index: [],
  eventFile: "cursor_events.bin",
  events: [event(0, 960, 540), event(3_000, 100, 100)],
}

describe("resolvePreviewComposition", () => {
  it("resolves a screen layer with source time and no zoom outside a zoom range", () => {
    const comp = resolvePreviewComposition(makeState(), 1_000)
    expect(comp.screen.active).toBe(true)
    expect(comp.screen.sourceMs).toBe(1_000)
    expect(comp.screen.zoomTransform).toBeNull()
    expect(comp.screen.isGap).toBe(false)
  })

  it("resolves an active zoom transform inside a zoom range", () => {
    const comp = resolvePreviewComposition(makeState(), 4_000)
    expect(comp.screen.zoomTransform).not.toBeNull()
    expect(comp.screen.zoomTransform?.progress).toBe(0)
    expect(comp.screen.zoomTransform?.scale).toBe(1)

    // At 5_000ms (within the 4_000ms-6_000ms zoom segment), it is in the sustained hold phase
    const mid = resolvePreviewComposition(makeState(), 5_000)
    expect(mid.screen.zoomTransform?.progress).toBe(1)
    expect(mid.screen.zoomTransform?.scale).toBeGreaterThan(1)

    // At 4_225ms (halfway through the 450ms lead-in transition), progress is ramping up
    const leadIn = resolvePreviewComposition(makeState(), 4_225)
    expect(leadIn.screen.zoomTransform?.progress).toBeGreaterThan(0)
    expect(leadIn.screen.zoomTransform?.progress).toBeLessThan(1)
  })

  it("uses the export sample grid for follow-cursor camera interpolation", () => {
    const state = makeState()
    const baseSegment = state.zoomSegments?.[0]
    if (!baseSegment) return
    const segment = {
      ...baseSegment,
      scale: 2,
      target: { x: 480, y: 270, width: 960, height: 540 },
      transitionInMs: 0,
      transitionOutMs: 0,
      mode: "follow-cursor" as const,
    }
    state.zoomSegments = [segment]

    const followTelemetry = normalizeCursorTelemetry({
      ...telemetry,
      events: [event(0, 960, 540), event(4_000, 960, 540), event(4_100, 1_600, 540)],
    })
    const cursorEngine = createCursorEngine(followTelemetry)

    const left = resolveFollowCursorTargetAtTime(segment, state, 4_000, cursorEngine)
    const right = resolveFollowCursorTargetAtTime(segment, state, 4_100, cursorEngine)
    const middle = resolveFollowCursorTargetAtTime(segment, state, 4_050, cursorEngine)

    expect(left).toBeDefined()
    expect(right).toBeDefined()
    expect(middle?.x).toBeCloseTo(((left?.x ?? 0) + (right?.x ?? 0)) / 2, 5)
  })

  it("marks inactive layers outside their clip ranges", () => {
    const comp = resolvePreviewComposition(makeState(), 500)
    expect(comp.cameras[0]?.active).toBe(false)
    expect(comp.masks[0]?.active).toBe(false)
    expect(comp.captions[0]?.active).toBe(false)
  })

  it("marks active layers inside their clip ranges", () => {
    const comp = resolvePreviewComposition(makeState(), 3_500)
    expect(comp.cameras[0]?.active).toBe(true)
    expect(comp.cameras[0]?.sourceMs).toBe(2_500)
    expect(comp.masks[0]?.active).toBe(true)
    expect(comp.captions[0]?.active).toBe(true)
  })

  it("clamps mask rectangles to the padded canvas safe area", () => {
    const comp = resolvePreviewComposition(makeState(), 3_000)
    const rect = comp.masks[0]!.rect
    expect(rect.x).toBeLessThanOrEqual(1920 - rect.width)
    expect(rect.y).toBeLessThanOrEqual(1080 - rect.height)
    expect(rect.width).toBeLessThanOrEqual(1920)
    expect(rect.height).toBeLessThanOrEqual(1080)
  })

  it("resolves cursor source time and settings from the cursor track", () => {
    const comp = resolvePreviewComposition(makeState(), 2_000, { cursorTelemetry: telemetry })
    expect(comp.cursor.active).toBe(true)
    expect(comp.cursor.sourceTimeMs).toBe(2_000)
    expect(comp.cursor.sourcePoint).not.toBeNull()
    expect(comp.cursor.settings.preset).toBe("recorded-system")
  })

  it("deactivates cursor when no screen clip is active", () => {
    const state = makeState()
    state.tracks[0]!.clips = []
    const comp = resolvePreviewComposition(state, 2_000, { cursorTelemetry: telemetry })
    expect(comp.cursor.active).toBe(false)
    expect(comp.cursor.sourceTimeMs).toBeNull()
  })

  it("produces a gap screen layer outside any screen clip", () => {
    const state = makeState()
    state.tracks[0]!.clips[0]!.durationMs = 1_000
    const comp = resolvePreviewComposition(state, 2_000)
    expect(comp.screen.active).toBe(false)
    expect(comp.screen.isGap).toBe(true)
  })
})
