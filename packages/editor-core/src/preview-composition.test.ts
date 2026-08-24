import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  createCursorEngine,
  fitCursorPoint,
  mapCursorPointThroughZoom,
  normalizeCursorTelemetry,
} from "@recordforge/cursor-core"
import {
  cursorTelemetryFileSchema,
  defaultCursorSettings,
  timelineStateSchema,
  type TimelineState,
} from "@recordforge/domain"
import {
  buildFollowCursorKeyframes,
  buildFollowCursorMotionPlan,
  resolveFollowCursorMotionPlanTargetAtTime,
  resolveFollowCursorTargetAtTime,
  resolvePreviewComposition,
  zoomTransformToCss,
} from "./preview-composition"

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

  it("uses the adaptive motion plan for follow-cursor camera interpolation", () => {
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
    expect(middle?.x).toBeGreaterThan(Math.min(left?.x ?? 0, right?.x ?? 0))
    expect(middle?.x).toBeLessThan(Math.max(left?.x ?? 0, right?.x ?? 0))
  })

  it("preserves long follow paths with more than eleven adaptive spline segments", () => {
    const state = makeState()
    state.tracks[0]!.clips[0]!.durationMs = 12_000
    state.tracks[0]!.clips[0]!.sourceOutMs = 12_000
    const baseSegment = state.zoomSegments?.[0]
    if (!baseSegment) return
    const segment = {
      ...baseSegment,
      startMs: 0,
      durationMs: 12_000,
      scale: 2,
      target: { x: 480, y: 270, width: 960, height: 540 },
      transitionInMs: 0,
      transitionOutMs: 0,
      mode: "follow-cursor" as const,
    }
    state.zoomSegments = [segment]

    const followTelemetry = normalizeCursorTelemetry({
      ...telemetry,
      events: Array.from({ length: 121 }, (_, index) => {
        const timeMs = index * 100
        return event(
          timeMs,
          Math.round(960 + Math.sin(index * 0.22) * 650),
          Math.round(540 + Math.cos(index * 0.31) * 260),
        )
      }),
    })
    const cursorEngine = createCursorEngine(followTelemetry)
    const motionPlan = buildFollowCursorMotionPlan(segment, state, cursorEngine)

    expect(motionPlan).toBeDefined()
    if (!motionPlan) return
    expect(motionPlan.kind).toBe("cubic-bezier")
    expect(motionPlan.segments.length).toBeGreaterThan(10)
    expect(motionPlan.segments[0]?.startMs).toBe(0)
    expect(motionPlan.segments[motionPlan.segments.length - 1]?.endMs).toBe(12_000)
    for (let index = 1; index < motionPlan.segments.length; index++) {
      expect(motionPlan.segments[index]?.startMs).toBe(motionPlan.segments[index - 1]?.endMs)
    }

    const target = resolveFollowCursorTargetAtTime(segment, state, 6_500, cursorEngine)
    expect(target).toBeDefined()
    expect(target?.x).toBeGreaterThanOrEqual(0)
    expect(target?.y).toBeGreaterThanOrEqual(0)
    expect(target?.x).toBeLessThanOrEqual(state.canvas.width - (target?.width ?? 0))
    expect(target?.y).toBeLessThanOrEqual(state.canvas.height - (target?.height ?? 0))
  })

  it("keeps tight-turn follow motion within the simplification tolerance", () => {
    const state = makeState()
    state.canvas.cursorSettings = {
      ...defaultCursorSettings,
      smoothMovement: false,
    }
    const followPoints = [
      [600, 500],
      [700, 500],
      [800, 500],
      [900, 500],
      [1000, 500],
      [1100, 500],
      [1200, 500],
      [1300, 500],
      [1300, 600],
      [1300, 700],
      [1300, 800],
      [1300, 800],
    ]
    const durationMs = (followPoints.length - 1) * 100
    state.tracks[0]!.clips[0]!.durationMs = durationMs
    state.tracks[0]!.clips[0]!.sourceOutMs = durationMs
    const baseSegment = state.zoomSegments?.[0]
    if (!baseSegment) return
    const segment = {
      ...baseSegment,
      startMs: 0,
      durationMs,
      scale: 2,
      target: { x: 480, y: 270, width: 960, height: 540 },
      transitionInMs: 0,
      transitionOutMs: 0,
      mode: "follow-cursor" as const,
      followDeadzonePercent: 0,
      followSmoothingAlpha: 1,
    }
    state.zoomSegments = [segment]

    const followTelemetry = normalizeCursorTelemetry({
      ...telemetry,
      events: followPoints.map(([x, y], index) => event(index * 100, x, y)),
    })
    const cursorEngine = createCursorEngine(followTelemetry)
    const reference = buildFollowCursorKeyframes(segment, state, cursorEngine)
    const motionPlan = buildFollowCursorMotionPlan(segment, state, cursorEngine, {
      sampleStepMs: 100,
      tolerancePx: 2,
    })

    expect(motionPlan).toBeDefined()
    if (!motionPlan) return

    let maxError = 0
    for (const keyframe of reference) {
      const actual = resolveFollowCursorMotionPlanTargetAtTime(
        motionPlan,
        segment,
        state,
        keyframe.timeMs,
        cursorEngine,
      )
      expect(actual).toBeDefined()
      if (!actual) continue
      const actualCenter = {
        x: actual.x + actual.width / 2,
        y: actual.y + actual.height / 2,
      }
      const referenceCenter = {
        x: keyframe.target.x + keyframe.target.width / 2,
        y: keyframe.target.y + keyframe.target.height / 2,
      }
      maxError = Math.max(
        maxError,
        Math.hypot(actualCenter.x - referenceCenter.x, actualCenter.y - referenceCenter.y),
      )
    }

    expect(maxError).toBeLessThanOrEqual(2)
  })

  it("continues following a cursor that remains outside the camera deadzone", () => {
    const state = makeState()
    state.canvas.cursorSettings = {
      ...defaultCursorSettings,
      smoothMovement: false,
    }
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
      events: [
        event(0, 960, 540),
        event(4_000, 960, 540),
        event(4_100, 1_200, 540),
        event(4_200, 1_200, 540),
      ],
    })
    const cursorEngine = createCursorEngine(followTelemetry)

    const first = resolveFollowCursorTargetAtTime(segment, state, 4_100, cursorEngine)
    const second = resolveFollowCursorTargetAtTime(segment, state, 4_200, cursorEngine)

    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(second!.x).toBeGreaterThan(first!.x)
  })

  it("bridges adjacent follow segments from the previous camera endpoint", () => {
    const state = makeState()
    state.canvas.cursorSettings = {
      ...defaultCursorSettings,
      smoothMovement: false,
    }
    const previous = {
      id: "zoom-previous",
      startMs: 0,
      durationMs: 2_000,
      target: { x: 480, y: 270, width: 960, height: 540 },
      scale: 2,
      easing: "smooth" as const,
      transitionInMs: 0,
      transitionOutMs: 0,
      enabled: true,
      locked: false,
      mode: "follow-cursor" as const,
    }
    const current = {
      id: "zoom-current",
      startMs: 2_000,
      durationMs: 2_000,
      target: { x: 480, y: 270, width: 960, height: 540 },
      scale: 2,
      easing: "smooth" as const,
      transitionInMs: 400,
      transitionOutMs: 0,
      enabled: true,
      locked: false,
      mode: "follow-cursor" as const,
    }
    state.zoomSegments = [previous, current]
    const followTelemetry = normalizeCursorTelemetry({
      ...telemetry,
      events: [event(0, 960, 540), event(1_000, 1_400, 540), event(2_000, 1_400, 540)],
    })
    const cursorEngine = createCursorEngine(followTelemetry)
    const previousKeyframes = buildFollowCursorKeyframes(previous, state, cursorEngine)
    const previousTarget = previousKeyframes[previousKeyframes.length - 1]?.target
    const composition = resolvePreviewComposition(state, 2_000, { cursorEngine })

    expect(previousTarget).toBeDefined()
    expect(composition.screen.zoomTransform?.crop.x).toBeCloseTo(previousTarget?.x ?? 0, 5)
    expect(composition.screen.zoomTransform?.crop.y).toBeCloseTo(previousTarget?.y ?? 0, 5)
  })

  it("uses a pixel-precise matrix for the video crop transform", () => {
    const transform = {
      crop: { x: 480, y: 270, width: 960, height: 540 },
      scale: 2,
      progress: 1,
      translateX: 0,
      translateY: 0,
    }

    expect(
      zoomTransformToCss(transform, { width: 1920, height: 1080 }, { width: 900, height: 506.25 }),
    ).toBe("matrix(2, 0, 0, 2, -450, -253.125)")
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

interface GoldenPoint {
  x: number
  y: number
}

interface GoldenCrop extends GoldenPoint {
  width: number
  height: number
}

interface GoldenZoom {
  progress: number
  scale: number
  crop: GoldenCrop
}

interface GoldenFrameExpectation {
  sourceTimeMs: number
  sourcePoint: GoldenPoint
  zoom: GoldenZoom
  cursorPoint: GoldenPoint
}

interface GoldenFrame {
  timeMs: number
  expected: GoldenFrameExpectation
}

interface FractionalParityFixture {
  canvas: Record<string, unknown>
  timeline: Record<string, unknown>
  telemetry: unknown
  screenRect: {
    x: number
    y: number
    width: number
    height: number
  }
  frames: GoldenFrame[]
}

const fractionalParityFixturePath = fileURLToPath(
  new URL("../../../tooling/golden-fixtures/preview-rust-fractional-frame.json", import.meta.url),
)

function loadFractionalParityFixture(): FractionalParityFixture {
  return JSON.parse(readFileSync(fractionalParityFixturePath, "utf-8")) as FractionalParityFixture
}

describe("fractional preview/Rust golden frames", () => {
  it("matches the Rust golden crop and cursor geometry at fractional timestamps", () => {
    const fixture = loadFractionalParityFixture()
    const state = timelineStateSchema.parse({ ...fixture.timeline, canvas: fixture.canvas })
    const telemetry = cursorTelemetryFileSchema.parse(fixture.telemetry)
    const cursorEngine = createCursorEngine(telemetry)

    for (const { timeMs, expected } of fixture.frames) {
      expect(timeMs % 1).not.toBe(0)
      const composition = resolvePreviewComposition(state, timeMs, { cursorEngine })
      const frame = composition.cursor.frame
      const zoom = composition.screen.zoomTransform
      const sourceTimeMs = composition.cursor.sourceTimeMs
      if (!frame || !zoom || sourceTimeMs === null) {
        throw new Error(`missing preview frame at ${timeMs}ms`)
      }

      expect(sourceTimeMs).toBeCloseTo(expected.sourceTimeMs, 6)
      expect(frame.sourceX).toBeCloseTo(expected.sourcePoint.x, 6)
      expect(frame.sourceY).toBeCloseTo(expected.sourcePoint.y, 6)
      expect(zoom.progress).toBeCloseTo(expected.zoom.progress, 6)
      expect(zoom.scale).toBeCloseTo(expected.zoom.scale, 6)
      expect(zoom.crop.x).toBeCloseTo(expected.zoom.crop.x, 6)
      expect(zoom.crop.y).toBeCloseTo(expected.zoom.crop.y, 6)
      expect(zoom.crop.width).toBeCloseTo(expected.zoom.crop.width, 6)
      expect(zoom.crop.height).toBeCloseTo(expected.zoom.crop.height, 6)

      const fitted = fitCursorPoint(
        { x: frame.sourceX, y: frame.sourceY },
        telemetry,
        fixture.screenRect.width,
        fixture.screenRect.height,
      )
      const zoomed = mapCursorPointThroughZoom(
        { x: fitted.x, y: fitted.y },
        { width: fixture.screenRect.width, height: fixture.screenRect.height },
        { width: state.canvas.width, height: state.canvas.height },
        zoom,
      )
      const previewPoint = {
        x: fixture.screenRect.x + zoomed.x,
        y: fixture.screenRect.y + zoomed.y,
      }

      expect(previewPoint.x).toBeCloseTo(expected.cursorPoint.x, 6)
      expect(previewPoint.y).toBeCloseTo(expected.cursorPoint.y, 6)
    }
  })
})
