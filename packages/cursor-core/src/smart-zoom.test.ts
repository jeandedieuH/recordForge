import { describe, expect, it } from "vitest"
import { defaultCursorSettings, type TimelineCanvas } from "@recordforge/contracts"
import {
  analyzeCursorTelemetry,
  generateSmartZoomSuggestions,
  getCursorPointAtTimelineTime,
  normalizeCursorTelemetry,
  resolveInertialFollowCenter,
  zoomTargetForCursorPoint,
} from "./index"

const canvas: TimelineCanvas = {
  width: 1920,
  height: 1080,
  fps: 30,
  background: "#000000",
  padding: 48,
  borderRadius: 0,
  shadow: false,
  cursorSettings: defaultCursorSettings,
}

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
) => ({
  tMs,
  rawX: x,
  rawY: y,
  sourceX: x,
  sourceY: y,
  buttons: buttons(isLeft, isRight, isMiddle),
  buttonEvent,
  visible: true,
  shapeId: "arrow",
  shapeChanged: false,
})

const telemetry = normalizeCursorTelemetry({
  recordingId: "recording",
  sourceWidth: 1920,
  sourceHeight: 1080,
  events: [
    v2Event(0, 200, 180, "none"),
    v2Event(100, 960, 540, "left-down", true),
    v2Event(500, 960, 540, "none"),
    v2Event(1_200, 960, 540, "none"),
    v2Event(1_500, 1_700, 900, "none"),
    v2Event(2_000, 1_900, 1_060, "right-down", false, true),
    v2Event(15_000, 20, 30, "none"),
    v2Event(16_000, 20, 30, "none"),
    v2Event(17_500, 20, 30, "none"),
  ],
})

describe("smart zoom telemetry analysis", () => {
  it("extracts click, dwell, movement, and safe-edge features", () => {
    const features = analyzeCursorTelemetry(telemetry, { minDwellMs: 500 })

    expect(features.clicks).toHaveLength(2)
    expect(features.dwells.length).toBeGreaterThanOrEqual(2)
    expect(features.safeEdges[features.safeEdges.length - 1]).toEqual(
      expect.objectContaining({ nearLeft: true, nearTop: true }),
    )
  })

  it("generates aspect-ratio-aware, canvas-safe editable suggestions", () => {
    const suggestions = generateSmartZoomSuggestions(telemetry, canvas, {
      preset: "product-demo",
      minDwellMs: 500,
      includeDwells: true,
    })

    expect(suggestions.length).toBeGreaterThan(0)
    expect(suggestions.some((segment) => segment.source === "click")).toBe(true)
    expect(suggestions.some((segment) => segment.source === "dwell")).toBe(true)
    for (const segment of suggestions) {
      expect(segment.mode).toBeDefined()
      expect(segment.locked).toBe(false)
      expect(segment.target.x).toBeGreaterThanOrEqual(0)
      expect(segment.target.y).toBeGreaterThanOrEqual(0)
      expect(segment.target.x + segment.target.width).toBeLessThanOrEqual(canvas.width + 0.001)
      expect(segment.target.y + segment.target.height).toBeLessThanOrEqual(canvas.height + 0.001)
      expect(segment.target.width / segment.target.height).toBeCloseTo(
        canvas.width / canvas.height,
        5,
      )
    }
  })

  it("uses the selected preset transition profile unless an explicit transition is provided", () => {
    const singleClickTelemetry = normalizeCursorTelemetry({
      recordingId: "preset-transitions",
      sourceWidth: 1920,
      sourceHeight: 1080,
      events: [v2Event(3_000, 800, 600, "left-down", true)],
    })

    const cinematic = generateSmartZoomSuggestions(singleClickTelemetry, canvas, {
      preset: "cinematic",
    })
    expect(cinematic[0]?.transitionInMs).toBe(600)
    expect(cinematic[0]?.transitionOutMs).toBe(600)

    const custom = generateSmartZoomSuggestions(singleClickTelemetry, canvas, {
      preset: "cinematic",
      defaultTransitionInMs: 200,
      defaultTransitionOutMs: 250,
    })
    expect(custom[0]?.transitionInMs).toBe(200)
    expect(custom[0]?.transitionOutMs).toBe(250)
  })

  it("merges rapid clicks close in time into a single extended zoom without overlap", () => {
    const multiClickTelemetry = normalizeCursorTelemetry({
      recordingId: "multi-click",
      sourceWidth: 1920,
      sourceHeight: 1080,
      events: [
        v2Event(1_000, 500, 400, "left-down", true),
        v2Event(1_800, 520, 410, "left-down", true),
        v2Event(2_500, 510, 405, "left-down", true),
        v2Event(8_000, 1_400, 800, "left-down", true),
      ],
    })

    const suggestions = generateSmartZoomSuggestions(multiClickTelemetry, canvas, {
      preset: "product-demo",
      clusterToleranceMs: 2_000,
    })

    // Clicks at 1.0s, 1.8s, and 2.5s must be merged into ONE extended zoom segment
    expect(suggestions).toHaveLength(2)
    const cluster1 = suggestions[0]
    expect(cluster1.startMs).toBeLessThanOrEqual(1_000)
    expect(cluster1.startMs + cluster1.durationMs).toBeGreaterThan(2_500 + 800)

    // Strict invariant: no two generated zoom segments ever overlap
    for (let i = 0; i < suggestions.length - 1; i++) {
      const current = suggestions[i]
      const next = suggestions[i + 1]
      expect(current.startMs + current.durationMs).toBeLessThanOrEqual(next.startMs)
    }
  })

  it("ensures zoom transitions arrive and settle on target before the click occurs (perfect click sync)", () => {
    const clickTimeMs = 3_000
    const testTelemetry = normalizeCursorTelemetry({
      recordingId: "sync-test",
      sourceWidth: 1920,
      sourceHeight: 1080,
      events: [
        v2Event(1_000, 200, 200, "none"),
        v2Event(clickTimeMs, 800, 600, "left-down", true),
        v2Event(4_500, 800, 600, "none"),
      ],
    })

    const suggestions = generateSmartZoomSuggestions(testTelemetry, canvas, {
      preset: "product-demo",
    })

    expect(suggestions).toHaveLength(1)
    const zoom = suggestions[0]

    // Invariant: Transition-in must complete BEFORE the click occurs
    const fullySettledTimeMs = zoom.startMs + (zoom.transitionInMs ?? 380)
    expect(fullySettledTimeMs).toBeLessThanOrEqual(clickTimeMs)

    // Invariant: Zoom segment remains active after the click to frame the result
    expect(zoom.startMs + zoom.durationMs).toBeGreaterThan(clickTimeMs + 1_000)
  })

  it("returns no suggestions when the manual-only preset is selected", () => {
    expect(generateSmartZoomSuggestions(telemetry, canvas, { preset: "manual-only" })).toEqual([])
  })

  it("filters micro-movements within the soft deadzone and tracks large movements with resolveInertialFollowCenter", () => {
    const prevCenter = { x: 960, y: 540 }
    const viewportSize = { width: 960, height: 540 }

    // Small jitter: distance 15px (within 10% deadzone radius of ~54px)
    const jitterPoint = { x: 970, y: 545 }
    const centerAfterJitter = resolveInertialFollowCenter(jitterPoint, prevCenter, viewportSize, {
      deadzoneRadiusPercent: 0.1,
      smoothingAlpha: 0.35,
    })
    expect(centerAfterJitter).toEqual(prevCenter)

    // Large movement: distance 300px (well outside deadzone)
    const largeTravelPoint = { x: 1260, y: 740 }
    const centerAfterTravel = resolveInertialFollowCenter(
      largeTravelPoint,
      prevCenter,
      viewportSize,
      {
        deadzoneRadiusPercent: 0.1,
        smoothingAlpha: 0.35,
      },
    )
    expect(centerAfterTravel.x).toBeGreaterThan(prevCenter.x)
    expect(centerAfterTravel.y).toBeGreaterThan(prevCenter.y)
    expect(centerAfterTravel.x).toBeLessThan(largeTravelPoint.x)
    expect(centerAfterTravel.y).toBeLessThan(largeTravelPoint.y)
  })

  it("keeps a large cursor jump inside the follow camera viewport", () => {
    const cameraCenter = resolveInertialFollowCenter(
      { x: 1_900, y: 540 },
      { x: 960, y: 540 },
      { width: 960, height: 540 },
      { deadzoneRadiusPercent: 0.08, smoothingAlpha: 0.05 },
    )
    const target = zoomTargetForCursorPoint(cameraCenter, canvas, 2)

    expect(1_900).toBeGreaterThanOrEqual(target.x)
    expect(1_900).toBeLessThanOrEqual(target.x + target.width)
    expect(cameraCenter.x).toBeGreaterThan(960)
  })

  it("evaluates canvas-fitted cursor position at timeline time via getCursorPointAtTimelineTime", () => {
    const mockTimeline = {
      canvas,
      tracks: [
        {
          id: "screen",
          kind: "screen" as const,
          name: "Screen",
          muted: false,
          locked: false,
          solo: false,
          volume: 1,
          clips: [
            {
              id: "screen-clip",
              kind: "screen" as const,
              assetId: "recording",
              startMs: 0,
              durationMs: 3_000,
              sourceInMs: 0,
              sourceOutMs: 3_000,
              speed: 1,
            },
          ],
        },
      ],
    } as any

    const point = getCursorPointAtTimelineTime(mockTimeline, 100, telemetry)
    expect(point).not.toBeNull()
    expect(point?.x).toBe(960)
    expect(point?.y).toBe(540)
  })
})
