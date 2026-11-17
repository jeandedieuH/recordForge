import type { CameraFrameShape } from "@recordforge/contracts"
import type { ResolvedCameraStyle } from "@recordforge/editor-core"

/**
 * Pure CSS helpers for the camera frame view (ADR 023). The resolver emits
 * canvas-px geometry and style; the preview DOM is percentage-positioned, so
 * the only thing these helpers do is scale px lengths by `previewScale`
 * (CSS px per canvas px) — every surface then agrees with the exporter at any
 * preview zoom.
 */

export function mixBorderColor(color: string | undefined, opacity: number | undefined): string {
  const source = color ?? "var(--color-foreground)"
  const alpha = Math.max(0, Math.min(1, opacity ?? 1))
  return `color-mix(in srgb, ${source} ${Math.round(alpha * 100)}%, transparent)`
}

/**
 * CSS `border-radius` for the resolved shape: circles keep `50%` (an ellipse
 * matches the export's circular mask on any aspect), rounded/rectangle use
 * the resolved px radius scaled to the preview — never a percentage, which
 * would be elliptical.
 */
export function cssBorderRadius(
  shape: CameraFrameShape,
  radiusPx: number,
  previewScale: number,
): string {
  if (shape === "circle") return "50%"
  return `${Math.max(0, radiusPx * previewScale)}px`
}

/** CSS `border` for solid borders; richer treatments render via BorderOverlay. */
export function cssSolidBorder(
  style: ResolvedCameraStyle,
  previewScale: number,
): string | undefined {
  const borderStyle = style.borderStyle ?? "solid"
  if (borderStyle !== "solid" || !style.borderWidth) return undefined
  return `${style.borderWidth * previewScale}px solid ${mixBorderColor(
    style.borderColor,
    style.borderOpacity,
  )}`
}

/** CSS `box-shadow` with px lengths scaled like the border. */
export function cssShadow(style: ResolvedCameraStyle, previewScale: number): string | undefined {
  if (!style.shadowEnabled) return undefined
  return `${style.shadowOffsetX * previewScale}px ${style.shadowOffsetY * previewScale}px ${
    style.shadowBlur * previewScale
  }px ${style.shadowColor}`
}

/**
 * Ring radius for `BorderOverlay` in CSS px. Circles pass 0 because the
 * overlay's `circular` prop draws the ellipse itself.
 */
export function borderRingRadiusPx(
  shape: CameraFrameShape,
  radiusPx: number,
  previewScale: number,
): number {
  if (shape !== "rounded") return 0
  return Math.max(0, radiusPx * previewScale)
}
