import type { AnnotationArrowStyle, AnnotationHead } from "@recordforge/contracts"

/**
 * Shared connector geometry for arrow/line strokes and callout leader lines.
 * Kept dependency-free so the canvas preview, SVG overlays, and (mirrored) the
 * native export adapter all compute identical paths.
 */

export interface ConnectorPoint {
  x: number
  y: number
}

/** Preferred first-segment direction for elbow/curved routing. */
export type ConnectorAxis = "horizontal" | "vertical"

export interface ConnectorPath {
  start: ConnectorPoint
  end: ConnectorPoint
  /** Bend point for "elbow" style. */
  corner?: ConnectorPoint
  /** Quadratic bézier control for "curved" style. */
  control?: ConnectorPoint
}

export interface CalloutBox {
  x: number
  y: number
  width: number
  height: number
}

const EPSILON = 1e-6
const QUADRATIC_STEPS = 32

function distance(a: ConnectorPoint, b: ConnectorPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

function lerpPoint(a: ConnectorPoint, b: ConnectorPoint, t: number): ConnectorPoint {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * Elbow corner for a start→end drag. The long axis bends first so the connector
 * travels the dominant direction before turning. Returns null for axis-aligned
 * drags, which are already straight.
 */
function connectorCorner(
  start: ConnectorPoint,
  end: ConnectorPoint,
  preferredAxis?: ConnectorAxis,
): ConnectorPoint | null {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (Math.abs(dx) < EPSILON || Math.abs(dy) < EPSILON) return null
  const horizontalFirst = preferredAxis
    ? preferredAxis === "horizontal"
    : Math.abs(dx) >= Math.abs(dy)
  return horizontalFirst ? { x: end.x, y: start.y } : { x: start.x, y: end.y }
}

/**
 * Centerline for a connector between `start` and `end`.
 * "curved" reuses the elbow corner as its quadratic control point so the two
 * styles round the same corner of the dragged rectangle.
 */
export function connectorPathFor(
  style: AnnotationArrowStyle,
  start: ConnectorPoint,
  end: ConnectorPoint,
  preferredAxis?: ConnectorAxis,
): ConnectorPath {
  if (style === "straight") return { start, end }
  const corner = connectorCorner(start, end, preferredAxis)
  if (!corner) return { start, end }
  return style === "elbow" ? { start, corner, end } : { start, control: corner, end }
}

/** Point "toward" which the start head should look back along the connector. */
export function connectorStartToward(path: ConnectorPath): ConnectorPoint {
  return path.control ?? path.corner ?? path.end
}

/** Point "toward" which the end head should look back along the connector. */
export function connectorEndToward(path: ConnectorPath): ConnectorPoint {
  return path.control ?? path.corner ?? path.start
}

function quadraticAt(
  p0: ConnectorPoint,
  c: ConnectorPoint,
  p1: ConnectorPoint,
  t: number,
): ConnectorPoint {
  const mt = 1 - t
  return {
    x: mt * mt * p0.x + 2 * mt * t * c.x + t * t * p1.x,
    y: mt * mt * p0.y + 2 * mt * t * c.y + t * t * p1.y,
  }
}

function quadraticLength(p0: ConnectorPoint, c: ConnectorPoint, p1: ConnectorPoint): number {
  let total = 0
  let prev = p0
  for (let i = 1; i <= QUADRATIC_STEPS; i += 1) {
    const point = quadraticAt(p0, c, p1, i / QUADRATIC_STEPS)
    total += distance(prev, point)
    prev = point
  }
  return total
}

/** Approximate the bézier parameter `t` at `target` arc distance from the start. */
function quadraticParameterAtDistance(
  p0: ConnectorPoint,
  c: ConnectorPoint,
  p1: ConnectorPoint,
  target: number,
): number {
  if (target <= 0) return 0
  let prev = p0
  let traveled = 0
  for (let i = 1; i <= QUADRATIC_STEPS; i += 1) {
    const point = quadraticAt(p0, c, p1, i / QUADRATIC_STEPS)
    const segment = distance(prev, point)
    if (traveled + segment >= target) {
      const fraction = segment <= EPSILON ? 0 : (target - traveled) / segment
      return (i - 1 + fraction) / QUADRATIC_STEPS
    }
    traveled += segment
    prev = point
  }
  return 1
}

/** de Casteljau sub-curve of quadratic (p0, c, p1) restricted to t ∈ [t0, t1]. */
function quadraticSubcurve(
  p0: ConnectorPoint,
  c: ConnectorPoint,
  p1: ConnectorPoint,
  t0: number,
  t1: number,
): { start: ConnectorPoint; control: ConnectorPoint; end: ConnectorPoint } {
  const upper = clamp(t1, 0, 1)
  const leftControl = lerpPoint(p0, c, upper)
  const end = quadraticAt(p0, c, p1, upper)
  const lower = clamp(t0, 0, 1)
  const u = upper <= EPSILON ? 0 : clamp(lower / upper, 0, 1)
  const start = quadraticAt(p0, c, p1, lower)
  const control = lerpPoint(leftControl, end, u)
  return { start, control, end }
}

export function connectorLength(path: ConnectorPath): number {
  if (path.control) return quadraticLength(path.start, path.control, path.end)
  if (path.corner) return distance(path.start, path.corner) + distance(path.corner, path.end)
  return distance(path.start, path.end)
}

function trimPolylineStart(points: ConnectorPoint[], trim: number): ConnectorPoint[] {
  const result = points.slice()
  let remaining = trim
  while (result.length > 1 && remaining > 0) {
    const segment = distance(result[0], result[1])
    if (segment <= EPSILON) {
      result.shift()
      continue
    }
    if (remaining >= segment) {
      remaining -= segment
      result.shift()
      continue
    }
    result[0] = lerpPoint(result[0], result[1], remaining / segment)
    remaining = 0
  }
  return result
}

function trimPolylineEnd(points: ConnectorPoint[], trim: number): ConnectorPoint[] {
  const result = points.slice()
  let remaining = trim
  while (result.length > 1 && remaining > 0) {
    const last = result.length - 1
    const segment = distance(result[last - 1], result[last])
    if (segment <= EPSILON) {
      result.pop()
      continue
    }
    if (remaining >= segment) {
      remaining -= segment
      result.pop()
      continue
    }
    result[last] = lerpPoint(result[last], result[last - 1], remaining / segment)
    remaining = 0
  }
  return result
}

/**
 * Shorten a connector's shaft by `startTrim`/`endTrim` arc length so stroked
 * heads do not overlap the line. Trims are capped at 45% of the total length
 * each, matching the previous straight-line head offset behavior.
 */
export function trimConnectorPath(
  path: ConnectorPath,
  startTrim: number,
  endTrim: number,
): ConnectorPath {
  const total = connectorLength(path)
  if (total <= EPSILON) return path
  const start = clamp(startTrim, 0, total * 0.45)
  const end = clamp(endTrim, 0, total * 0.45)
  if (start <= 0 && end <= 0) return path

  if (path.control) {
    const t0 = quadraticParameterAtDistance(path.start, path.control, path.end, start)
    const t1 = quadraticParameterAtDistance(path.start, path.control, path.end, total - end)
    const sub = quadraticSubcurve(path.start, path.control, path.end, t0, Math.max(t0, t1))
    return { start: sub.start, control: sub.control, end: sub.end }
  }

  const points = path.corner ? [path.start, path.corner, path.end] : [path.start, path.end]
  const trimmed = trimPolylineEnd(trimPolylineStart(points, start), end)
  if (trimmed.length >= 3) {
    return { start: trimmed[0], corner: trimmed[1], end: trimmed[2] }
  }
  return { start: trimmed[0] ?? path.start, end: trimmed[trimmed.length - 1] ?? path.end }
}

/** Shaft length to remove so a stroked head does not overlap the line. */
export function connectorHeadTrim(head: AnnotationHead, headSize: number): number {
  if (head === "none") return 0
  return head === "circle" ? headSize / 2 : headSize * 0.7
}

/**
 * Point where a callout leader should leave the bubble: the ray from the box
 * center to the target, clipped to the box border. `axis` is the direction the
 * leader should exit along (horizontal for left/right edges, vertical for
 * top/bottom) so elbow/curved leaders leave the bubble cleanly.
 */
export function calloutAttachPoint(
  box: CalloutBox,
  target: ConnectorPoint,
): { point: ConnectorPoint; axis: ConnectorAxis } {
  const centerX = box.x + box.width / 2
  const centerY = box.y + box.height / 2
  const dx = target.x - centerX
  const dy = target.y - centerY
  if (Math.abs(dx) < EPSILON && Math.abs(dy) < EPSILON) {
    return { point: { x: centerX, y: box.y + box.height }, axis: "vertical" }
  }
  const tX = dx === 0 ? Infinity : Math.max(EPSILON, box.width / 2) / Math.abs(dx)
  const tY = dy === 0 ? Infinity : Math.max(EPSILON, box.height / 2) / Math.abs(dy)
  const t = Math.min(tX, tY)
  return {
    point: { x: centerX + dx * t, y: centerY + dy * t },
    axis: tX <= tY ? "horizontal" : "vertical",
  }
}

/** Stroke the connector centerline on a Canvas2D context. */
export function strokeConnectorPath(
  context: CanvasRenderingContext2D,
  path: ConnectorPath,
): void {
  context.beginPath()
  context.moveTo(path.start.x, path.start.y)
  if (path.control) {
    context.quadraticCurveTo(path.control.x, path.control.y, path.end.x, path.end.y)
  } else {
    if (path.corner) context.lineTo(path.corner.x, path.corner.y)
    context.lineTo(path.end.x, path.end.y)
  }
  context.stroke()
}

/** SVG path `d` for the connector centerline. */
export function connectorPathD(path: ConnectorPath): string {
  const p = (point: ConnectorPoint) => `${round2(point.x)} ${round2(point.y)}`
  if (path.control) return `M ${p(path.start)} Q ${p(path.control)} ${p(path.end)}`
  if (path.corner) return `M ${p(path.start)} L ${p(path.corner)} L ${p(path.end)}`
  return `M ${p(path.start)} L ${p(path.end)}`
}

/**
 * SVG path `d` for a filled connector head at `tip`, oriented looking back
 * toward `toward`. Shapes mirror `drawArrowHead` in the canvas renderer.
 */
export function connectorHeadPathD(
  head: AnnotationHead,
  tip: ConnectorPoint,
  toward: ConnectorPoint,
  size: number,
): string {
  if (head === "none") return ""
  if (head === "circle") {
    const r = round2(size / 2)
    const east = round2(tip.x + size / 2)
    const west = round2(tip.x - size / 2)
    const y = round2(tip.y)
    return `M ${east} ${y} A ${r} ${r} 0 1 0 ${west} ${y} A ${r} ${r} 0 1 0 ${east} ${y} Z`
  }
  const angle = Math.atan2(toward.y - tip.y, toward.x - tip.x)
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const rot = (px: number, py: number) =>
    `${round2(tip.x + px * cos - py * sin)} ${round2(tip.y + px * sin + py * cos)}`
  if (head === "diamond") {
    return `M ${rot(0, 0)} L ${rot(size * 0.75, size * 0.45)} L ${rot(size * 1.5, 0)} L ${rot(size * 0.75, -size * 0.45)} Z`
  }
  return `M ${rot(0, 0)} L ${rot(size, size * 0.5)} L ${rot(size * 0.75, 0)} L ${rot(size, -size * 0.5)} Z`
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
