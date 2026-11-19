import { describe, expect, it } from "vitest"
import {
  defaultCursorSettings,
  type ManualZoomSegment,
  type MotionBlurSettings,
  type TimelineState,
} from "@recordforge/contracts"
import { createCursorEngine, normalizeCursorTelemetry } from "@recordforge/cursor-core"
import {
  MOTION_BLUR_PRESETS,
  detectMotionBlurPreset,
  effectiveShutterDegrees,
  findMotionBlurPreviewTarget,
  motionBlurTapWeight,
  resolveCursorMotionBlurSamples,
  resolveScreenMotionBlurStrip,
  scaleMotionBlurStrength,
} from "./motion-blur"

function makeState(
  motionBlur: MotionBlurSettings | undefined,
  zoomSegments: ManualZoomSegment[] = [],
  fps = 30,
): TimelineState {
  return {
    version: 1,
    id: "mb-test",
    name: "Motion Blur Test",
    recordingId: "rec-1",
    canvas: {
      width: 1920,
      height: 1080,
      fps,
      background: "#000000",
      padding: 0,
      borderRadius: 0,
      shadow: false,
      cursorSettings: { ...defaultCursorSettings, smoothMovement: false },
      motionBlur,
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
            assetId: "rec-1",
            startMs: 0,
            durationMs: 10_000,
            sourceInMs: 0,
            sourceOutMs: 10_000,
            speed: 1,
          },
        ],
      },
    ],
    markers: [],
    zoomSegments,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }
}

function makeZoomSegment(): ManualZoomSegment {
  return {
    id: "zoom-1",
    startMs: 1000,
    durationMs: 3000,
    scale: 2,
    target: { x: 100, y: 80, width: 960, height: 540 },
    easing: "linear",
    transitionInMs: 500,
    transitionOutMs: 500,
    enabled: true,
    locked: false,
    mode: "manual",
    source: "manual",
    preset: "product-demo",
  }
}

describe("motion-blur", () => {
  it("detects presets and scales strength proportionally while preserving channel ratios", () => {
    for (const preset of MOTION_BLUR_PRESETS) {
      const blur: MotionBlurSettings = { enabled: true, ...preset.settings }
      expect(detectMotionBlurPreset(blur)).toBe(preset.id)
      expect(effectiveShutterDegrees(blur)).toBe(preset.shutterDegrees)
    }

    const custom: MotionBlurSettings = { enabled: true, cursor: 0.8, zoom: 0.4, pan: 0.2 }
    expect(detectMotionBlurPreset(custom)).toBeNull()
    const scaled = scaleMotionBlurStrength(custom, 0.4)
    expect(scaled).toEqual({ enabled: true, cursor: 0.4, zoom: 0.2, pan: 0.1 })

    // Scaling up from all-zero restores balanced channels.
    const fromZero = scaleMotionBlurStrength({ enabled: true, cursor: 0, zoom: 0, pan: 0 }, 0.5)
    expect(fromZero).toEqual({ enabled: true, cursor: 0.5, zoom: 0.5, pan: 0.5 })
  })

  it("evaluates symmetric, axis-independent screen shutter strips deterministically", () => {
    const zoom = makeZoomSegment()

    // Disabled -> null
    const offState = makeState({ enabled: false, cursor: 0.5, zoom: 0.5, pan: 0.5 }, [zoom])
    expect(resolveScreenMotionBlurStrip(offState, 1250, { width: 1280, height: 720 })).toBeNull()

    // Still hold frame -> null (zero cost)
    const onState = makeState({ enabled: true, cursor: 0.5, zoom: 0.5, pan: 0.5 }, [zoom])
    expect(resolveScreenMotionBlurStrip(onState, 2500, { width: 1280, height: 720 })).toBeNull()

    // Mid-transition at 1250ms produces a real strip even on a single paused query.
    const strip = resolveScreenMotionBlurStrip(onState, 1250, { width: 1280, height: 720 })
    expect(strip).not.toBeNull()
    expect(strip!.taps).toBeGreaterThanOrEqual(3)
    expect(strip!.taps).toBeLessThanOrEqual(24)

    // Pan-only keeps crop width constant while sweeping center.
    const panOnly = makeState({ enabled: true, cursor: 0, zoom: 0, pan: 1 }, [zoom])
    const panStrip = resolveScreenMotionBlurStrip(panOnly, 1250, { width: 1280, height: 720 })
    expect(panStrip).not.toBeNull()
    expect(panStrip!.start[2]).toBeCloseTo(panStrip!.end[2], 5)
    expect(Math.abs(panStrip!.start[0] - panStrip!.end[0])).toBeGreaterThan(0.002)

    // Zoom-only keeps crop center fixed while sweeping width/height.
    const zoomOnly = makeState({ enabled: true, cursor: 0, zoom: 1, pan: 0 }, [zoom])
    const zoomStrip = resolveScreenMotionBlurStrip(zoomOnly, 1250, { width: 1280, height: 720 })
    expect(zoomStrip).not.toBeNull()
    const startCx = zoomStrip!.start[0] + zoomStrip!.start[2] * 0.5
    const endCx = zoomStrip!.end[0] + zoomStrip!.end[2] * 0.5
    expect(startCx).toBeCloseTo(endCx, 4)
    expect(Math.abs(zoomStrip!.start[2] - zoomStrip!.end[2])).toBeGreaterThan(0.01)
  })

  it("evaluates normalized cursor motion blur samples for fast cursor movement", () => {
    const telemetry = normalizeCursorTelemetry({
      schemaVersion: 1,
      recordingId: "rec-1",
      sourceWidth: 1920,
      sourceHeight: 1080,
      sampleRateHz: 60,
      events: Array.from({ length: 40 }, (_, i) => ({
        tMs: i * 16,
        rawX: 100 + i * 28,
        rawY: 500,
        sourceX: 100 + i * 28,
        sourceY: 500,
        buttons: { left: false, right: false, middle: false, x1: false, x2: false },
        buttonEvent: "none",
        visible: true,
        shapeId: "arrow",
        shapeChanged: false,
      })),
    })
    const engine = createCursorEngine(telemetry)
    const state = makeState({ enabled: true, cursor: 0.75, zoom: 0, pan: 0 })

    const samples = resolveCursorMotionBlurSamples(state, 300, engine, {
      width: 960,
      height: 540,
    })
    expect(samples.length).toBeGreaterThanOrEqual(3)
    const weightSum = samples.reduce((sum, s) => sum + s.weight, 0)
    expect(weightSum).toBeCloseTo(1, 5)
    // Samples travel monotonically right along X.
    expect(samples[samples.length - 1].x).toBeGreaterThan(samples[0].x + 5)

    // Turning cursor channel to 0 returns empty samples.
    const noCursor = makeState({ enabled: true, cursor: 0, zoom: 0.5, pan: 0.5 })
    expect(
      resolveCursorMotionBlurSamples(noCursor, 300, engine, { width: 960, height: 540 }),
    ).toEqual([])
  })

  it("finds the nearest motion preview timestamp for zoom transitions and fast cursor moves", () => {
    const zoom = makeZoomSegment()
    const state = makeState({ enabled: true, cursor: 0.5, zoom: 0.5, pan: 0.5 }, [zoom])
    const nearStart = findMotionBlurPreviewTarget(state, 200)
    expect(nearStart).toEqual({
      timeMs: 1250,
      source: "zoom",
      label: "Zoom transition",
    })
    const nearEnd = findMotionBlurPreviewTarget(state, 5000)
    expect(nearEnd).toEqual({
      timeMs: 3750,
      source: "zoom",
      label: "Zoom out",
    })

    // Tapered shutter weights are symmetric and center-peaked.
    expect(motionBlurTapWeight(0, 7)).toBeCloseTo(motionBlurTapWeight(6, 7), 6)
    expect(motionBlurTapWeight(3, 7)).toBeGreaterThan(motionBlurTapWeight(0, 7))
  })
})
