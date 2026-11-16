// Pure geometry/colour helpers for the camera cutout preview (#4b).
//
// Each helper mirrors a decision the export renderer makes in FFmpeg/WGSL so the
// WebGL preview frames the subject and paints the background the same way:
// - `object-fit: cover` for the plain video surface,
// - the matte's `lut=y='clip((val-shift)*1.04,0,255)'` edge shrink, and
// - a blur radius expressed in the display's pixels.

export interface NormalizedCrop {
  x: number
  y: number
  width: number
  height: number
}

export const FULL_FRAME_CROP: NormalizedCrop = { x: 0, y: 0, width: 1, height: 1 }

/**
 * The largest centred window of `sourceAspect` that has `targetAspect` — the
 * crop CSS `object-fit: cover` applies to the camera bubble.
 */
export function centerCoverCrop(sourceAspect: number, targetAspect: number): NormalizedCrop {
  if (
    !Number.isFinite(sourceAspect) ||
    !Number.isFinite(targetAspect) ||
    sourceAspect <= 0 ||
    targetAspect <= 0
  ) {
    return FULL_FRAME_CROP
  }
  if (sourceAspect >= targetAspect) {
    const width = targetAspect / sourceAspect
    return { x: (1 - width) / 2, y: 0, width, height: 1 }
  }
  const height = sourceAspect / targetAspect
  return { x: 0, y: (1 - height) / 2, width: 1, height }
}

/**
 * Matte luma shift for `edgeShrink`, normalized to 0..1. Positive values pull
 * the matte in; the renderer applies the same `round(shrink * 12)` step.
 */
export function matteShrinkShift(edgeShrink: number): number {
  const clamped = Math.max(-8, Math.min(8, Number.isFinite(edgeShrink) ? edgeShrink : 0))
  return Math.round(clamped * 12) / 255
}

/**
 * Blur radius in normalized source UV. `blurRadius` is measured in the camera
 * bubble's display pixels (what FFmpeg's `boxblur` sees), so it is rescaled by
 * the crop-to-display ratio on each axis.
 */
export function cutoutBlurUv(
  blurRadius: number,
  crop: NormalizedCrop,
  displayWidth: number,
  displayHeight: number,
): readonly [number, number] {
  const radius = Math.max(0, Number.isFinite(blurRadius) ? blurRadius : 0)
  const dx = displayWidth > 0 ? (radius * crop.width) / displayWidth : 0
  const dy = displayHeight > 0 ? (radius * crop.height) / displayHeight : 0
  return [dx, dy]
}

/** Parse the colour picker's `#rgb`/`#rrggbb` into normalized RGB. */
export function parseCutoutColor(color: string | undefined): readonly [number, number, number] {
  // #0f172a — the same default the renderer falls back to.
  const fallback: readonly [number, number, number] = [0.0588, 0.0902, 0.1647]
  if (!color) return fallback
  const hex = color.trim().replace(/^#/, "")
  if (!/^(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex)) return fallback
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((char) => char + char)
          .join("")
      : hex
  const value = Number.parseInt(full, 16)
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255]
}

/** UV transform (scale, offset) that cover-fits a background image to the crop. */
export function backgroundCoverUv(
  imageAspect: number,
  frameAspect: number,
): readonly [number, number, number, number] {
  if (
    !Number.isFinite(imageAspect) ||
    !Number.isFinite(frameAspect) ||
    imageAspect <= 0 ||
    frameAspect <= 0
  ) {
    return [1, 1, 0, 0]
  }
  if (imageAspect >= frameAspect) {
    // Image is wider: sample a narrower horizontal window.
    const scaleX = frameAspect / imageAspect
    return [scaleX, 1, (1 - scaleX) / 2, 0]
  }
  const scaleY = imageAspect / frameAspect
  return [1, scaleY, 0, (1 - scaleY) / 2]
}
