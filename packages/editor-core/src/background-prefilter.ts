import {
  DEFAULT_BACKGROUND_BLUR,
  DEFAULT_BACKGROUND_DIM,
  MAX_BACKGROUND_BLUR,
  MAX_BACKGROUND_DIM,
} from "./background-presets"

export type BackgroundFilterOptimizationMode = "quality" | "performance" | "power"

export interface BackgroundFilterPlan {
  /** Effective clamped blur radius in pixels. */
  blurRadius: number
  /** Effective clamped dim factor (0.0 to 1.0). */
  dimFactor: number
  /** Recommended downscale factor for offscreen canvas pre-filtering (e.g. 1, 2, 4). */
  downscaleFactor: number
  /** Whether runtime CSS filter is bypassed in favor of pre-rendered texture/canvas. */
  usePreRenderedFilter: boolean
  /** Unique cache key for the rendered background with these parameters. */
  cacheKey: string
}

/**
 * Compute the optimal downscale factor for offscreen blur convolution.
 * For high blur radii (e.g., >= 16px), downsampling 2x or 4x before blurring
 * reduces pixel count by 75-93% while producing identical smooth Gaussian visual output.
 */
export function computeBlurDownscaleFactor(
  blurRadius: number,
  mode: BackgroundFilterOptimizationMode = "performance",
): number {
  if (blurRadius <= 0) return 1
  if (mode === "power") {
    if (blurRadius >= 16) return 4
    if (blurRadius >= 8) return 2
    return 1
  }
  if (mode === "performance") {
    if (blurRadius >= 20) return 4
    if (blurRadius >= 8) return 2
    return 1
  }
  // Quality mode: 2x downscale only for very large blur radii
  if (blurRadius >= 24) return 2
  return 1
}

/**
 * Generate a deterministic cache key for a background configuration.
 */
export function createBackgroundFilterCacheKey(
  background: string,
  blur?: number,
  dim?: number,
  width?: number,
  height?: number,
  mode: BackgroundFilterOptimizationMode = "performance",
): string {
  const safeBlur = Math.max(0, Math.min(MAX_BACKGROUND_BLUR, blur ?? DEFAULT_BACKGROUND_BLUR))
  const safeDim = Math.max(0, Math.min(MAX_BACKGROUND_DIM, dim ?? DEFAULT_BACKGROUND_DIM))
  const safeW = Math.max(1, Math.round(width ?? 1920))
  const safeH = Math.max(1, Math.round(height ?? 1080))
  return `bg:${background}|b:${safeBlur}|d:${safeDim.toFixed(2)}|${safeW}x${safeH}|m:${mode}`
}

/**
 * Evaluate the filter plan for background rendering given preview quality mode.
 */
export function getEffectiveBackgroundFilterPlan(
  background: string,
  blur?: number,
  dim?: number,
  width?: number,
  height?: number,
  mode: BackgroundFilterOptimizationMode = "performance",
): BackgroundFilterPlan {
  const safeBlur = Math.max(0, Math.min(MAX_BACKGROUND_BLUR, blur ?? DEFAULT_BACKGROUND_BLUR))
  const safeDim = Math.max(0, Math.min(MAX_BACKGROUND_DIM, dim ?? DEFAULT_BACKGROUND_DIM))
  const downscaleFactor = computeBlurDownscaleFactor(safeBlur, mode)
  const usePreRenderedFilter = safeBlur > 0 || safeDim > 0
  const cacheKey = createBackgroundFilterCacheKey(
    background,
    safeBlur,
    safeDim,
    width,
    height,
    mode,
  )

  return {
    blurRadius: safeBlur,
    dimFactor: safeDim,
    downscaleFactor,
    usePreRenderedFilter,
    cacheKey,
  }
}
