import type {
  AnnotationClip,
  AnnotationType,
  OverlayDisplayAnnotation,
} from "@recordforge/contracts"
import { createAnnotationClipFromPreset } from "@recordforge/editor-core"
import type { AnnotationDrawSettings } from "../annotations/annotation-tools"

export interface AnnotationDrawingPoint {
  x: number
  y: number
}

export interface AnnotationDrawingBounds {
  width: number
  height: number
  minimumWidth?: number
  minimumHeight?: number
}

export interface AnnotationDrawingGeometry {
  x: number
  y: number
  width: number
  height: number
  endX?: number
  endY?: number
}

export function getAnnotationDrawingGeometry(
  type: AnnotationType,
  start: AnnotationDrawingPoint,
  current: AnnotationDrawingPoint,
  bounds: AnnotationDrawingBounds,
  constrain = false,
): AnnotationDrawingGeometry | null {
  if (
    ![start.x, start.y, current.x, current.y, bounds.width, bounds.height].every(Number.isFinite)
  ) {
    return null
  }
  if (bounds.width <= 0 || bounds.height <= 0) return null
  const x = Math.max(0, Math.min(bounds.width, start.x))
  const y = Math.max(0, Math.min(bounds.height, start.y))
  let dx = Math.max(0, Math.min(bounds.width, current.x)) - x
  let dy = Math.max(0, Math.min(bounds.height, current.y)) - y
  const isLine = type === "arrow" || type === "line"

  if (constrain) {
    if (isLine) {
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
      const length = Math.hypot(dx, dy)
      dx = Math.cos(angle) * length
      dy = Math.sin(angle) * length
      if (Math.abs(dx) < 1e-8) dx = 0
      if (Math.abs(dy) < 1e-8) dy = 0
    } else {
      const size = Math.max(Math.abs(dx), Math.abs(dy))
      dx = (dx < 0 ? -1 : 1) * size
      dy = (dy < 0 ? -1 : 1) * size
    }
    // Scale both axes together at canvas edges to preserve the Shift constraint.
    const scale = Math.min(
      1,
      dx === 0 ? 1 : (dx < 0 ? x : bounds.width - x) / Math.abs(dx),
      dy === 0 ? 1 : (dy < 0 ? y : bounds.height - y) / Math.abs(dy),
    )
    dx *= scale
    dy *= scale
  }

  const minimumWidth = Math.max(1, bounds.minimumWidth ?? 5)
  const minimumHeight = Math.max(1, bounds.minimumHeight ?? 5)
  if (isLine) {
    if (Math.hypot(dx / minimumWidth, dy / minimumHeight) < 1) return null
    return {
      x,
      y,
      // The schema requires positive bounds; signed endpoints remain the line's true geometry.
      width: Math.max(1, Math.abs(dx)),
      height: Math.max(1, Math.abs(dy)),
      endX: x + dx,
      endY: y + dy,
    }
  }
  if (Math.abs(dx) < minimumWidth || Math.abs(dy) < minimumHeight) return null
  return {
    x: Math.min(x, x + dx),
    y: Math.min(y, y + dy),
    width: Math.abs(dx),
    height: Math.abs(dy),
  }
}

export function createAnnotationDrawingClip(
  settings: AnnotationDrawSettings,
  startMs: number,
  bounds: AnnotationDrawingBounds,
): AnnotationClip {
  const clip = createAnnotationClipFromPreset(settings.preset, {
    startMs: Math.max(0, Math.round(startMs)),
    durationMs: 3_500,
    strokeColor: settings.strokeColor,
    strokeWidth: settings.strokeWidth,
    canvasWidth: bounds.width,
    canvasHeight: bounds.height,
  })
  return { ...clip, strokeStyle: settings.strokeStyle }
}

export function getAnnotationDrawingPreview(clip: AnnotationClip): OverlayDisplayAnnotation {
  // A draft is not on the timeline yet: show its final appearance without its entrance animation.
  return {
    ...clip,
    animationProgress: 1,
    drawProgress: 1,
    transform: {
      x: clip.x,
      y: clip.y,
      width: clip.width,
      height: clip.height,
      rotation: clip.rotation,
      anchorX: clip.anchorX,
      anchorY: clip.anchorY,
      zIndex: clip.zIndex,
      opacity: clip.opacity,
    },
  }
}
