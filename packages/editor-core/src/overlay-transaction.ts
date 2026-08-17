import type {
  AnnotationClip,
  ImageClip,
  OverlayAnimation,
  OverlayTransform,
  TextClip,
  TimelineState,
} from "@recordforge/domain"
import { findClip } from "@recordforge/domain"
import {
  createUpdateAnnotationClipCommand,
  createUpdateImageClipCommand,
  createUpdateTextClipCommand,
} from "./commands"
import {
  createInteractionTransaction,
  type BuildCommandResult,
  type BuildDraftCommand,
  type InteractionTransaction,
} from "./interaction-transaction"
import type { CommandResult } from "./history"

export type OverlayClip = AnnotationClip | TextClip | ImageClip

export type OverlayGestureKind =
  "move" | "resize" | "rotate" | "arrow-start" | "arrow-end" | "text-edit"

export type OverlayResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w"
export type OverlayHandle = "body" | OverlayResizeHandle | "rotate" | "arrow-start" | "arrow-end"

export interface OverlayClipUpdate {
  x?: number
  y?: number
  width?: number
  height?: number
  rotation?: number
  anchorX?: number
  anchorY?: number
  zIndex?: number
  opacity?: number
  endX?: number
  endY?: number
  overlayAnimation?: Partial<OverlayAnimation>
}

export interface OverlayGestureDraft {
  kind: OverlayGestureKind
  clipId: string
  transform: OverlayTransform
  endX?: number
  endY?: number
  update?: OverlayClipUpdate
}

export interface OverlayResizeOptions {
  minWidth: number
  minHeight: number
  preserveAspectRatio?: boolean
  fromCenter?: boolean
}

export interface OverlayBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
  width: number
  height: number
}

function editorError(code: string, message: string) {
  return { category: "editor" as const, code, message }
}

function rotateVector(x: number, y: number, degrees: number): { x: number; y: number } {
  const radians = (degrees * Math.PI) / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  return { x: x * cosine - y * sine, y: x * sine + y * cosine }
}

export function rotatePointAround(
  point: { x: number; y: number },
  pivot: { x: number; y: number },
  degrees: number,
): { x: number; y: number } {
  const rotated = rotateVector(point.x - pivot.x, point.y - pivot.y, degrees)
  return { x: pivot.x + rotated.x, y: pivot.y + rotated.y }
}

export function getOverlayBounds(transform: OverlayTransform): OverlayBounds {
  const pivot = {
    x: transform.x + transform.width * transform.anchorX,
    y: transform.y + transform.height * transform.anchorY,
  }
  const corners = [
    { x: transform.x, y: transform.y },
    { x: transform.x + transform.width, y: transform.y },
    { x: transform.x + transform.width, y: transform.y + transform.height },
    { x: transform.x, y: transform.y + transform.height },
  ].map((corner) => rotatePointAround(corner, pivot, transform.rotation))
  const minX = Math.min(...corners.map((corner) => corner.x))
  const maxX = Math.max(...corners.map((corner) => corner.x))
  const minY = Math.min(...corners.map((corner) => corner.y))
  const maxY = Math.max(...corners.map((corner) => corner.y))
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY }
}

function constrainAxis(
  min: number,
  max: number,
  canvasSize: number,
  allowedOverflowRatio: number,
): number {
  const allowedOverflow = (max - min) * allowedOverflowRatio
  const minShift = -allowedOverflow - min
  const maxShift = canvasSize + allowedOverflow - max
  if (minShift > 0 && maxShift < 0) return 0
  return Math.max(minShift, 0) + Math.min(maxShift, 0)
}

export function constrainOverlayTransform(
  transform: OverlayTransform,
  canvasWidth: number,
  canvasHeight: number,
  allowedOverflowRatio = 0.25,
): OverlayTransform {
  const bounds = getOverlayBounds(transform)
  const shiftX = constrainAxis(bounds.minX, bounds.maxX, canvasWidth, allowedOverflowRatio)
  const shiftY = constrainAxis(bounds.minY, bounds.maxY, canvasHeight, allowedOverflowRatio)
  return { ...transform, x: transform.x + shiftX, y: transform.y + shiftY }
}

export function snapOverlayCoordinate(
  value: number,
  gridSize = 8,
  threshold = 12,
  disabled = false,
): number {
  if (disabled || gridSize <= 0) return value
  const snapped = Math.round(value / gridSize) * gridSize
  return Math.abs(snapped - value) <= threshold ? snapped : value
}

export function snapOverlayPoint(
  point: { x: number; y: number },
  options: { disabled?: boolean; gridSize?: number; threshold?: number } = {},
): { x: number; y: number } {
  return {
    x: snapOverlayCoordinate(
      point.x,
      options.gridSize ?? 8,
      options.threshold ?? 12,
      options.disabled ?? false,
    ),
    y: snapOverlayCoordinate(
      point.y,
      options.gridSize ?? 8,
      options.threshold ?? 12,
      options.disabled ?? false,
    ),
  }
}

export function moveOverlayTransform(
  start: OverlayTransform,
  deltaX: number,
  deltaY: number,
  options: {
    canvasWidth: number
    canvasHeight: number
    snapDisabled?: boolean
  },
): OverlayTransform {
  const point = snapOverlayPoint(
    { x: start.x + deltaX, y: start.y + deltaY },
    { disabled: options.snapDisabled },
  )
  return constrainOverlayTransform(
    { ...start, x: point.x, y: point.y },
    options.canvasWidth,
    options.canvasHeight,
  )
}

function includesHorizontal(handle: OverlayResizeHandle): boolean {
  return (
    handle === "nw" ||
    handle === "w" ||
    handle === "sw" ||
    handle === "ne" ||
    handle === "e" ||
    handle === "se"
  )
}

function includesVertical(handle: OverlayResizeHandle): boolean {
  return (
    handle === "nw" ||
    handle === "n" ||
    handle === "ne" ||
    handle === "sw" ||
    handle === "s" ||
    handle === "se"
  )
}

function horizontalAnchor(handle: OverlayResizeHandle): "start" | "end" | "center" {
  if (handle === "nw" || handle === "w" || handle === "sw") return "end"
  if (handle === "ne" || handle === "e" || handle === "se") return "start"
  return "center"
}

function verticalAnchor(handle: OverlayResizeHandle): "start" | "end" | "center" {
  if (handle === "nw" || handle === "n" || handle === "ne") return "end"
  if (handle === "sw" || handle === "s" || handle === "se") return "start"
  return "center"
}

function fitAxis(
  start: number,
  end: number,
  size: number,
  anchor: "start" | "end" | "center",
  fromCenter: boolean,
): [number, number] {
  if (fromCenter || anchor === "center") {
    const center = (start + end) / 2
    return [center - size / 2, center + size / 2]
  }
  if (anchor === "start") return [start, start + size]
  return [end - size, end]
}

function enforceMinimum(
  start: number,
  end: number,
  minimum: number,
  anchor: "start" | "end" | "center",
  fromCenter: boolean,
): [number, number] {
  const size = Math.max(minimum, end - start)
  return fitAxis(start, end, size, anchor, fromCenter)
}

export function resizeOverlayTransform(
  start: OverlayTransform,
  handle: OverlayResizeHandle,
  deltaX: number,
  deltaY: number,
  options: OverlayResizeOptions,
): OverlayTransform {
  const localDelta = rotateVector(deltaX, deltaY, -start.rotation)
  let left = 0
  let top = 0
  let right = start.width
  let bottom = start.height
  const fromCenter = options.fromCenter ?? false

  if (handle === "nw" || handle === "w" || handle === "sw") left += localDelta.x
  if (handle === "ne" || handle === "e" || handle === "se") right += localDelta.x
  if (handle === "nw" || handle === "n" || handle === "ne") top += localDelta.y
  if (handle === "sw" || handle === "s" || handle === "se") bottom += localDelta.y

  if (fromCenter) {
    if (handle === "nw" || handle === "w" || handle === "sw") right -= localDelta.x
    if (handle === "ne" || handle === "e" || handle === "se") left -= localDelta.x
    if (handle === "nw" || handle === "n" || handle === "ne") bottom -= localDelta.y
    if (handle === "sw" || handle === "s" || handle === "se") top -= localDelta.y
  }

  const horizontal = includesHorizontal(handle)
  const vertical = includesVertical(handle)
  const horizontalEdge = horizontal ? horizontalAnchor(handle) : "center"
  const verticalEdge = vertical ? verticalAnchor(handle) : "center"
  const preserveAspectRatio = options.preserveAspectRatio ?? false

  if (preserveAspectRatio) {
    const ratio = start.width / Math.max(1, start.height)
    const minimumWidth = Math.max(options.minWidth, options.minHeight * ratio)
    const minimumHeight = Math.max(options.minHeight, options.minWidth / Math.max(ratio, 0.0001))
    const requestedWidth = Math.max(0, right - left)
    const requestedHeight = Math.max(0, bottom - top)
    let width: number
    let height: number

    if (horizontal && !vertical) {
      width = Math.max(minimumWidth, requestedWidth)
      height = width / Math.max(ratio, 0.0001)
    } else if (vertical && !horizontal) {
      height = Math.max(minimumHeight, requestedHeight)
      width = height * ratio
    } else {
      const widthFromHeight = requestedHeight * ratio
      width = Math.max(minimumWidth, requestedWidth, widthFromHeight)
      height = width / Math.max(ratio, 0.0001)
      if (requestedHeight > requestedWidth / Math.max(ratio, 0.0001)) {
        height = Math.max(minimumHeight, requestedHeight)
        width = height * ratio
      }
    }

    ;[left, right] = fitAxis(left, right, width, horizontalEdge, fromCenter)
    ;[top, bottom] = fitAxis(top, bottom, height, verticalEdge, fromCenter)
  } else {
    ;[left, right] = enforceMinimum(left, right, options.minWidth, horizontalEdge, fromCenter)
    ;[top, bottom] = enforceMinimum(top, bottom, options.minHeight, verticalEdge, fromCenter)
  }

  return {
    ...start,
    x: start.x + left,
    y: start.y + top,
    width: right - left,
    height: bottom - top,
  }
}

export function rotateOverlayTransform(
  start: OverlayTransform,
  startPoint: { x: number; y: number },
  currentPoint: { x: number; y: number },
  snapToDegrees = 15,
): OverlayTransform {
  const pivot = {
    x: start.x + start.width * start.anchorX,
    y: start.y + start.height * start.anchorY,
  }
  const startAngle = Math.atan2(startPoint.y - pivot.y, startPoint.x - pivot.x)
  const currentAngle = Math.atan2(currentPoint.y - pivot.y, currentPoint.x - pivot.x)
  let rotation = start.rotation + ((currentAngle - startAngle) * 180) / Math.PI
  rotation = ((((rotation + 180) % 360) + 360) % 360) - 180
  if (snapToDegrees > 0) rotation = Math.round(rotation / snapToDegrees) * snapToDegrees
  return { ...start, rotation }
}

export function overlayTransformFromClip(clip: OverlayClip): OverlayTransform {
  return {
    x: clip.x,
    y: clip.y,
    width: clip.width,
    height: clip.height,
    rotation: clip.rotation,
    anchorX: clip.anchorX,
    anchorY: clip.anchorY,
    zIndex: clip.zIndex,
    opacity: clip.opacity,
  }
}

export function overlayMinimumSize(clip: OverlayClip): { width: number; height: number } {
  if (clip.kind === "annotation") return { width: 20, height: 20 }
  if (clip.kind === "text") return { width: 80, height: 40 }
  return { width: 40, height: 40 }
}

function transformUpdate(transform: OverlayTransform) {
  return {
    x: transform.x,
    y: transform.y,
    width: transform.width,
    height: transform.height,
    rotation: transform.rotation,
    anchorX: transform.anchorX,
    anchorY: transform.anchorY,
    zIndex: transform.zIndex,
    opacity: transform.opacity,
  }
}

export function buildOverlayCommand(
  draft: OverlayGestureDraft,
  base: TimelineState,
): CommandResult<BuildCommandResult> {
  const found = findClip(base, draft.clipId)
  if (!found) {
    return { ok: false, error: editorError("clip_not_found", "Overlay clip not found") }
  }
  if (
    found.clip.kind !== "annotation" &&
    found.clip.kind !== "text" &&
    found.clip.kind !== "image"
  ) {
    return { ok: false, error: editorError("invalid_clip", "Clip is not an overlay") }
  }
  if (found.track.locked || found.clip.locked) {
    return { ok: false, error: editorError("overlay_locked", "Overlay is locked") }
  }

  const commonUpdate = transformUpdate(draft.transform)
  if (found.clip.kind === "annotation") {
    const update = {
      ...(draft.update ?? {}),
      ...commonUpdate,
      ...(draft.endX === undefined ? {} : { endX: draft.endX }),
      ...(draft.endY === undefined ? {} : { endY: draft.endY }),
    }
    return {
      ok: true,
      value: { command: createUpdateAnnotationClipCommand(draft.clipId, update), hint: null },
    }
  }
  if (found.clip.kind === "text") {
    const update = { ...(draft.update ?? {}), ...commonUpdate }
    return {
      ok: true,
      value: { command: createUpdateTextClipCommand(draft.clipId, update), hint: null },
    }
  }
  const update = { ...(draft.update ?? {}), ...commonUpdate }
  return {
    ok: true,
    value: { command: createUpdateImageClipCommand(draft.clipId, update), hint: null },
  }
}

export function createOverlayTransaction(
  buildCommand: BuildDraftCommand<OverlayGestureDraft> = buildOverlayCommand,
): InteractionTransaction<OverlayGestureDraft> {
  return createInteractionTransaction(buildCommand)
}
