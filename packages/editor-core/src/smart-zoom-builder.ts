import type { ManualZoomSegment, TimelineState, ZoomPreset } from "@recordforge/contracts"
import { clampZoomTarget, zoomTargetForCursorPoint } from "@recordforge/cursor-core"
import { getTotalDuration } from "@recordforge/domain"
import { getManualZoomSegments } from "./composition"

export interface SmartZoomPresetConfig {
  scale: number
  easing: NonNullable<ManualZoomSegment["easing"]>
  mode: NonNullable<ManualZoomSegment["mode"]>
  transitionInMs: number
  transitionOutMs: number
  label: string
}

export const SMART_ZOOM_PRESETS: Record<ZoomPreset, SmartZoomPresetConfig> = {
  "product-demo": {
    scale: 1.5,
    easing: "smooth",
    mode: "follow-cursor",
    transitionInMs: 400,
    transitionOutMs: 400,
    label: "Standard 1.5×",
  },
  developer: {
    scale: 2.0,
    easing: "snappy",
    mode: "follow-cursor",
    transitionInMs: 300,
    transitionOutMs: 300,
    label: "Detail 2.0×",
  },
  cinematic: {
    scale: 1.8,
    easing: "cinematic",
    mode: "smooth-pan",
    transitionInMs: 600,
    transitionOutMs: 600,
    label: "Cinematic 1.8×",
  },
  subtle: {
    scale: 1.25,
    easing: "smooth",
    mode: "follow-cursor",
    transitionInMs: 400,
    transitionOutMs: 400,
    label: "Subtle 1.25×",
  },
  "manual-only": {
    scale: 1.5,
    easing: "smooth",
    mode: "static",
    transitionInMs: 400,
    transitionOutMs: 400,
    label: "Static Center 1.5×",
  },
}

export interface BuildSmartZoomOptions {
  segmentId?: string
  startMs: number
  endMs?: number
  defaultDurationMs?: number
  preset?: ZoomPreset
  scale?: number
  mode?: ManualZoomSegment["mode"]
  easing?: ManualZoomSegment["easing"]
  transitionInMs?: number
  transitionOutMs?: number
  targetPoint?: { x: number; y: number }
  label?: string
}

/**
 * Computes a non-overlapping duration for a new zoom segment starting at `startMs`.
 * If `endMs` is explicitly provided, it is clamped to `timelineDuration` and minimum 100ms.
 * Otherwise, uses `defaultDurationMs` (default 2000ms) but avoids overlapping an upcoming zoom segment.
 */
export function computeSmartZoomDuration(
  timeline: TimelineState,
  startMs: number,
  options: { endMs?: number; defaultDurationMs?: number } = {},
): number {
  const timelineDuration = Math.max(100, getTotalDuration(timeline))
  const safeStartMs = Math.max(0, Math.min(startMs, timelineDuration))

  if (options.endMs !== undefined && options.endMs > safeStartMs) {
    const rawDuration = Math.max(100, Math.round(options.endMs - safeStartMs))
    return Math.min(rawDuration, Math.max(100, timelineDuration - safeStartMs))
  }

  const requestedDuration = Math.max(100, options.defaultDurationMs ?? 2_000)
  const existingSegments = getManualZoomSegments(timeline)

  // Find the next zoom segment starting after startMs
  const nextSegment = existingSegments
    .filter((s) => s.startMs > safeStartMs)
    .sort((a, b) => a.startMs - b.startMs)[0]

  let maxAllowed = timelineDuration - safeStartMs
  if (nextSegment) {
    // Leave at least 50ms margin if possible, or snap to the segment start
    maxAllowed = Math.min(maxAllowed, nextSegment.startMs - safeStartMs)
  }

  if (maxAllowed < 100) {
    return Math.max(50, maxAllowed)
  }

  return Math.min(requestedDuration, maxAllowed)
}

/**
 * Builds a valid, fully configured ManualZoomSegment with smart cursor/canvas targeting,
 * easing, duration, and preset configuration.
 */
export function buildSmartZoomSegment(
  timeline: TimelineState,
  cursorPoint: { x: number; y: number } | null,
  options: BuildSmartZoomOptions,
): ManualZoomSegment {
  const presetKey = options.preset ?? "product-demo"
  const presetConfig = SMART_ZOOM_PRESETS[presetKey] ?? SMART_ZOOM_PRESETS["product-demo"]

  const targetScale = options.scale ?? presetConfig.scale
  const easing = options.easing ?? presetConfig.easing
  const mode = options.mode ?? presetConfig.mode
  const transitionInMs = options.transitionInMs ?? presetConfig.transitionInMs
  const transitionOutMs = options.transitionOutMs ?? presetConfig.transitionOutMs
  const label = options.label ?? `${targetScale.toFixed(1)}× Zoom`

  const startMs = Math.max(0, Math.round(options.startMs))
  const durationMs = computeSmartZoomDuration(timeline, startMs, {
    endMs: options.endMs,
    defaultDurationMs: options.defaultDurationMs,
  })

  // Calculate zoom focus center point
  const focusPoint =
    options.targetPoint ??
    (mode === "static"
      ? { x: timeline.canvas.width / 2, y: timeline.canvas.height / 2 }
      : (cursorPoint ?? { x: timeline.canvas.width / 2, y: timeline.canvas.height / 2 }))

  const unclampedTarget = zoomTargetForCursorPoint(focusPoint, timeline.canvas, targetScale)
  const target = clampZoomTarget(unclampedTarget, timeline.canvas)

  return {
    id: options.segmentId ?? crypto.randomUUID(),
    startMs,
    durationMs,
    target,
    scale: targetScale,
    easing,
    transitionInMs,
    transitionOutMs,
    enabled: true,
    locked: false,
    mode,
    source: "manual",
    preset: presetKey,
    label,
  }
}
