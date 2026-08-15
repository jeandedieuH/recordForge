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
      expect(css).toBe("scale(2) translate(-25%, -25%)")
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
