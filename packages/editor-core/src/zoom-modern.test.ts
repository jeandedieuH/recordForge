import { describe, expect, it } from "vitest"
import {
  defaultCursorSettings,
  type ManualZoomSegment,
  type TimelineCanvas,
  type TimelineState,
} from "@recordforge/contracts"
import { zoomTargetForCursorPoint } from "@recordforge/cursor-core"
import {
  createAddZoomSegmentCommand,
  createEngine,
  createUpdateZoomSegmentCommand,
  executeCommand,
  getManualZoomSegments,
  resolveZoomTransform,
  zoomEasedProgress,
  zoomTransformToCss,
} from "./index"

const canvas: TimelineCanvas = {
  width: 1920,
  height: 1080,
  fps: 60,
  background: "#000000",
  padding: 0,
  borderRadius: 0,
  shadow: false,
  cursorSettings: defaultCursorSettings,
}

function makeState(): TimelineState {
  return {
    version: 1,
    id: "zoom-test-project",
    name: "Zoom Test",
    recordingId: "rec",
    canvas,
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
            assetId: "rec",
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
    zoomSegments: [],
    createdAt: "2026-08-14T00:00:00Z",
    updatedAt: "2026-08-14T00:00:00Z",
  }
}

describe("Modern Zoom System", () => {
  describe("Easing Curves", () => {
    it("computes smooth (quintic smootherstep) easing with 0, mid, and 1 boundaries", () => {
      expect(zoomEasedProgress(0, "smooth")).toBe(0)
      expect(zoomEasedProgress(0.5, "smooth")).toBe(0.5)
      expect(zoomEasedProgress(1, "smooth")).toBe(1)
    })

    it("computes spring easing with dynamic overshoot", () => {
      expect(zoomEasedProgress(0, "spring")).toBeCloseTo(0, 1)
      const mid = zoomEasedProgress(0.5, "spring")
      expect(mid).toBeGreaterThan(0.8)
      expect(zoomEasedProgress(1, "spring")).toBeCloseTo(1, 1)
    })

    it("computes cinematic and snappy easings correctly", () => {
      expect(zoomEasedProgress(0.5, "snappy")).toBeGreaterThan(zoomEasedProgress(0.5, "linear"))
      expect(zoomEasedProgress(0, "cinematic")).toBe(0)
      expect(zoomEasedProgress(1, "cinematic")).toBe(1)
    })

    it("implements a normalized damped spring with bounded overshoot", () => {
      expect(zoomEasedProgress(0, "spring")).toBe(0)
      expect(zoomEasedProgress(1, "spring")).toBe(1)

      let max = 0
      for (let index = 0; index <= 500; index++) {
        max = Math.max(max, zoomEasedProgress(index / 500, "spring"))
      }
      // A real spring overshoots the endpoint; the normalized curve bounds it
      // to ~2.6% instead of clamping the overshoot away.
      expect(max).toBeGreaterThan(1.0)
      expect(max).toBeLessThanOrEqual(1.03)
    })

    it("decelerates through the out-phase instead of re-accelerating", () => {
      const segment: ManualZoomSegment = {
        id: "snappy-out",
        startMs: 1_000,
        durationMs: 1_000,
        target: { x: 480, y: 270, width: 960, height: 540 },
        scale: 2,
        easing: "snappy",
        transitionInMs: 200,
        transitionOutMs: 300,
        enabled: true,
        locked: false,
        mode: "manual",
      }
      const progressAt = (timeMs: number) => resolveZoomTransform(segment, timeMs, canvas).progress

      // Out-phase spans elapsed 700..1000. Snappy zoom-out must be steepest at
      // the start and nearly flat at the end, like a real ease-out camera move.
      const dropNearStart = progressAt(1_700) - progressAt(1_710)
      const dropNearEnd = progressAt(1_990) - progressAt(2_000)
      expect(dropNearStart).toBeGreaterThan(0.05)
      expect(dropNearEnd).toBeLessThan(dropNearStart * 0.01)
      expect(progressAt(2_000)).toBe(0)
    })
  })

  describe("Continuous Multi-Segment Camera Panning (Bridging)", () => {
    it("smoothly pans from Segment 1 target to Segment 2 target when adjacent without dipping to 1.0x", () => {
      const seg1: ManualZoomSegment = {
        id: "seg-1",
        startMs: 1000,
        durationMs: 2000, // ends at 3000ms
        target: { x: 100, y: 100, width: 960, height: 540 },
        scale: 2,
        easing: "smooth",
        transitionInMs: 300,
        transitionOutMs: 300,
        enabled: true,
        locked: false,
        mode: "static",
        preset: "product-demo",
      }

      const seg2: ManualZoomSegment = {
        id: "seg-2",
        startMs: 3100, // only 100ms gap (< 500ms bridge gap)
        durationMs: 2000,
        target: { x: 800, y: 400, width: 960, height: 540 },
        scale: 2,
        easing: "smooth",
        transitionInMs: 400,
        transitionOutMs: 400,
        enabled: true,
        locked: false,
        mode: "static",
        preset: "product-demo",
      }

      // During Seg 2 transition in (3100ms to 3500ms), camera starts from seg1 target (not center 1.0x)
      const transformAtStartOfSeg2 = resolveZoomTransform(seg2, 3100, canvas, {
        fromTarget: seg1.target,
        fromScale: seg1.scale,
      })

      expect(transformAtStartOfSeg2).not.toBeNull()
      if (!transformAtStartOfSeg2) return

      // Scale stays at 2.0x (from seg1) instead of dropping to 1.0x!
      expect(transformAtStartOfSeg2.scale).toBeCloseTo(2.0, 1)

      // Center should start at seg 1 target (100, 100)
      expect(transformAtStartOfSeg2.crop.x).toBeCloseTo(100, 1)
      expect(transformAtStartOfSeg2.crop.y).toBeCloseTo(100, 1)
    })
  })

  describe("Zoom-space crop interpolation", () => {
    const interpolateSegment = (target: ManualZoomSegment["target"]): ManualZoomSegment => ({
      id: "interp",
      startMs: 0,
      durationMs: 2_000,
      target,
      scale: 2,
      easing: "linear",
      transitionInMs: 1_000,
      transitionOutMs: 0,
      enabled: true,
      locked: false,
      mode: "manual",
    })

    it("interpolates crop width in log space: p=0.5 of a 1x->2x zoom is sqrt(2) scale", () => {
      const segment = interpolateSegment({ x: 480, y: 270, width: 960, height: 540 })
      const transform = resolveZoomTransform(segment, 500, canvas)
      // Log-space width: w(0.5) = 1920 * 0.5^0.5 = 1920/sqrt(2) -> scale sqrt(2).
      expect(transform.scale).toBeCloseTo(Math.SQRT2, 5)
    })

    it("keeps the screen-fixed point stationary through the transition", () => {
      const segment = interpolateSegment({ x: 1_200, y: 600, width: 640, height: 360 })
      // Fixed point for 1x -> 3x toward (1520, 780):
      //   f = (cB*sB - cA*sA) / (sB - sA) = ((1520*3 - 960), (780*3 - 540)) / 2
      const fixedX = (1_520 * 3 - 960) / 2
      const fixedY = (780 * 3 - 540) / 2

      // A point at `f` must land on the same screen position at every progress.
      const positions = [0, 250, 500, 750, 1_000].map((timeMs) => {
        const transform = resolveZoomTransform(segment, timeMs, canvas)
        const { x, y, width, height } = transform.crop
        return {
          x: ((fixedX - x) / width) * canvas.width,
          y: ((fixedY - y) / height) * canvas.height,
        }
      })
      for (const position of positions) {
        expect(position.x).toBeCloseTo(positions[0].x, 6)
        expect(position.y).toBeCloseTo(positions[0].y, 6)
      }
    })

    it("pans linearly when the zoom levels of both crops are equal", () => {
      const segment = interpolateSegment({ x: 960, y: 540, width: 960, height: 540 })
      const transform = resolveZoomTransform(segment, 500, canvas, {
        fromTarget: { x: 0, y: 0, width: 960, height: 540 },
        fromScale: 2,
      })
      // Equal scale on both ends: pure pan, midpoint center (960, 540).
      expect(transform.crop.x + transform.crop.width / 2).toBeCloseTo(960, 3)
      expect(transform.crop.y + transform.crop.height / 2).toBeCloseTo(540, 3)
    })
  })

  describe("Edge & Center Framing (Cursor Alignment)", () => {
    it("centers cursor in focus frame when cursor is inside comfortable bounds", () => {
      const target = zoomTargetForCursorPoint({ x: 960, y: 540 }, canvas, 2.0)
      expect(target.width).toBeCloseTo(960, 1)
      expect(target.height).toBeCloseTo(540, 1)
      // Center of target must be exactly (960, 540)
      expect(target.x + target.width / 2).toBeCloseTo(960, 1)
      expect(target.y + target.height / 2).toBeCloseTo(540, 1)
    })

    it("touches the top-left edges when cursor is at (0, 0)", () => {
      const target = zoomTargetForCursorPoint({ x: 0, y: 0 }, canvas, 1.5)
      expect(target.width).toBeCloseTo(1280, 1)
      expect(target.height).toBeCloseTo(720, 1)
      // Touches top-left edge
      expect(target.x).toBe(0)
      expect(target.y).toBe(0)
      // Cursor (0, 0) is within the visible frame
      expect(0).toBeGreaterThanOrEqual(target.x)
      expect(0).toBeLessThanOrEqual(target.x + target.width)
    })

    it("touches the far right and bottom edges when cursor is at (1920, 1080)", () => {
      const target = zoomTargetForCursorPoint({ x: 1920, y: 1080 }, canvas, 2.0)
      expect(target.width).toBeCloseTo(960, 1)
      expect(target.height).toBeCloseTo(540, 1)
      // Touches bottom-right edge: target.x + target.width == 1920
      expect(target.x + target.width).toBe(1920)
      expect(target.y + target.height).toBe(1080)
      // Cursor at 1920 is within the visible frame
      expect(1920).toBeGreaterThanOrEqual(target.x)
      expect(1920).toBeLessThanOrEqual(target.x + target.width)
    })

    it("canonicalizes a legacy target height so cursor and video keep the canvas aspect", () => {
      const segment: ManualZoomSegment = {
        id: "legacy-aspect",
        startMs: 0,
        durationMs: 2_000,
        target: { x: 300, y: 100, width: 960, height: 700 },
        scale: 1.5,
        easing: "linear",
        transitionInMs: 0,
        transitionOutMs: 0,
        enabled: true,
        locked: false,
        mode: "manual",
      }

      const transform = resolveZoomTransform(segment, 1_000, canvas)
      expect(transform.scale).toBeCloseTo(2)
      expect(transform.crop.width).toBeCloseTo(960)
      expect(transform.crop.height).toBeCloseTo(540)
    })

    it("bounds spring transitions so high zoom factors never create a negative crop", () => {
      const segment: ManualZoomSegment = {
        id: "safe-spring",
        startMs: 0,
        durationMs: 1_000,
        target: { x: 840, y: 472.5, width: 240, height: 135 },
        scale: 8,
        easing: "spring",
        transitionInMs: 1_000,
        transitionOutMs: 0,
        enabled: true,
        locked: false,
        mode: "manual",
      }

      // The real spring overshoots eased progress by ~3%, so the crop can
      // narrow past the target by up to (canvas - target) * 0.03 during the
      // transition; scale bounds derive from that minimum crop, not 8x itself.
      const minCropWidth = canvas.width - (canvas.width - 240) * 1.03
      const maxExpectedScale = canvas.width / minCropWidth
      for (const timeMs of [0, 100, 200, 300, 500, 900]) {
        const transform = resolveZoomTransform(segment, timeMs, canvas)
        expect(transform.crop.width).toBeGreaterThanOrEqual(1)
        expect(transform.crop.height).toBeGreaterThanOrEqual(1)
        expect(transform.scale).toBeLessThanOrEqual(maxExpectedScale)
      }
    })
  })

  describe("Commands & State Management", () => {
    it("adds and updates zoom segments with modern transitions and follow settings", () => {
      const engine = createEngine(makeState())

      const addResult = executeCommand(
        engine,
        createAddZoomSegmentCommand(
          500,
          3500,
          { x: 200, y: 150, width: 960, height: 540 },
          {
            scale: 2.0,
            easing: "spring",
            transitionInMs: 320,
            transitionOutMs: 320,
            mode: "follow-cursor",
            followDeadzonePercent: 0.06,
            followSmoothingAlpha: 0.35,
            label: "Code Editor",
          },
        ),
      )

      expect(addResult.ok).toBe(true)
      if (!addResult.ok) return

      const segments = getManualZoomSegments(addResult.value.history.present)
      expect(segments).toHaveLength(1)
      const added = segments[0]
      expect(added.scale).toBe(2.0)
      expect(added.easing).toBe("spring")
      expect(added.transitionInMs).toBe(320)
      expect(added.transitionOutMs).toBe(320)
      expect(added.mode).toBe("follow-cursor")
      expect(added.followDeadzonePercent).toBe(0.06)
      expect(added.followSmoothingAlpha).toBe(0.35)
      expect(added.label).toBe("Code Editor")

      // Update segment
      const updateResult = executeCommand(
        addResult.value,
        createUpdateZoomSegmentCommand(added.id, {
          scale: 2.5,
          transitionInMs: 450,
          label: "Terminal View",
        }),
      )

      expect(updateResult.ok).toBe(true)
      if (!updateResult.ok) return

      const updatedSegments = getManualZoomSegments(updateResult.value.history.present)
      const updated = updatedSegments[0]
      expect(updated.scale).toBe(2.5)
      expect(updated.transitionInMs).toBe(450)
      expect(updated.transitionOutMs).toBe(320) // preserved
      expect(updated.label).toBe("Terminal View")
      expect(updated.easing).toBe("spring") // preserved
    })

    it("can disable an automatic zoom without deleting its editable range", () => {
      const initial = makeState()
      initial.zoomSegments = [
        {
          id: "auto-zoom",
          startMs: 1_000,
          durationMs: 2_000,
          target: { x: 200, y: 100, width: 960, height: 540 },
          scale: 2,
          easing: "smooth",
          enabled: true,
          locked: false,
          mode: "follow-cursor",
          source: "click",
          preset: "product-demo",
        },
      ]
      const result = executeCommand(
        createEngine(initial),
        createUpdateZoomSegmentCommand("auto-zoom", { enabled: false }),
      )

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(getManualZoomSegments(result.value.history.present)).toEqual([
        expect.objectContaining({ id: "auto-zoom", enabled: false, source: "click" }),
      ])
    })
  })

  describe("CSS Transform Resolution", () => {
    it("converts zoom transform to exact top-left origin scale and crop matrix", () => {
      const transform = {
        crop: { x: 480, y: 270, width: 960, height: 540 },
        scale: 2,
        progress: 1,
        translateX: 0,
        translateY: 0,
      }
      const css = zoomTransformToCss(transform, canvas)
      expect(css).toBe("matrix(2, 0, 0, 2, -960, -540)")
    })

    it("maintains perfect cursor framing across high zoom factors (1.5x, 2.0x, 3.0x, 5.0x, 8.0x)", () => {
      const scales = [1.25, 1.5, 2.0, 3.0, 5.0, 8.0]
      const cursorPositions = [
        { x: 960, y: 540 }, // center
        { x: 100, y: 100 }, // top-left
        { x: 1920, y: 1080 }, // bottom-right edge
        { x: 0, y: 540 }, // left edge
        { x: 1920, y: 540 }, // right edge
      ]

      for (const scale of scales) {
        for (const cursor of cursorPositions) {
          const target = zoomTargetForCursorPoint(cursor, canvas, scale)
          // Frame dimensions must match scale
          expect(target.width).toBeCloseTo(canvas.width / scale, 1)
          expect(target.height).toBeCloseTo(canvas.height / scale, 1)
          // Frame must be clamped within canvas boundaries
          expect(target.x).toBeGreaterThanOrEqual(0)
          expect(target.y).toBeGreaterThanOrEqual(0)
          expect(target.x + target.width).toBeLessThanOrEqual(canvas.width + 0.001)
          expect(target.y + target.height).toBeLessThanOrEqual(canvas.height + 0.001)
          // Cursor MUST ALWAYS be contained inside the visible focus frame
          expect(cursor.x).toBeGreaterThanOrEqual(target.x - 0.001)
          expect(cursor.x).toBeLessThanOrEqual(target.x + target.width + 0.001)
          expect(cursor.y).toBeGreaterThanOrEqual(target.y - 0.001)
          expect(cursor.y).toBeLessThanOrEqual(target.y + target.height + 0.001)
        }
      }
    })
  })
})
