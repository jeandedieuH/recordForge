import type {
  CameraLayoutKind,
  CameraLayoutSegment,
  ClipTransform,
  TimelineState,
} from "@recordforge/contracts"
import { zoomEasedProgress, type CanvasRect, type CanvasSize } from "./composition"

/**
 * Camera layout lane (modern-features #5).
 *
 * A camera layout segment animates the camera bubble between the four layout
 * modes the editor supports (`pip`, `fullscreen`, `hidden`, `side-by-side`).
 * Outside every segment the camera clip's transform is the base layout, so an
 * existing project keeps today's picture without a single added field.
 *
 * The resolver is the single source of truth for the preview and the export
 * plan: rects, corner radius and opacity are interpolated, which is what lets a
 * circle morph into a rectangle through the radius instead of snapping.
 */

/** Camera margin as a fraction of the canvas height for corner PiP layouts. */
export const CAMERA_LAYOUT_MARGIN_FRACTION = 0.04
/** Corner radius as a fraction of the shorter side for `rounded` shapes. */
export const CAMERA_LAYOUT_ROUNDED_FRACTION = 0.08
/** Transition samples written into the render plan (ms). */
export const CAMERA_LAYOUT_KEYFRAME_STEP_MS = 80

export interface CameraLayoutPose {
  /** Camera rect on the canvas, in canvas pixels. */
  camera: CanvasRect
  /** Screen rect on the canvas (side-by-side shrinks it). */
  screen: CanvasRect
  radius: number
  opacity: number
  shape: "rectangle" | "rounded" | "circle"
}

export interface CameraLayoutWindow {
  segment: CameraLayoutSegment
  /** Pose held between the transition-in and transition-out phases. */
  pose: CameraLayoutPose
  /** Pose at the segment start (the previous layout, or the base). */
  fromPose: CameraLayoutPose
  /** Pose the segment relaxes into at its end (next layout, or the base). */
  toPose: CameraLayoutPose
  startMs: number
  endMs: number
}

export interface ResolvedCameraLayout {
  pose: CameraLayoutPose
  layout: CameraLayoutKind | "base"
  segmentId: string | null
}

function clampRectToCanvas(rect: CanvasRect, canvas: CanvasSize): CanvasRect {
  const width = Math.max(0, Math.min(rect.width, canvas.width))
  const height = Math.max(0, Math.min(rect.height, canvas.height))
  return {
    x: Math.max(0, Math.min(rect.x, Math.max(0, canvas.width - width))),
    y: Math.max(0, Math.min(rect.y, Math.max(0, canvas.height - height))),
    width,
    height,
  }
}

/** The fitted screen rect: the canvas inset by the canvas padding. */
export function screenContentRect(
  canvas: Pick<CanvasSize, "width" | "height"> & { padding?: number },
): CanvasRect {
  const padding = Math.max(0, canvas.padding ?? 0)
  const width = Math.max(1, canvas.width - padding * 2)
  const height = Math.max(1, canvas.height - padding * 2)
  return { x: padding, y: padding, width, height }
}

function radiusForShape(rect: CanvasRect, shape: CameraLayoutPose["shape"]): number {
  if (shape === "circle") return Math.min(rect.width, rect.height) / 2
  if (shape === "rounded") {
    return Math.round(Math.min(rect.width, rect.height) * CAMERA_LAYOUT_ROUNDED_FRACTION)
  }
  return 0
}

/**
 * Base pose from a camera clip transform. The clip transform is authored in
 * canvas pixels, so it maps straight onto the pose; the screen keeps the fitted
 * content rect.
 */
export function baseCameraLayoutPose(
  canvas: Pick<CanvasSize, "width" | "height"> & { padding?: number },
  transform: Pick<ClipTransform, "x" | "y" | "width" | "height" | "shape" | "opacity"> | null,
): CameraLayoutPose {
  const screen = screenContentRect(canvas)
  if (!transform) {
    const full = { x: 0, y: 0, width: canvas.width, height: canvas.height }
    return {
      camera: full,
      screen,
      radius: 0,
      opacity: 1,
      shape: "rectangle",
    }
  }
  const camera = clampRectToCanvas(
    {
      x: transform.x,
      y: transform.y,
      width: transform.width,
      height: transform.height,
    },
    canvas,
  )
  return {
    camera,
    screen,
    radius: radiusForShape(camera, transform.shape),
    opacity: Math.min(1, Math.max(0, transform.opacity)),
    shape: transform.shape,
  }
}

function aspectFor(base: CameraLayoutPose): number {
  if (base.camera.height > 0 && base.camera.width > 0) {
    return base.camera.width / base.camera.height
  }
  return 16 / 9
}

function pipCameraRect(
  segment: CameraLayoutSegment,
  canvas: CanvasSize,
  base: CameraLayoutPose,
): CanvasRect {
  const pip = segment.pip
  const margin = Math.round(canvas.height * CAMERA_LAYOUT_MARGIN_FRACTION)
  const fraction = Math.min(0.6, Math.max(0.05, pip?.sizeFraction ?? 0.24))
  const height = Math.max(2, Math.round(canvas.height * fraction))
  const width = Math.max(2, Math.round(height * aspectFor(base)))
  const corner = pip?.corner ?? "br"
  if (corner === "custom") {
    return clampRectToCanvas(
      {
        x: Math.round((pip?.x ?? 0.7) * canvas.width),
        y: Math.round((pip?.y ?? 0.7) * canvas.height),
        width,
        height,
      },
      canvas,
    )
  }
  const x = corner === "tl" || corner === "bl" ? margin : canvas.width - width - margin
  const y = corner === "tl" || corner === "tr" ? margin : canvas.height - height - margin
  return clampRectToCanvas({ x, y, width, height }, canvas)
}

/** Steady-state pose for one segment against the current base layout. */
export function cameraLayoutPose(
  canvas: Pick<CanvasSize, "width" | "height"> & { padding?: number },
  segment: CameraLayoutSegment,
  base: CameraLayoutPose,
): CameraLayoutPose {
  const screen = screenContentRect(canvas)
  const full = { x: 0, y: 0, width: canvas.width, height: canvas.height }
  switch (segment.layout) {
    case "fullscreen":
      return { camera: full, screen, radius: 0, opacity: 1, shape: "rectangle" }
    case "hidden":
      // Keep the base rect so `hidden` can fade out and back in place.
      return { ...base, screen, opacity: 0 }
    case "side-by-side": {
      const halfWidth = Math.round(canvas.width / 2)
      return {
        camera: clampRectToCanvas(
          { x: halfWidth, y: 0, width: canvas.width - halfWidth, height: canvas.height },
          canvas,
        ),
        screen: { x: 0, y: 0, width: halfWidth, height: canvas.height },
        radius: 0,
        opacity: 1,
        shape: "rectangle",
      }
    }
    case "pip":
    default: {
      const shape = segment.pip?.shape ?? "rounded"
      const camera = pipCameraRect(segment, { width: canvas.width, height: canvas.height }, base)
      return { camera, screen, radius: radiusForShape(camera, shape), opacity: 1, shape }
    }
  }
}

export interface CameraLayoutWindowOptions {
  /** Base pose (the camera clip transform). */
  base: CameraLayoutPose
  /** Segments closer than this bridge instead of relaxing to the base. */
  bridgeGapMs?: number
}

/**
 * Build the ordered, bridged layout windows for a timeline. Adjacent segments
 * with a short gap keep the previous pose through the gap, mirroring
 * `resolveCameraShots` for zoom.
 */
export function resolveCameraLayoutWindows(
  canvas: Pick<CanvasSize, "width" | "height"> & { padding?: number },
  segments: CameraLayoutSegment[],
  options: CameraLayoutWindowOptions,
): CameraLayoutWindow[] {
  const bridgeGapMs = options.bridgeGapMs ?? 0
  const base = options.base
  const enabled = segments
    .filter((segment) => segment.enabled)
    .map((segment) => ({ ...segment }))
    .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))

  const windows: CameraLayoutWindow[] = []
  let previous: CameraLayoutWindow | null = null
  for (const segment of enabled) {
    const startMs = Math.max(0, Math.round(segment.startMs))
    const endMs = startMs + Math.max(1, Math.round(segment.durationMs))
    const pose = cameraLayoutPose(canvas, segment, base)
    // A contiguous (or short-gap) neighbour keeps the previous pose so the lane
    // never relaxes to the base between two adjacent segments.
    let fromPose = base
    if (previous) {
      const adjacent = startMs >= previous.endMs && startMs - previous.endMs <= bridgeGapMs
      if (adjacent) {
        fromPose = previous.pose
        previous.toPose = pose
      }
    }
    const window: CameraLayoutWindow = {
      segment,
      pose,
      fromPose,
      toPose: base,
      startMs,
      endMs,
    }
    windows.push(window)
    previous = window
  }
  return windows
}

function lerp(from: number, to: number, progress: number): number {
  return from + (to - from) * progress
}

function lerpRect(from: CanvasRect, to: CanvasRect, progress: number): CanvasRect {
  return {
    x: lerp(from.x, to.x, progress),
    y: lerp(from.y, to.y, progress),
    width: lerp(from.width, to.width, progress),
    height: lerp(from.height, to.height, progress),
  }
}

/** Linear pose blend; the easing is applied by the caller. */
export function blendCameraLayoutPose(
  from: CameraLayoutPose,
  to: CameraLayoutPose,
  progress: number,
): CameraLayoutPose {
  const p = Math.min(1, Math.max(0, progress))
  return {
    camera: lerpRect(from.camera, to.camera, p),
    screen: lerpRect(from.screen, to.screen, p),
    radius: lerp(from.radius, to.radius, p),
    opacity: lerp(from.opacity, to.opacity, p),
    // Shape follows the incoming pose past the midpoint so the shader mask
    // flips once while the radius is already interpolating.
    shape: p < 0.5 ? from.shape : to.shape,
  }
}

/** Evaluate one window's pose at an absolute timeline time. */
export function evaluateCameraLayoutWindow(
  window: CameraLayoutWindow,
  timeMs: number,
): CameraLayoutPose {
  const duration = Math.max(1, window.endMs - window.startMs)
  const segment = window.segment
  const declaredIn = Math.max(0, Math.round(segment.transitionInMs ?? 0))
  const declaredOut = Math.max(0, Math.round(segment.transitionOutMs ?? 0))
  let transitionInMs = Math.min(duration, declaredIn)
  let transitionOutMs = Math.min(duration, declaredOut)
  if (transitionInMs + transitionOutMs > duration) {
    transitionInMs = Math.round(duration / 2)
    transitionOutMs = duration - transitionInMs
  }
  const elapsed = timeMs - window.startMs
  const remaining = window.endMs - timeMs
  if (transitionInMs > 0 && elapsed < transitionInMs) {
    const progress = zoomEasedProgress(elapsed / transitionInMs, segment.easing)
    return blendCameraLayoutPose(window.fromPose, window.pose, progress)
  }
  if (transitionOutMs > 0 && remaining < transitionOutMs) {
    const progress = zoomEasedProgress(1 - Math.max(0, remaining) / transitionOutMs, segment.easing)
    return blendCameraLayoutPose(window.pose, window.toPose, progress)
  }
  return window.pose
}

/**
 * Resolve the active camera layout at a timeline time. `null` means no layout
 * window applies, so the caller keeps the clip transform.
 */
export function resolveCameraLayoutAt(
  state: TimelineState,
  timeMs: number,
  baseTransform: ClipTransform | null,
): ResolvedCameraLayout | null {
  return resolveCameraLayoutPoseAt(state.canvas, state.cameraLayouts ?? [], timeMs, baseTransform)
}

/**
 * Canvas-only variant of [`resolveCameraLayoutAt`] for the preview surfaces,
 * which hold the canvas geometry rather than the whole timeline.
 */
export function resolveCameraLayoutPoseAt(
  canvas: Pick<CanvasSize, "width" | "height"> & { padding?: number },
  segments: CameraLayoutSegment[],
  timeMs: number,
  baseTransform: ClipTransform | null,
): ResolvedCameraLayout | null {
  if (segments.length === 0) return null
  const base = baseCameraLayoutPose(canvas, baseTransform)
  const windows = resolveCameraLayoutWindows(canvas, segments, {
    base,
    bridgeGapMs: 0,
  })
  const window = windows
    .filter((candidate) => timeMs >= candidate.startMs && timeMs < candidate.endMs)
    .pop()
  if (!window) return null
  return {
    pose: evaluateCameraLayoutWindow(window, timeMs),
    layout: window.segment.layout,
    segmentId: window.segment.id,
  }
}

/** Requested layout at `timeMs`, ignoring transition easing. */
export function findCameraLayoutSegmentAt(
  state: TimelineState,
  timeMs: number,
): CameraLayoutSegment | null {
  return (
    (state.cameraLayouts ?? [])
      .filter(
        (segment) =>
          segment.enabled &&
          timeMs >= segment.startMs &&
          timeMs < segment.startMs + segment.durationMs,
      )
      .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))
      .slice(-1)[0] ?? null
  )
}

/**
 * Sample a window's pose into render-plan keyframes. Transitions are sampled at
 * `CAMERA_LAYOUT_KEYFRAME_STEP_MS`, holds only need their endpoints, and the
 * renderer interpolates linearly between samples.
 */
export function sampleCameraLayoutKeyframes(
  window: CameraLayoutWindow,
  stepMs = CAMERA_LAYOUT_KEYFRAME_STEP_MS,
): Array<CameraLayoutPose & { timeMs: number }> {
  const times = new Set<number>([window.startMs, window.endMs])
  const segment = window.segment
  const duration = window.endMs - window.startMs
  const transitionInMs = Math.min(Math.max(0, segment.transitionInMs ?? 0), duration)
  const transitionOutMs = Math.min(Math.max(0, segment.transitionOutMs ?? 0), duration)
  // Transition boundaries are explicit samples so a hold stays flat instead of
  // drifting between the last eased sample and the other end of the segment.
  if (transitionInMs > 0) times.add(window.startMs + transitionInMs)
  if (transitionOutMs > 0) times.add(window.endMs - transitionOutMs)
  const pushRange = (fromMs: number, toMs: number) => {
    const step = Math.max(1, Math.round(stepMs))
    for (let time = fromMs + step; time < toMs; time += step) times.add(time)
  }
  pushRange(window.startMs, window.startMs + transitionInMs)
  pushRange(window.endMs - transitionOutMs, window.endMs)
  return [...times]
    .sort((left, right) => left - right)
    .map((timeMs) => ({ timeMs, ...evaluateCameraLayoutWindow(window, timeMs) }))
}

/** Effective camera opacity for a layout pause (`hidden` renders at 0). */
export function cameraLayoutIsHidden(layout: ResolvedCameraLayout | null): boolean {
  return layout !== null && layout.pose.opacity <= 0.001
}

const CAMERA_LAYOUT_CYCLE: Record<CameraLayoutKind, CameraLayoutKind> = {
  pip: "fullscreen",
  fullscreen: "side-by-side",
  "side-by-side": "hidden",
  hidden: "pip",
}

/** Next layout in the lane's click-to-cycle order. */
export function nextCameraLayoutKind(kind: CameraLayoutKind): CameraLayoutKind {
  return CAMERA_LAYOUT_CYCLE[kind]
}
