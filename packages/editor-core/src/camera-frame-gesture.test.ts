import { describe, expect, it } from "vitest"
import { cameraFrameSchema, type CameraFrame } from "@recordforge/contracts"
import {
  cameraFrameNudgePatch,
  cameraFramePatchFromRect,
  snapCameraRect,
} from "./camera-frame-gesture"
import { mergeCameraFramePatch } from "./camera-frame-state"
import { resolveFramePlacement, type CameraFrameCanvas } from "./camera-frame"
import type { CanvasRect } from "./composition"

const canvas169: CameraFrameCanvas = {
  width: 1920,
  height: 1080,
  padding: 96,
  aspectRatio: "16:9",
}
const canvas916: CameraFrameCanvas = {
  width: 1080,
  height: 1920,
  padding: 24,
  aspectRatio: "9:16",
}

// Rects in the round-trip matrix use the frame's own aspect — width is always
// re-derived from the frame aspect, so only aspect-matched rects round-trip.
function overlayFrame(overrides?: {
  margin?: number
  anchorTo?: "canvas" | "content"
  aspect?: CameraFrame["aspect"]
}): CameraFrame {
  return cameraFrameSchema.parse({
    placement: {
      mode: "overlay",
      anchorTo: overrides?.anchorTo ?? "canvas",
      margin: overrides?.margin ?? 0.022,
      origin: "pinned",
    },
    aspect: overrides?.aspect ?? "5:7",
  })
}

function applyPatch(frame: CameraFrame, patch: ReturnType<typeof cameraFramePatchFromRect>) {
  return mergeCameraFramePatch(frame, patch)
}

describe("cameraFramePatchFromRect", () => {
  const cases: Array<{
    canvas: CameraFrameCanvas
    rect: CanvasRect
    margin: number
    anchorTo: "canvas" | "content"
    aspect?: CameraFrame["aspect"]
  }> = [
    {
      canvas: canvas169,
      rect: { x: 100, y: 100, width: 240, height: 336 },
      margin: 0,
      anchorTo: "canvas",
    },
    {
      canvas: canvas169,
      rect: { x: 1600, y: 700, width: 240, height: 336 },
      margin: 0.022,
      anchorTo: "canvas",
    },
    {
      canvas: canvas169,
      rect: { x: 0, y: 0, width: 240, height: 336 },
      margin: 0,
      anchorTo: "canvas",
    },
    {
      canvas: canvas169,
      rect: { x: 1680, y: 744, width: 240, height: 336 },
      margin: 0,
      anchorTo: "canvas",
    },
    {
      canvas: canvas169,
      rect: { x: 96, y: 96, width: 240, height: 336 },
      margin: 0,
      anchorTo: "content",
    },
    {
      canvas: canvas169,
      rect: { x: 1584, y: 648, width: 240, height: 336 },
      margin: 0,
      anchorTo: "content",
    },
    {
      canvas: canvas169,
      rect: { x: 960, y: 500, width: 200, height: 200 },
      margin: 0.05,
      anchorTo: "canvas",
      aspect: "1:1",
    },
    {
      canvas: canvas916,
      rect: { x: 100, y: 1400, width: 300, height: 420 },
      margin: 0.022,
      anchorTo: "canvas",
    },
    {
      canvas: canvas916,
      rect: { x: 24, y: 24, width: 300, height: 420 },
      margin: 0,
      anchorTo: "content",
    },
    {
      canvas: canvas916,
      rect: { x: 600, y: 200, width: 300, height: 420 },
      margin: 0.1,
      anchorTo: "canvas",
    },
    {
      canvas: canvas169,
      rect: { x: 400, y: 700, width: 400, height: 225 },
      margin: 0,
      anchorTo: "canvas",
      aspect: "16:9",
    },
    {
      canvas: canvas169,
      rect: { x: 1200, y: 300, width: 225, height: 400 },
      margin: 0.03,
      anchorTo: "content",
      aspect: "9:16",
    },
  ]

  it.each(cases)("round-trips rect %s", ({ canvas, rect, margin, anchorTo, aspect }) => {
    const frame = overlayFrame({ margin, anchorTo, aspect })
    const patch = cameraFramePatchFromRect({ frame, rect, canvas })
    const next = applyPatch(frame, patch)
    const resolved = resolveFramePlacement(next, canvas).rect

    expect(Math.abs(resolved.x - rect.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(resolved.y - rect.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(resolved.width - rect.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(resolved.height - rect.height)).toBeLessThanOrEqual(1)
  })

  it("keeps margin and anchorTo out of the patch", () => {
    const patch = cameraFramePatchFromRect({
      frame: overlayFrame({ margin: 0.05, anchorTo: "content" }),
      rect: { x: 100, y: 100, width: 100, height: 100 },
      canvas: canvas169,
    })
    expect(patch.placement?.margin).toBeUndefined()
    expect(patch.placement?.anchorTo).toBeUndefined()
    expect(patch.placement?.mode).toBe("overlay")
  })

  it("clamps align into the unit range for rects outside the free area", () => {
    const patch = cameraFramePatchFromRect({
      frame: overlayFrame({ margin: 0, anchorTo: "canvas" }),
      rect: { x: -500, y: 9999, width: 100, height: 100 },
      canvas: canvas169,
    })
    expect(patch.placement?.align?.x).toBe(0)
    expect(patch.placement?.align?.y).toBe(1)
  })
})

describe("snapCameraRect", () => {
  const area: CanvasRect = { x: 0, y: 0, width: 1920, height: 1080 }

  it("returns the rect unchanged outside the threshold", () => {
    const rect = { x: 700, y: 400, width: 240, height: 336 }
    const { rect: snapped, guides } = snapCameraRect({
      rect,
      canvas: canvas169,
      area,
      thresholdPx: 6,
      mode: "move",
    })
    expect(snapped).toEqual(rect)
    expect(guides).toEqual([])
  })

  it("snaps the centre to the canvas centre", () => {
    const rect = { x: 838, y: 300, width: 240, height: 336 }
    // Centre x = 958, canvas centre = 960 -> delta 2; centre y = 468, no target.
    const { rect: snapped, guides } = snapCameraRect({
      rect,
      canvas: canvas169,
      area,
      thresholdPx: 6,
      mode: "move",
    })
    expect(snapped.x).toBe(rect.x + 2)
    expect(guides).toEqual([{ axis: "x", position: 960, kind: "center" }])
  })

  it("snaps edges to margin-inset targets", () => {
    const rect = { x: 90, y: 150, width: 240, height: 336 }
    const { rect: snapped, guides } = snapCameraRect({
      rect,
      canvas: canvas169,
      area,
      marginPx: 96,
      thresholdPx: 10,
      mode: "move",
    })
    expect(snapped.x).toBe(96)
    expect(snapped.y).toBe(150)
    expect(guides).toEqual([{ axis: "x", position: 96, kind: "edge" }])
  })

  it("snaps to the thirds lines", () => {
    const rect = { x: 396, y: 100, width: 240, height: 336 }
    // Left edge 396 -> third at 640? right edge 636 -> third 640, delta 4.
    const { rect: snapped, guides } = snapCameraRect({
      rect,
      canvas: canvas169,
      area,
      thresholdPx: 6,
      mode: "move",
    })
    expect(snapped.x).toBe(rect.x + 4)
    expect(guides).toEqual([{ axis: "x", position: 640, kind: "third" }])
  })

  it("snaps both axes independently", () => {
    const rect = { x: 92, y: 86, width: 240, height: 336 }
    const { guides } = snapCameraRect({
      rect,
      canvas: canvas169,
      area,
      marginPx: 96,
      thresholdPx: 12,
      mode: "move",
    })
    expect(guides).toHaveLength(2)
    expect(guides.map((guide) => guide.axis).sort()).toEqual(["x", "y"])
  })

  it("resize only moves the active edges", () => {
    const rect = { x: 92, y: 100, width: 240, height: 336 }
    const { rect: snapped, guides } = snapCameraRect({
      rect,
      canvas: canvas169,
      area,
      marginPx: 96,
      thresholdPx: 10,
      mode: "resize",
      activeEdges: { right: true, bottom: true },
    })
    // The "se" handle: left edge at 92 does not snap, only right/bottom move.
    expect(snapped.x).toBe(rect.x)
    expect(snapped.y).toBe(rect.y)
    expect(guides).toEqual([])
  })

  it("resize snaps an active left edge without touching the right", () => {
    const rect = { x: 90, y: 100, width: 240, height: 336 }
    const { rect: snapped, guides } = snapCameraRect({
      rect,
      canvas: canvas169,
      area,
      marginPx: 96,
      thresholdPx: 10,
      mode: "resize",
      activeEdges: { left: true },
    })
    expect(snapped).toEqual({ x: 96, y: 100, width: 234, height: 336 })
    expect(guides).toEqual([{ axis: "x", position: 96, kind: "edge" }])
  })
})

describe("cameraFrameNudgePatch", () => {
  it("moves the resolved rect by whole canvas pixels", () => {
    const frame = overlayFrame({ margin: 0, anchorTo: "canvas" })
    const before = resolveFramePlacement(frame, canvas169).rect
    const patch = cameraFrameNudgePatch({ frame, canvas: canvas169, dxPx: -10, dyPx: -10 })
    const after = resolveFramePlacement(applyPatch(frame, patch), canvas169).rect
    expect(after.x).toBe(before.x - 10)
    expect(after.y).toBe(before.y - 10)
    expect(after.width).toBe(before.width)
    expect(after.height).toBe(before.height)
  })
})
