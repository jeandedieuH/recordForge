import type { TimelineCanvas, VideoClip } from "@recordforge/contracts"
import type { CanvasRect, CanvasSize } from "./composition"

/**
 * Video-layer geometry shared by the preview and the render plan (#13).
 *
 * A b-roll clip is a composited layer whose rect and opacity animate in and out.
 * Both consumers derive the pose from this module so an animated layer cannot
 * look different in the editor than in the exported file.
 */

/** Slide distance for `slide` animations, as a fraction of the layer height. */
export const VIDEO_SLIDE_FRACTION = 0.08
/** Start scale for `scale` animations. */
export const VIDEO_SCALE_START = 0.94

export interface VideoLayerPose {
  /** Canvas-pixel rect of the layer for this moment. */
  rect: CanvasRect
  opacity: number
}

function clampLayerRect(rect: CanvasRect, canvas: CanvasSize): CanvasRect {
  const width = Math.min(Math.max(10, rect.width), canvas.width)
  const height = Math.min(Math.max(10, rect.height), canvas.height)
  return {
    x: Math.min(Math.max(0, rect.x), Math.max(0, canvas.width - width)),
    y: Math.min(Math.max(0, rect.y), Math.max(0, canvas.height - height)),
    width,
    height,
  }
}

/** Scaled about the rect center, optionally shifted vertically (slide). */
function scaleAboutCenter(rect: CanvasRect, scale: number, offsetY = 0): CanvasRect {
  const width = rect.width * scale
  const height = rect.height * scale
  return {
    x: rect.x + (rect.width - width) / 2,
    y: rect.y + (rect.height - height) / 2 + offsetY,
    width,
    height,
  }
}

/** The layer's authored rect (fullscreen layouts cover the canvas). */
export function videoLayerBaseRect(
  clip: Pick<VideoClip, "layoutMode" | "x" | "y" | "width" | "height">,
  canvas: CanvasSize,
): CanvasRect {
  if (clip.layoutMode === "fullscreen") {
    return { x: 0, y: 0, width: canvas.width, height: canvas.height }
  }
  return clampLayerRect({ x: clip.x, y: clip.y, width: clip.width, height: clip.height }, canvas)
}

/**
 * Ramp lengths for a clip that plays for `durationMs`. Each ramp is capped at
 * half the duration so in and out never overlap.
 */
export function videoLayerAnimationRamps(
  clip: Pick<VideoClip, "animationIn" | "animationOut" | "animationMs">,
  durationMs: number,
): { inMs: number; outMs: number } {
  const ramp = Math.min(Math.max(0, Math.round(clip.animationMs)), Math.floor(durationMs / 2))
  return {
    inMs: clip.animationIn === "none" ? 0 : ramp,
    outMs: clip.animationOut === "none" ? 0 : ramp,
  }
}

function easeInOut(value: number): number {
  const p = Math.min(1, Math.max(0, value))
  return p * p * (3 - 2 * p)
}

/**
 * Pose for normalized ramp progress. `inProgress` runs 0→1 across the intro,
 * `outProgress` 0→1 across the outro.
 */
export function videoLayerPose(
  clip: Pick<
    VideoClip,
    "layoutMode" | "x" | "y" | "width" | "height" | "opacity" | "animationIn" | "animationOut"
  >,
  canvas: CanvasSize,
  inProgress: number,
  outProgress: number,
): VideoLayerPose {
  const base = videoLayerBaseRect(clip, canvas)
  let scale = 1
  let offsetY = 0
  let opacity = clip.opacity
  if (inProgress < 1) {
    const p = easeInOut(inProgress)
    if (clip.animationIn === "fade") opacity *= p
    if (clip.animationIn === "scale") scale *= VIDEO_SCALE_START + (1 - VIDEO_SCALE_START) * p
    if (clip.animationIn === "slide") offsetY += base.height * VIDEO_SLIDE_FRACTION * (1 - p)
  }
  if (outProgress > 0) {
    const p = easeInOut(outProgress)
    if (clip.animationOut === "fade") opacity *= 1 - p
    if (clip.animationOut === "scale") scale *= 1 - (1 - VIDEO_SCALE_START) * p
    if (clip.animationOut === "slide") offsetY -= base.height * VIDEO_SLIDE_FRACTION * p
  }
  return { rect: scaleAboutCenter(base, scale, offsetY), opacity }
}

/** Pose at an absolute timeline time (0 when outside the clip). */
export function videoLayerPoseAt(
  clip: VideoClip,
  canvas: TimelineCanvas | CanvasSize,
  playheadMs: number,
): VideoLayerPose {
  const duration = Math.max(1, clip.durationMs)
  const elapsed = playheadMs - clip.startMs
  const { inMs, outMs } = videoLayerAnimationRamps(clip, duration)
  const inProgress = inMs <= 0 ? 1 : Math.min(1, Math.max(0, elapsed / inMs))
  const outProgress =
    outMs <= 0 ? 0 : Math.min(1, Math.max(0, (elapsed - (duration - outMs)) / outMs))
  return videoLayerPose(clip, canvas, inProgress, outProgress)
}

/** Source time the clip plays at `playheadMs`. */
export function videoLayerSourceMs(clip: VideoClip, playheadMs: number): number {
  return clip.sourceInMs + Math.max(0, playheadMs - clip.startMs) * clip.speed
}
