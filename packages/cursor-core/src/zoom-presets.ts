import type { ZoomEasing, ZoomPreset } from "@recordforge/contracts"

/**
 * Camera tracking speeds for follow-cursor zoom segments. The schema enum in
 * contracts is duplicated as a literal list (`z.enum(["relaxed", "balanced",
 * "tight"])`) because contracts cannot import from this package.
 */
export const followSpeedSchemaValues = ["relaxed", "balanced", "tight"] as const
export type FollowSpeed = (typeof followSpeedSchemaValues)[number]

export interface ZoomPresetDefinition {
  id: ZoomPreset
  label: string
  description: string
  scale: number
  easing: ZoomEasing
  transitionInMs: number
  transitionOutMs: number
  clickDurationMs: number
  dwellTailMs: number
  followSpeed: FollowSpeed
}

/**
 * Single source of truth for zoom preset behavior: suggestion generation,
 * manual segment building, the settings UI, and the follow camera all read
 * from this table instead of keeping parallel per-preset literals.
 */
export const ZOOM_PRESETS: Record<ZoomPreset, ZoomPresetDefinition> = {
  subtle: {
    id: "subtle",
    label: "Subtle",
    description: "Gentle push-ins that keep context",
    scale: 1.25,
    easing: "smooth",
    transitionInMs: 450,
    transitionOutMs: 450,
    clickDurationMs: 900,
    dwellTailMs: 450,
    followSpeed: "relaxed",
  },
  "product-demo": {
    id: "product-demo",
    label: "Product demo",
    description: "Balanced focus on every click",
    scale: 1.5,
    easing: "smooth",
    transitionInMs: 450,
    transitionOutMs: 450,
    clickDurationMs: 1_200,
    dwellTailMs: 600,
    followSpeed: "balanced",
  },
  cinematic: {
    id: "cinematic",
    label: "Cinematic",
    description: "Slow, dramatic camera moves",
    scale: 1.8,
    easing: "cinematic",
    transitionInMs: 700,
    transitionOutMs: 700,
    clickDurationMs: 1_800,
    dwellTailMs: 900,
    followSpeed: "relaxed",
  },
  developer: {
    id: "developer",
    label: "Developer",
    description: "Tight framing for code and small UI",
    scale: 2.2,
    easing: "smooth",
    transitionInMs: 320,
    transitionOutMs: 320,
    clickDurationMs: 1_400,
    dwellTailMs: 700,
    followSpeed: "tight",
  },
  "manual-only": {
    id: "manual-only",
    label: "Manual only",
    description: "No automatic zooms",
    scale: 1.5,
    easing: "smooth",
    transitionInMs: 450,
    transitionOutMs: 450,
    clickDurationMs: 0,
    dwellTailMs: 0,
    followSpeed: "balanced",
  },
}

/**
 * Critically damped camera smooth time per follow speed, in seconds. Lower
 * values track the cursor faster; "relaxed" intentionally lags quick moves.
 */
export const FOLLOW_SPEED_SMOOTH_TIME_S: Record<FollowSpeed, number> = {
  relaxed: 0.45,
  balanced: 0.3,
  tight: 0.18,
}
