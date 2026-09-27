import { describe, expect, it } from "vitest"
import {
  defaultCursorSettings,
  type ManualZoomSegment,
  type TimelineState,
} from "@recordforge/contracts"
import {
  canonicalizeZoomTarget,
  createCursorEngine,
  normalizeCursorTelemetry,
} from "@recordforge/cursor-core"
import { ZOOM_BRIDGE_GAP_MS, resolveCameraShots } from "./camera-shots"
import { resolvePreviewComposition } from "./preview-composition"

function makeState(zoomSegments: ManualZoomSegment[]): TimelineState {
  return {
    version: 1,
    id: "camera-shots-project",
    name: "Camera shots",
    recordingId: "recording",
    canvas: {
      width: 1920,
      height: 1080,
      fps: 60,
      background: "#000000",
      padding: 0,
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
            durationMs: 20_000,
            sourceInMs: 0,
            sourceOutMs: 20_000,
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

function zoomSegment(
  id: string,
  startMs: number,
  durationMs: number,
  target: ManualZoomSegment["target"],
  overrides: Partial<ManualZoomSegment> = {},
): ManualZoomSegment {
  return {
    id,
    startMs,
    durationMs,
    target,
    scale: 2,
    easing: "smooth",
    transitionInMs: 300,
    transitionOutMs: 300,
    enabled: true,
    locked: false,
    ...overrides,
  }
}

const targetA = { x: 100, y: 100, width: 800, height: 450 }
const targetB = { x: 400, y: 300, width: 800, height: 450 }
const targetC = { x: 900, y: 100, width: 800, height: 450 }

describe("resolveCameraShots", () => {
  it("extends a shot through a gap below the bridge threshold and drops its zoom-out", () => {
    const state = makeState([
      zoomSegment("a", 1_000, 2_000, targetA),
      zoomSegment("b", 3_400, 2_000, targetB),
    ])

    const shots = resolveCameraShots(state)

    expect(shots).toHaveLength(2)
    expect(shots[0].durationMs).toBe(2_400)
    expect(shots[0].transitionOutMs).toBe(0)
    expect(shots[1].fromTarget).toEqual(canonicalizeZoomTarget(targetA, state.canvas, 2))
    expect(shots[1].fromScale).toBe(2)
  })

  it("bridges adjacent shots with a zero gap", () => {
    const state = makeState([
      zoomSegment("a", 1_000, 2_000, targetA),
      zoomSegment("b", 3_000, 2_000, targetB),
    ])

    const shots = resolveCameraShots(state)
    expect(shots[0].startMs + shots[0].durationMs).toBe(3_000)
    expect(shots[0].transitionOutMs).toBe(0)
    expect(shots[1].fromTarget).toEqual(canonicalizeZoomTarget(targetA, state.canvas, 2))
  })

  it("bridges a chain of shots sequentially", () => {
    const state = makeState([
      zoomSegment("a", 0, 2_000, targetA),
      zoomSegment("b", 2_400, 2_000, targetB),
      zoomSegment("c", 4_600, 2_000, targetC),
    ])

    const shots = resolveCameraShots(state)
    expect(shots.map((shot) => shot.startMs + shot.durationMs)).toEqual([2_400, 4_600, 6_600])
    expect(shots[1].fromTarget).toEqual(canonicalizeZoomTarget(targetA, state.canvas, 2))
    expect(shots[2].fromTarget).toEqual(canonicalizeZoomTarget(targetB, state.canvas, 2))
  })

  it("does not bridge across a gap wider than the threshold", () => {
    const state = makeState([
      zoomSegment("a", 1_000, 2_000, targetA),
      zoomSegment("b", 5_000, 2_000, targetB),
    ])

    const shots = resolveCameraShots(state)
    expect(shots[0].durationMs).toBe(2_000)
    expect(shots[0].transitionOutMs).toBe(300)
    expect(shots[1].fromTarget).toBeUndefined()
    expect(shots[1].fromScale).toBeUndefined()
    expect(ZOOM_BRIDGE_GAP_MS).toBeGreaterThanOrEqual(400)
    expect(ZOOM_BRIDGE_GAP_MS).toBeLessThan(2_000)
  })

  it("never mutates the timeline state", () => {
    const state = makeState([
      zoomSegment("a", 1_000, 2_000, targetA),
      zoomSegment("b", 3_400, 2_000, targetB),
    ])

    resolveCameraShots(state)
    resolveCameraShots(state)

    expect(state.zoomSegments?.[0].durationMs).toBe(2_000)
    expect(state.zoomSegments?.[0].transitionOutMs).toBe(300)
    expect("fromTarget" in (state.zoomSegments?.[1] ?? {})).toBe(false)
  })

  it("resolves a follow-cursor bridge endpoint from the engine's final camera target", () => {
    const telemetry = normalizeCursorTelemetry({
      recordingId: "recording",
      sourceWidth: 1920,
      sourceHeight: 1080,
      events: [
        {
          tMs: 0,
          rawX: 100,
          rawY: 100,
          sourceX: 100,
          sourceY: 100,
          buttons: { left: false, right: false, middle: false, x1: false, x2: false },
          buttonEvent: "none",
          visible: true,
          shapeId: "arrow",
          shapeChanged: false,
        },
        {
          tMs: 1_000,
          rawX: 1_600,
          rawY: 800,
          sourceX: 1_600,
          sourceY: 800,
          buttons: { left: false, right: false, middle: false, x1: false, x2: false },
          buttonEvent: "none",
          visible: true,
          shapeId: "arrow",
          shapeChanged: false,
        },
      ],
    })
    const engine = createCursorEngine(telemetry)
    const state = makeState([
      zoomSegment("a", 0, 2_000, targetA, {
        mode: "follow-cursor",
        transitionInMs: 0,
        transitionOutMs: 0,
        followDeadzonePercent: 0.01,
        followSmoothingAlpha: 1,
      }),
      zoomSegment("b", 2_400, 2_000, targetB, { transitionInMs: 300 }),
    ])

    const shots = resolveCameraShots(state, engine)
    // The bridge target tracks the cursor at A's effective end (2400ms), not
    // the static authored target of A.
    expect(shots[1].fromTarget).toBeDefined()
    const centerX = (shots[1].fromTarget?.x ?? 0) + (shots[1].fromTarget?.width ?? 0) / 2
    expect(centerX).toBeGreaterThan(960)
  })

  it("skips disabled segments entirely", () => {
    const state = makeState([
      zoomSegment("a", 1_000, 2_000, targetA, { enabled: false }),
      zoomSegment("b", 3_400, 2_000, targetB),
    ])

    const shots = resolveCameraShots(state)
    expect(shots).toHaveLength(1)
    expect(shots[0].id).toBe("b")
    expect(shots[0].fromTarget).toBeUndefined()
  })
})

describe("preview bridging", () => {
  it("keeps the previous shot's crop through a small gap with no pop at the next start", () => {
    const state = makeState([
      zoomSegment("a", 1_000, 2_000, targetA),
      zoomSegment("b", 3_400, 2_000, targetB),
    ])

    const justBeforeEnd = resolvePreviewComposition(state, 2_999)
    const insideGap = resolvePreviewComposition(state, 3_200)
    const atNextStart = resolvePreviewComposition(state, 3_400)

    const cropA = justBeforeEnd.screen.zoomTransform?.crop
    const cropGap = insideGap.screen.zoomTransform?.crop
    const cropB = atNextStart.screen.zoomTransform?.crop
    expect(cropA).toBeDefined()
    expect(cropGap).toBeDefined()
    expect(cropB).toBeDefined()
    for (const key of ["x", "y", "width", "height"] as const) {
      expect(Math.abs((cropGap?.[key] ?? 0) - (cropA?.[key] ?? 0))).toBeLessThan(1)
      expect(Math.abs((cropB?.[key] ?? 0) - (cropA?.[key] ?? 0))).toBeLessThan(1)
    }

    // The camera holds at A's canonical target across the whole bridge.
    const expected = canonicalizeZoomTarget(targetA, state.canvas, 2)
    expect(cropGap?.x).toBeCloseTo(expected.x, 5)
    expect(cropGap?.y).toBeCloseTo(expected.y, 5)
  })

  it("zooms out normally when the gap exceeds the bridge threshold", () => {
    const state = makeState([
      zoomSegment("a", 1_000, 2_000, targetA),
      zoomSegment("b", 5_000, 2_000, targetB),
    ])

    const insideGap = resolvePreviewComposition(state, 3_200)
    expect(insideGap.screen.zoomTransform).toBeNull()

    const atNextStart = resolvePreviewComposition(state, 5_000)
    expect(atNextStart.screen.zoomTransform?.scale).toBe(1)
  })
})
