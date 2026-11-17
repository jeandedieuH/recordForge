import type { CameraFrame } from "@recordforge/contracts"
import {
  cameraShortEdge,
  effectiveFrameAspect,
  resolveFramePlacement,
  type CameraFrameCanvas,
  type CameraSourceSize,
} from "./camera-frame"
import { screenContentRect } from "./camera-layouts"
import type { CanvasRect } from "./composition"
import type { CameraFramePatch } from "./camera-frame-state"

/**
 * Camera frame gestures (ADR 023 phase 4b): pure helpers turning pointer
 * gestures on the resolved rect back into frame patches. They mirror
 * `resolvePlacementRect`'s overlay math so a drag/resize round-trips through
 * `resolveCameraFrame` to the same rect.
 */

/** A snapped alignment line the preview draws while a gesture is in progress. */
export interface CameraSnapGuide {
  axis: "x" | "y"
  /** Canvas-pixel position of the guide line. */
  position: number
  kind: "edge" | "center" | "third"
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function anchorArea(placement: CameraFrame["placement"], canvas: CameraFrameCanvas): CanvasRect {
  return placement.anchorTo === "content"
    ? screenContentRect(canvas)
    : { x: 0, y: 0, width: canvas.width, height: canvas.height }
}

/**
 * Inverse of `resolvePlacementRect`'s overlay branch: the align fractions that
 * place `rect` inside the margin-inset anchor area and the size fraction for
 * `rect.height`. The patch only carries `mode`/`align`/`size` so the existing
 * margin and anchorTo are preserved; it always describes overlay placement —
 * the caller decides whether the drag is legal for the current mode.
 */
export function cameraFramePatchFromRect(input: {
  frame: CameraFrame
  rect: CanvasRect
  canvas: CameraFrameCanvas
  source?: CameraSourceSize
}): CameraFramePatch {
  const { frame, rect, canvas } = input
  const short = cameraShortEdge(canvas)
  const aspect = effectiveFrameAspect(frame, canvas, input.source)
  const area = anchorArea(frame.placement, canvas)
  const margin = Math.round(frame.placement.margin * short)
  const height = Math.max(2, rect.height)
  const width = Math.max(2, Math.round(height * Math.max(0.01, aspect)))
  const freeWidth = area.width - margin * 2 - width
  const freeHeight = area.height - margin * 2 - height
  return {
    placement: {
      mode: "overlay",
      align: {
        x: freeWidth > 0 ? clampUnit((rect.x - area.x - margin) / freeWidth) : 0.5,
        y: freeHeight > 0 ? clampUnit((rect.y - area.y - margin) / freeHeight) : 0.5,
      },
      // `size` is the frame height as a fraction of the short edge; the
      // resolver recomputes width from the frame aspect.
      size: Math.max(0.01, height / short),
    },
  }
}

interface SnapAxisResult {
  delta: number
  guide: CameraSnapGuide
}

function snapAxis(
  candidates: Array<{ position: number; edge: number }>,
  targets: Array<{ position: number; kind: CameraSnapGuide["kind"] }>,
  thresholdPx: number,
  axis: "x" | "y",
): SnapAxisResult | null {
  let best: SnapAxisResult | null = null
  for (const candidate of candidates) {
    for (const target of targets) {
      const delta = target.position - candidate.edge
      if (Math.abs(delta) > thresholdPx) continue
      if (!best || Math.abs(delta) < Math.abs(best.delta)) {
        best = { delta, guide: { axis, position: target.position, kind: target.kind } }
      }
    }
  }
  return best
}

function snapTargets(area: CanvasRect, marginPx: number): CameraSnapGuide[] {
  const left = area.x + marginPx
  const top = area.y + marginPx
  const right = area.x + area.width - marginPx
  const bottom = area.y + area.height - marginPx
  const targets: CameraSnapGuide[] = [
    { axis: "x", position: left, kind: "edge" },
    { axis: "x", position: right, kind: "edge" },
    { axis: "y", position: top, kind: "edge" },
    { axis: "y", position: bottom, kind: "edge" },
    { axis: "x", position: area.x + area.width / 2, kind: "center" },
    { axis: "y", position: area.y + area.height / 2, kind: "center" },
  ]
  for (const fraction of [1 / 3, 2 / 3]) {
    targets.push(
      { axis: "x", position: area.x + area.width * fraction, kind: "third" },
      { axis: "y", position: area.y + area.height * fraction, kind: "third" },
    )
  }
  return targets
}

/**
 * Snap `rect` toward the anchor area's margin-inset edges, its centre lines
 * and its third lines (all in canvas px). `area` defaults to the whole canvas;
 * `marginPx` insets the edge targets (0 = snap to the area itself).
 *
 * `mode: "move"` snaps whichever of the rect's left/centre/right (resp.
 * top/centre/bottom) is closest on each axis and shifts the whole rect.
 * `mode: "resize"` only snaps the edges named by `activeEdges` and moves just
 * those edges — the returned rect is NOT aspect-corrected; the caller locks
 * the aspect afterwards, with the **width** dimension winning (height is
 * re-derived from the snapped width).
 */
export function snapCameraRect(input: {
  rect: CanvasRect
  canvas: CameraFrameCanvas
  area?: CanvasRect
  marginPx?: number
  thresholdPx: number
  mode: "move" | "resize"
  activeEdges?: { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean }
}): { rect: CanvasRect; guides: CameraSnapGuide[] } {
  const { rect, thresholdPx, mode } = input
  const area = input.area ?? {
    x: 0,
    y: 0,
    width: input.canvas.width,
    height: input.canvas.height,
  }
  const targets = snapTargets(area, input.marginPx ?? 0)
  const guides: CameraSnapGuide[] = []
  const next = { ...rect }

  if (mode === "move") {
    const x = snapAxis(
      [
        { position: rect.x, edge: rect.x },
        { position: rect.x + rect.width / 2, edge: rect.x + rect.width / 2 },
        { position: rect.x + rect.width, edge: rect.x + rect.width },
      ],
      targets.filter((target) => target.axis === "x"),
      thresholdPx,
      "x",
    )
    const y = snapAxis(
      [
        { position: rect.y, edge: rect.y },
        { position: rect.y + rect.height / 2, edge: rect.y + rect.height / 2 },
        { position: rect.y + rect.height, edge: rect.y + rect.height },
      ],
      targets.filter((target) => target.axis === "y"),
      thresholdPx,
      "y",
    )
    if (x) {
      next.x += x.delta
      guides.push(x.guide)
    }
    if (y) {
      next.y += y.delta
      guides.push(y.guide)
    }
    return { rect: next, guides }
  }

  const edges = input.activeEdges ?? {}
  const xTargets = targets.filter((target) => target.axis === "x")
  const yTargets = targets.filter((target) => target.axis === "y")
  if (edges.left) {
    const snap = snapAxis([{ position: rect.x, edge: rect.x }], xTargets, thresholdPx, "x")
    if (snap) {
      next.x += snap.delta
      next.width -= snap.delta
      guides.push(snap.guide)
    }
  }
  if (edges.right) {
    const snap = snapAxis(
      [{ position: rect.x + rect.width, edge: rect.x + rect.width }],
      xTargets,
      thresholdPx,
      "x",
    )
    if (snap) {
      next.width += snap.delta
      guides.push(snap.guide)
    }
  }
  if (edges.top) {
    const snap = snapAxis([{ position: rect.y, edge: rect.y }], yTargets, thresholdPx, "y")
    if (snap) {
      next.y += snap.delta
      next.height -= snap.delta
      guides.push(snap.guide)
    }
  }
  if (edges.bottom) {
    const snap = snapAxis(
      [{ position: rect.y + rect.height, edge: rect.y + rect.height }],
      yTargets,
      thresholdPx,
      "y",
    )
    if (snap) {
      next.height += snap.delta
      guides.push(snap.guide)
    }
  }
  next.width = Math.max(2, next.width)
  next.height = Math.max(2, next.height)
  return { rect: next, guides }
}

/** Arrow-key nudge: move the resolved rect by whole canvas px and re-patch. */
export function cameraFrameNudgePatch(input: {
  frame: CameraFrame
  canvas: CameraFrameCanvas
  source?: CameraSourceSize
  dxPx: number
  dyPx: number
}): CameraFramePatch {
  const { rect } = resolveFramePlacement(input.frame, input.canvas, input.source)
  return cameraFramePatchFromRect({
    frame: input.frame,
    rect: { ...rect, x: rect.x + input.dxPx, y: rect.y + input.dyPx },
    canvas: input.canvas,
    source: input.source,
  })
}
