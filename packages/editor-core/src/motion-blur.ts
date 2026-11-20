import type { MotionBlurSettings, TimelineState } from "@recordforge/contracts"
import {
  cursorSettingsForEffect,
  findCursorEffectAtTime,
  fitCursorPoint,
  mapCursorPointThroughZoom,
  timelineToCursorSourceTime,
  type CursorEngine,
} from "@recordforge/cursor-core"
import { resolveCameraShots } from "./camera-shots"
import { resolveZoomTransform, type ZoomTransform } from "./composition"
import { resolveFollowCursorTargetAtTime } from "./preview-composition"
import { findTimelineClipAt } from "./time-mapping"

/**
 * Reference cinema exposure (ms) at `1.0` slider strength for 24+ fps
 * timelines. Anchoring to 60 ms keeps 60 fps and 120 fps videos just as lush
 * and readable as 24/30 fps instead of halving blur at higher frame rates,
 * while lower frame rates (e.g. 15 fps GIFs) scale up to a full frame.
 */
export const MOTION_BLUR_REFERENCE_EXPOSURE_MS = 60

/** Default cinema shutter applied when enabling Motion Blur (30 ms / 50%). */
export const DEFAULT_MOTION_BLUR_SETTINGS: MotionBlurSettings = {
  enabled: true,
  cursor: 0.5,
  zoom: 0.5,
  pan: 0.5,
}

export type MotionBlurPresetId = "subtle" | "natural" | "cinematic" | "dynamic"

export interface MotionBlurPreset {
  id: MotionBlurPresetId
  label: string
  shutterDegrees: number
  exposureMs: number
  description: string
  settings: Pick<MotionBlurSettings, "cursor" | "zoom" | "pan">
}

/**
 * Cinema shutter presets ordered from crispest to strongest.
 * At 24+ fps, `0.5` evaluates a 30 ms exposure ("Natural") and `1.0` a 60 ms
 * streak ("Dynamic"), matching Rust `exports::camera::motion_blur_shutter_base_ms`.
 */
export const MOTION_BLUR_PRESETS: readonly MotionBlurPreset[] = [
  {
    id: "subtle",
    label: "Subtle",
    shutterDegrees: 90,
    exposureMs: 15,
    description: "Crisp 15 ms exposure for subtle motion polish",
    settings: { cursor: 0.25, zoom: 0.25, pan: 0.25 },
  },
  {
    id: "natural",
    label: "Natural",
    shutterDegrees: 180,
    exposureMs: 30,
    description: "Balanced 30 ms cinema shutter",
    settings: { cursor: 0.5, zoom: 0.5, pan: 0.5 },
  },
  {
    id: "cinematic",
    label: "Cinematic",
    shutterDegrees: 270,
    exposureMs: 45,
    description: "Lush 45 ms shutter for silky zooms and pans",
    settings: { cursor: 0.75, zoom: 0.75, pan: 0.75 },
  },
  {
    id: "dynamic",
    label: "Dynamic",
    shutterDegrees: 360,
    exposureMs: 60,
    description: "Bold 60 ms full-energy motion streak",
    settings: { cursor: 1, zoom: 1, pan: 1 },
  },
] as const

export interface ScreenMotionBlurStrip {
  /** Normalized `[x, y, w, h]` content-UV crop at shutter start. */
  start: [number, number, number, number]
  /** Normalized `[x, y, w, h]` content-UV crop at shutter end. */
  end: [number, number, number, number]
  /** Recommended shader tap count (3..32), sized from output screen-pixel sweep. */
  taps: number
  /** Worst-case viewport corner displacement in output display pixels. */
  sweepPx: number
  /** Dominant screen-space translation vector (px) for fallback rendering. */
  vectorPx: { x: number; y: number }
}

export interface CursorMotionBlurSample {
  /** Position in container CSS pixels (already fitted and mapped through zoom). */
  x: number
  y: number
  /** Zoom scale multiplier at this sub-frame shutter instant. */
  zoomScale: number
  /** Normalized tapered shutter weight (`sum(weights) === 1`). */
  weight: number
}

export interface MotionBlurPreviewTarget {
  timeMs: number
  source: "zoom" | "cursor"
  label: string
}

export interface ResolveCursorMotionBlurOptions {
  /** True while the user is framing a zoom target (video sits unzoomed). */
  isZoomFraming?: boolean
}

const GPU_MAX_BLUR_TAPS = 32
const MIN_SCREEN_SWEEP_PX = 0.75
const CURSOR_PROBE_SAMPLES = 5
const CURSOR_MAX_SAMPLES = 32
const CURSOR_MIN_SWEEP_PX = 1.0
const CURSOR_STEP_PX = 1.25

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Full-strength (`1.0`) shutter exposure base in ms for a given canvas fps. */
export function motionBlurShutterBaseMs(fps: number): number {
  const safeFps = Math.max(1, fps || 30)
  return Math.max(1000 / safeFps, MOTION_BLUR_REFERENCE_EXPOSURE_MS)
}

/** Exposure duration (ms) for a `0..1` channel strength at `fps`. */
export function motionBlurShutterMs(strength: number, fps = 30): number {
  return motionBlurShutterBaseMs(fps) * clamp(strength, 0, 1)
}

/** Return normalized MotionBlurSettings with missing fields defaulted. */
export function normalizeMotionBlurSettings(
  blur: MotionBlurSettings | undefined,
): MotionBlurSettings {
  return {
    enabled: blur?.enabled ?? false,
    cursor: clamp(blur?.cursor ?? DEFAULT_MOTION_BLUR_SETTINGS.cursor, 0, 1),
    zoom: clamp(blur?.zoom ?? DEFAULT_MOTION_BLUR_SETTINGS.zoom, 0, 1),
    pan: clamp(blur?.pan ?? DEFAULT_MOTION_BLUR_SETTINGS.pan, 0, 1),
  }
}

/** Detect which named preset matches the current per-channel shutter fractions. */
export function detectMotionBlurPreset(
  blur: MotionBlurSettings | undefined,
): MotionBlurPresetId | null {
  const normalized = normalizeMotionBlurSettings(blur)
  for (const preset of MOTION_BLUR_PRESETS) {
    if (
      Math.abs(normalized.cursor - preset.settings.cursor) < 0.005 &&
      Math.abs(normalized.zoom - preset.settings.zoom) < 0.005 &&
      Math.abs(normalized.pan - preset.settings.pan) < 0.005
    ) {
      return preset.id
    }
  }
  return null
}

/** Overall strength (`0..1`) represented by the strongest active channel. */
export function motionBlurMasterStrength(blur: MotionBlurSettings | undefined): number {
  const normalized = normalizeMotionBlurSettings(blur)
  return Math.max(normalized.cursor, normalized.zoom, normalized.pan)
}

/** Effective cinema shutter angle in degrees (`0..360`). */
export function effectiveShutterDegrees(blur: MotionBlurSettings | undefined): number {
  return Math.round(motionBlurMasterStrength(blur) * 360)
}

/** Effective cinema shutter exposure in milliseconds for the strongest active channel. */
export function effectiveShutterMs(blur: MotionBlurSettings | undefined, fps = 30): number {
  return Math.round(motionBlurShutterMs(motionBlurMasterStrength(blur), fps))
}

/**
 * Scale all three channels proportionally when the unified Strength slider moves,
 * preserving custom channel ratios (or restoring equal channels if all were 0).
 */
export function scaleMotionBlurStrength(
  blur: MotionBlurSettings | undefined,
  nextStrength: number,
): MotionBlurSettings {
  const target = clamp(nextStrength, 0, 1)
  const current = normalizeMotionBlurSettings(blur)
  const peak = Math.max(current.cursor, current.zoom, current.pan)
  if (peak <= 0.001) {
    return { enabled: true, cursor: target, zoom: target, pan: target }
  }
  const ratio = target / peak
  const roundStep = (value: number) => Math.round(clamp(value, 0, 1) * 100) / 100
  return {
    enabled: true,
    cursor: roundStep(current.cursor * ratio),
    zoom: roundStep(current.zoom * ratio),
    pan: roundStep(current.pan * ratio),
  }
}

/**
 * Tapered shutter weight matching Rust `exports::camera::motion_blur_tap_weight`
 * and `composite.wgsl` (`0.45 + 0.55 * sin(PI * t)`).
 */
export function motionBlurTapWeight(tap: number, taps: number): number {
  if (taps <= 1) return 1
  const progress = (tap + 0.5) / taps
  return 0.45 + 0.55 * Math.sin(Math.PI * progress)
}

function identityZoomTransform(canvas: { width: number; height: number }): ZoomTransform {
  return {
    scale: 1,
    progress: 0,
    translateX: 0,
    translateY: 0,
    crop: {
      x: 0,
      y: 0,
      width: Math.max(1, canvas.width),
      height: Math.max(1, canvas.height),
    },
  }
}

/**
 * Resolve the active camera zoom transform at any fractional timeline timestamp.
 * Reuses the cached camera shots + follow-cursor motion plans from preview composition.
 */
function resolveZoomAtTime(
  state: TimelineState,
  timeMs: number,
  cursorEngine?: CursorEngine | null,
): ZoomTransform {
  const safeTimeMs = Math.max(0, timeMs)
  const shots = resolveCameraShots(state, cursorEngine)
  const activeShot = shots
    .filter((shot) => safeTimeMs >= shot.startMs && safeTimeMs < shot.startMs + shot.durationMs)
    .pop()
  if (!activeShot) return identityZoomTransform(state.canvas)
  const followTarget = resolveFollowCursorTargetAtTime(activeShot, state, safeTimeMs, cursorEngine)
  return resolveZoomTransform(activeShot, safeTimeMs, state.canvas, {
    target: followTarget,
    fromTarget: activeShot.fromTarget,
    fromScale: activeShot.fromScale,
  })
}

/**
 * Deterministic per-frame screen motion blur strip, mirroring Rust
 * `exports::camera::evaluate_motion_blur_strip`.
 *
 * Works identically during playback, forward/backward scrubbing, and while paused
 * so tuning Motion Blur sliders updates the canvas live on a paused transition.
 */
export function resolveScreenMotionBlurStrip(
  state: TimelineState,
  timeMs: number,
  displaySize: { width: number; height: number },
  cursorEngine?: CursorEngine | null,
): ScreenMotionBlurStrip | null {
  const blur = normalizeMotionBlurSettings(state.canvas.motionBlur)
  if (!blur.enabled || (blur.zoom <= 0 && blur.pan <= 0)) return null
  if (!Number.isFinite(timeMs) || displaySize.width <= 0 || displaySize.height <= 0) return null

  const shots = resolveCameraShots(state, cursorEngine)
  if (shots.length === 0) return null

  const fps = Math.max(1, state.canvas.fps || 30)
  const baseMs = motionBlurShutterBaseMs(fps)
  const halfZoomMs = (baseMs * blur.zoom) / 2
  const halfPanMs = (baseMs * blur.pan) / 2

  const cw = Math.max(1, state.canvas.width)
  const ch = Math.max(1, state.canvas.height)
  const center = resolveZoomAtTime(state, timeMs, cursorEngine)
  const cW = clamp(center.crop.width, 1, cw)
  const cH = clamp(center.crop.height, 1, ch)
  const cCx = center.crop.x + cW * 0.5
  const cCy = center.crop.y + cH * 0.5

  const sameWindow = halfZoomMs > 0 && halfPanMs > 0 && Math.abs(halfZoomMs - halfPanMs) < 1e-6

  const zLo = halfZoomMs > 0 ? resolveZoomAtTime(state, timeMs - halfZoomMs, cursorEngine) : null
  const zHi = halfZoomMs > 0 ? resolveZoomAtTime(state, timeMs + halfZoomMs, cursorEngine) : null

  const wStart = zLo ? clamp(zLo.crop.width, 1, cw) : cW
  const hStart = zLo ? clamp(zLo.crop.height, 1, ch) : cH
  const wEnd = zHi ? clamp(zHi.crop.width, 1, cw) : cW
  const hEnd = zHi ? clamp(zHi.crop.height, 1, ch) : cH

  let cxStart = cCx
  let cyStart = cCy
  let cxEnd = cCx
  let cyEnd = cCy
  if (halfPanMs > 0) {
    const pLo = sameWindow && zLo ? zLo : resolveZoomAtTime(state, timeMs - halfPanMs, cursorEngine)
    const pHi = sameWindow && zHi ? zHi : resolveZoomAtTime(state, timeMs + halfPanMs, cursorEngine)
    cxStart = pLo.crop.x + pLo.crop.width * 0.5
    cyStart = pLo.crop.y + pLo.crop.height * 0.5
    cxEnd = pHi.crop.x + pHi.crop.width * 0.5
    cyEnd = pHi.crop.y + pHi.crop.height * 0.5
  }

  function normalizeRect(
    w: number,
    h: number,
    cx: number,
    cy: number,
  ): [number, number, number, number] {
    const nw = clamp(w / cw, 1 / cw, 1)
    const nh = clamp(h / ch, 1 / ch, 1)
    const nx = clamp(cx / cw - nw * 0.5, 0, 1 - nw)
    const ny = clamp(cy / ch - nh * 0.5, 0, 1 - nh)
    return [nx, ny, nw, nh]
  }

  const start = normalizeRect(wStart, hStart, cxStart, cyStart)
  const end = normalizeRect(wEnd, hEnd, cxEnd, cyEnd)

  const cropWNorm = Math.max(1e-4, cW / cw)
  const cropHNorm = Math.max(1e-4, cH / ch)
  const dxLeft = Math.abs(end[0] - start[0])
  const dxRight = Math.abs(end[0] + end[2] - (start[0] + start[2]))
  const dyTop = Math.abs(end[1] - start[1])
  const dyBottom = Math.abs(end[1] + end[3] - (start[1] + start[3]))
  const screenDx = (Math.max(dxLeft, dxRight) / cropWNorm) * displaySize.width
  const screenDy = (Math.max(dyTop, dyBottom) / cropHNorm) * displaySize.height
  const sweepPx = Math.hypot(screenDx, screenDy)

  if (sweepPx < MIN_SCREEN_SWEEP_PX) return null

  const taps = Math.max(3, Math.min(GPU_MAX_BLUR_TAPS, Math.ceil(sweepPx / 1.5)))
  const centerDx =
    ((end[0] + end[2] * 0.5 - (start[0] + start[2] * 0.5)) / cropWNorm) * displaySize.width
  const centerDy =
    ((end[1] + end[3] * 0.5 - (start[1] + start[3] * 0.5)) / cropHNorm) * displaySize.height

  return {
    start,
    end,
    taps,
    sweepPx,
    vectorPx: { x: centerDx, y: centerDy },
  }
}

function subframeZoomTransform(
  state: TimelineState,
  timeMs: number,
  baseTransform: ZoomTransform,
  blur: MotionBlurSettings,
  u: number,
  cursorEngine?: CursorEngine | null,
): ZoomTransform {
  if (Math.abs(u) < 1e-9 || (blur.zoom <= 0 && blur.pan <= 0)) return baseTransform
  const shots = resolveCameraShots(state, cursorEngine)
  if (shots.length === 0) return baseTransform

  const fps = Math.max(1, state.canvas.fps || 30)
  const baseMs = motionBlurShutterBaseMs(fps)
  const halfZoomMs = (baseMs * blur.zoom) / 2
  const halfPanMs = (baseMs * blur.pan) / 2

  if (Math.abs(halfZoomMs - halfPanMs) < 1e-6) {
    return resolveZoomAtTime(state, timeMs + u * halfZoomMs, cursorEngine)
  }

  const zState =
    halfZoomMs > 0 ? resolveZoomAtTime(state, timeMs + u * halfZoomMs, cursorEngine) : baseTransform
  const pState =
    halfPanMs > 0 ? resolveZoomAtTime(state, timeMs + u * halfPanMs, cursorEngine) : baseTransform

  const cw = Math.max(1, state.canvas.width)
  const ch = Math.max(1, state.canvas.height)
  const cropW = clamp(zState.crop.width, 1, cw)
  const cropH = clamp(zState.crop.height, 1, ch)
  const cx = pState.crop.x + pState.crop.width * 0.5
  const cy = pState.crop.y + pState.crop.height * 0.5

  const cropX = clamp(cx - cropW * 0.5, 0, Math.max(0, cw - cropW))
  const cropY = clamp(cy - cropH * 0.5, 0, Math.max(0, ch - cropH))
  return {
    scale: zState.scale,
    progress: zState.progress,
    translateX: -(cropX / cw) * zState.scale * 100,
    translateY: -(cropY / ch) * zState.scale * 100,
    crop: {
      x: cropX,
      y: cropY,
      width: cropW,
      height: cropH,
    },
  }
}

/**
 * Resolve sub-frame cursor poses across the cursor shutter window in container
 * CSS pixels, mirroring Rust `exports::cursor::CursorRenderer::cursor_motion_poses`.
 *
 * Returns an empty array when cursor blur is off or motion is sub-pixel so still
 * cursors stay on the zero-cost SVG path.
 */
export function resolveCursorMotionBlurSamples(
  state: TimelineState,
  timeMs: number,
  cursorEngine: CursorEngine | null | undefined,
  containerSize: { width: number; height: number },
  options: ResolveCursorMotionBlurOptions = {},
): CursorMotionBlurSample[] {
  if (!cursorEngine || containerSize.width <= 0 || containerSize.height <= 0) return []
  const blur = normalizeMotionBlurSettings(state.canvas.motionBlur)
  if (!blur.enabled || blur.cursor <= 0) return []

  const sourceTimeMs = timelineToCursorSourceTime(state, timeMs)
  if (sourceTimeMs === null) return []

  const cursorEffect = findCursorEffectAtTime(state, timeMs)
  const cursorSettings = cursorSettingsForEffect(state.canvas.cursorSettings, cursorEffect)
  if (!cursorSettings.enabled) return []

  const screenClip = findTimelineClipAt(state, "screen", timeMs)
  const clipSpeed =
    screenClip && Number.isFinite(screenClip.speed) && screenClip.speed > 0 ? screenClip.speed : 1
  const fps = Math.max(1, state.canvas.fps || 30)
  const exposureSourceMs = motionBlurShutterBaseMs(fps) * clipSpeed
  const baseTransform = options.isZoomFraming
    ? null
    : resolveZoomAtTime(state, timeMs, cursorEngine)

  function mapSamples(points: Array<{ x: number; y: number }>): CursorMotionBlurSample[] {
    const count = points.length
    const rawWeights = points.map((_, index) => motionBlurTapWeight(index, count))
    const weightSum = rawWeights.reduce((sum, w) => sum + w, 0) || 1
    return points.map((point, index) => {
      const progress = (index + 0.5) / Math.max(1, count)
      const u = -1 + 2 * progress
      const fitted = fitCursorPoint(
        point,
        cursorEngine!.telemetry,
        containerSize.width,
        containerSize.height,
      )
      const zoom =
        baseTransform !== null
          ? subframeZoomTransform(state, timeMs, baseTransform, blur, u, cursorEngine)
          : null
      const mapped = mapCursorPointThroughZoom(
        { x: fitted.x, y: fitted.y },
        containerSize,
        state.canvas,
        zoom,
      )
      return {
        x: mapped.x,
        y: mapped.y,
        zoomScale: mapped.scale,
        weight: rawWeights[index] / weightSum,
      }
    })
  }

  const probePoints = cursorEngine.evaluateMotionSamples(
    sourceTimeMs,
    exposureSourceMs,
    blur.cursor,
    CURSOR_PROBE_SAMPLES,
    cursorSettings,
  )
  const probed = mapSamples(probePoints)
  let probedArc = 0
  for (let i = 1; i < probed.length; i++) {
    probedArc += Math.hypot(probed[i].x - probed[i - 1].x, probed[i].y - probed[i - 1].y)
  }
  const sweepPx = probedArc * (CURSOR_PROBE_SAMPLES / (CURSOR_PROBE_SAMPLES - 1))
  if (sweepPx < CURSOR_MIN_SWEEP_PX) return []

  const sampleCount = Math.max(3, Math.min(CURSOR_MAX_SAMPLES, Math.ceil(sweepPx / CURSOR_STEP_PX)))
  if (sampleCount === CURSOR_PROBE_SAMPLES) return probed

  const resampled = cursorEngine.evaluateMotionSamples(
    sourceTimeMs,
    exposureSourceMs,
    blur.cursor,
    sampleCount,
    cursorSettings,
  )
  return mapSamples(resampled)
}

/**
 * Find the nearest timestamp with visible zoom or cursor motion so the UI can
 * offer a 1-click "Preview motion" jump when the user adjusts Motion Blur on a
 * stationary frame.
 */
export function findMotionBlurPreviewTarget(
  state: TimelineState,
  currentTimeMs: number,
  cursorEngine?: CursorEngine | null,
): MotionBlurPreviewTarget | null {
  const blur = normalizeMotionBlurSettings(state.canvas.motionBlur)
  const anyChannel = blur.cursor > 0 || blur.zoom > 0 || blur.pan > 0
  const allowScreen = !anyChannel || blur.zoom > 0 || blur.pan > 0
  const allowCursor = !anyChannel || blur.cursor > 0

  const candidates: MotionBlurPreviewTarget[] = []

  if (allowScreen) {
    const shots = resolveCameraShots(state, cursorEngine)
    for (const shot of shots) {
      const transitionInMs = shot.transitionInMs ?? 0
      const transitionOutMs = shot.transitionOutMs ?? 0
      if (transitionInMs > 0) {
        candidates.push({
          timeMs: Math.round(shot.startMs + transitionInMs * 0.5),
          source: "zoom",
          label: "Zoom transition",
        })
      }
      if (transitionOutMs > 0) {
        candidates.push({
          timeMs: Math.round(shot.startMs + shot.durationMs - transitionOutMs * 0.5),
          source: "zoom",
          label: "Zoom out",
        })
      }
    }
  }

  // Also sample telemetry for the fastest cursor movement if available.
  if (allowCursor && cursorEngine && cursorEngine.telemetry.events.length > 2) {
    const events = cursorEngine.telemetry.events
    const step = Math.max(1, Math.floor(events.length / 240))
    let bestSpeed = 0
    let bestSourceMs: number | null = null
    for (let i = step; i < events.length; i += step) {
      const prev = events[i - step]
      const curr = events[i]
      const dt = curr.tMs - prev.tMs
      if (dt <= 0 || dt > 200) continue
      const speed =
        (Math.hypot(curr.sourceX - prev.sourceX, curr.sourceY - prev.sourceY) / dt) * 1000
      if (speed > bestSpeed && speed > 200) {
        bestSpeed = speed
        bestSourceMs = Math.round((prev.tMs + curr.tMs) * 0.5)
      }
    }
    if (bestSourceMs !== null) {
      // Map source time back onto the screen track.
      for (const track of state.tracks) {
        if (track.kind !== "screen" || track.muted) continue
        for (const clip of track.clips) {
          if (bestSourceMs >= clip.sourceInMs && bestSourceMs <= clip.sourceOutMs) {
            const speed = clip.speed > 0 ? clip.speed : 1
            const timelineMs = Math.round(clip.startMs + (bestSourceMs - clip.sourceInMs) / speed)
            candidates.push({
              timeMs: timelineMs,
              source: "cursor",
              label: "Fast cursor move",
            })
            break
          }
        }
      }
    }
  }

  if (candidates.length === 0) return null
  candidates.sort((a, b) => Math.abs(a.timeMs - currentTimeMs) - Math.abs(b.timeMs - currentTimeMs))
  return candidates[0]
}
