import type { KeystrokeTheme } from "@recordforge/contracts"

/**
 * Canvas-space metrics for the badge. Everything is derived from the canvas
 * height so the overlay scales naturally across resolutions and is multiplied
 * by the user's `scale` setting. The Rust mirror in
 * `apps/desktop/src-tauri/src/exports/keystrokes.rs` must keep these formulas
 * identical — the shared layout fixture enforces it.
 */
export interface KeystrokeMetrics {
  /** Keycap height — the badge's base unit. */
  capHeightPx: number
  /** Horizontal padding inside a text cap. */
  capPadXPx: number
  /** Gap between keycaps inside a row. */
  capGapPx: number
  /** Vertical gap between stacked rows. */
  rowGapPx: number
  /** Pill padding around the caps. */
  pillPadXPx: number
  pillPadYPx: number
  capRadiusPx: number
  pillRadiusPx: number
  /** JetBrains Mono cap label size. */
  fontPx: number
  /** Side of the square box a glyph icon is drawn in. */
  glyphBoxPx: number
  /** Badge anchor distance from the canvas edge. */
  marginPx: number
  /** Soft drop shadow under the pill. */
  shadowBlurPx: number
  shadowOffsetYPx: number
  /** Text advance used for cap width — JetBrains Mono is fixed 0.6em. */
  charAdvancePx: number
}

/** Baseline badge size ≈ 41px caps on a 1080p canvas at scale 1. */
const CAP_HEIGHT_RATIO = 0.038

export function keystrokeMetrics(canvasHeight: number, scale: number): KeystrokeMetrics {
  const capHeightPx = Math.max(18, Math.round(canvasHeight * CAP_HEIGHT_RATIO * scale))
  const fontPx = Math.round(capHeightPx * 0.46)
  return {
    capHeightPx,
    capPadXPx: Math.round(capHeightPx * 0.34),
    capGapPx: Math.max(2, Math.round(capHeightPx * 0.14)),
    rowGapPx: Math.max(6, Math.round(capHeightPx * 0.3)),
    pillPadXPx: Math.round(capHeightPx * 0.32),
    pillPadYPx: Math.round(capHeightPx * 0.24),
    capRadiusPx: Math.round(capHeightPx * 0.26),
    pillRadiusPx: Math.round(capHeightPx * 0.4),
    fontPx,
    glyphBoxPx: Math.round(capHeightPx * 0.52),
    marginPx: Math.round(canvasHeight * 0.055),
    shadowBlurPx: Math.round(capHeightPx * 0.3),
    shadowOffsetYPx: Math.round(capHeightPx * 0.08),
    charAdvancePx: fontPx * 0.6,
  }
}

/**
 * Width of a single keycap. Glyph caps are square; text caps pad around the
 * mono-advance text width. Shared by the DOM preview and the export
 * rasterizer so both agree on row geometry before drawing anything.
 */
export function capWidthPx(
  kind: "glyph" | "text",
  textLength: number,
  m: KeystrokeMetrics,
): number {
  if (kind === "glyph") return m.capHeightPx
  return m.capPadXPx * 2 + Math.max(1, textLength) * m.charAdvancePx
}

export interface KeystrokeThemeSpec {
  pillFill: string
  pillOpacity: number
  pillStroke: string
  pillStrokeOpacity: number
  /** Keycap vertical gradient, top → bottom. */
  capFillTop: string
  capFillTopOpacity: number
  capFillBottom: string
  capFillBottomOpacity: number
  capStroke: string
  capStrokeOpacity: number
  /** Subtle top highlight inside each cap — the "key edge". */
  capHighlight: string
  capHighlightOpacity: number
  text: string
  textOpacity: number
  /** Dimmed tint for the repeat-count suffix. */
  countText: string
  countTextOpacity: number
  shadowColor: string
  shadowOpacity: number
}

export const KEYSTROKE_THEMES: Record<KeystrokeTheme, KeystrokeThemeSpec> = {
  dark: {
    pillFill: "#0B0E14",
    pillOpacity: 0.78,
    pillStroke: "#FFFFFF",
    pillStrokeOpacity: 0.08,
    capFillTop: "#FFFFFF",
    capFillTopOpacity: 0.13,
    capFillBottom: "#FFFFFF",
    capFillBottomOpacity: 0.05,
    capStroke: "#FFFFFF",
    capStrokeOpacity: 0.12,
    capHighlight: "#FFFFFF",
    capHighlightOpacity: 0.16,
    text: "#F4F7FB",
    textOpacity: 1,
    countText: "#9FB0C8",
    countTextOpacity: 1,
    shadowColor: "#000000",
    shadowOpacity: 0.4,
  },
  light: {
    pillFill: "#FAFBFD",
    pillOpacity: 0.9,
    pillStroke: "#0F172A",
    pillStrokeOpacity: 0.08,
    capFillTop: "#FFFFFF",
    capFillTopOpacity: 1,
    capFillBottom: "#EEF2F7",
    capFillBottomOpacity: 1,
    capStroke: "#0F172A",
    capStrokeOpacity: 0.1,
    capHighlight: "#FFFFFF",
    capHighlightOpacity: 0.9,
    text: "#0F172A",
    textOpacity: 1,
    countText: "#5B6B82",
    countTextOpacity: 1,
    shadowColor: "#0F172A",
    shadowOpacity: 0.22,
  },
  contrast: {
    pillFill: "#05070B",
    pillOpacity: 0.94,
    pillStroke: "#FFFFFF",
    pillStrokeOpacity: 0,
    capFillTop: "#232936",
    capFillTopOpacity: 1,
    capFillBottom: "#181D29",
    capFillBottomOpacity: 1,
    capStroke: "#FFFFFF",
    capStrokeOpacity: 0.06,
    capHighlight: "#FFFFFF",
    capHighlightOpacity: 0.1,
    text: "#FFFFFF",
    textOpacity: 1,
    countText: "#C4CDDC",
    countTextOpacity: 1,
    shadowColor: "#000000",
    shadowOpacity: 0.55,
  },
}
