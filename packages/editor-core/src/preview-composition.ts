import type {
  CameraClip,
  CaptionClip,
  CursorSettings,
  CursorTelemetryFile,
  ManualZoomSegment,
  MaskClip,
  MaskRect,
  TimelineCanvas,
  TimelineClip,
  TimelineState,
  ZoomTarget,
} from "@recordforge/contracts"
import {
  cursorSettingsForEffect,
  findCursorEffectAtTime,
  fitCursorPoint,
  findCursorEventAtTime,
  smoothCursorPosition,
  timelineToCursorSourceTime,
  zoomTargetForCursorPoint,
} from "@recordforge/cursor-core"
import { findManualZoomAtTime, resolveZoomTransform, type ZoomTransform } from "./composition"
import { findTimelineClipAt, timelineToSource } from "./time-mapping"

export type { ZoomTransform }

export interface CanvasGeometry {
  width: number
  height: number
}

export interface ScreenLayer {
  active: boolean
  clip: TimelineClip | null
  sourceMs: number | null
  zoomTransform: ZoomTransform | null
  /** True when the current time falls in a gap with no screen clip. */
  isGap: boolean
}

export interface CameraLayer {
  clip: CameraClip
  active: boolean
  sourceMs: number | null
}

export interface MaskLayer {
  clip: MaskClip
  active: boolean
  rect: MaskRect
}

export interface CaptionLayer {
  clip: CaptionClip
  active: boolean
  text: string
  placement: "top" | "center" | "bottom"
  style: string
  safeAreaMargin: number
}

export interface CursorLayer {
  active: boolean
  sourceTimeMs: number | null
  settings: CursorSettings
  /** Cursor position in source canvas coordinates, before any zoom transform. */
  sourcePoint: { x: number; y: number } | null
}

export interface PreviewComposition {
  timeMs: number
  canvas: CanvasGeometry
  screen: ScreenLayer
  cameras: CameraLayer[]
  masks: MaskLayer[]
  captions: CaptionLayer[]
  cursor: CursorLayer
}

export interface PreviewCompositionOptions {
  cursorTelemetry?: CursorTelemetryFile | null
}

function isActiveClip(clip: TimelineClip, timeMs: number): boolean {
  return timeMs >= clip.startMs && timeMs < clip.startMs + clip.durationMs
}

function clampRect(rect: MaskRect, canvas: TimelineCanvas): MaskRect {
  const width = Math.min(Math.max(1, rect.width), canvas.width)
  const height = Math.min(Math.max(1, rect.height), canvas.height)
  return {
    x: Math.min(Math.max(0, rect.x), Math.max(0, canvas.width - width)),
    y: Math.min(Math.max(0, rect.y), Math.max(0, canvas.height - height)),
    width,
    height,
  }
}

function resolveFollowCursorTarget(
  segment: ManualZoomSegment,
  state: TimelineState,
  timeMs: number,
  telemetry: CursorTelemetryFile | null | undefined,
): ZoomTarget | undefined {
  if (segment.mode !== "follow-cursor" || !telemetry) return undefined
  const sourceTimeMs = timelineToCursorSourceTime(state, timeMs)
  if (sourceTimeMs === null) return undefined
  const lookup = findCursorEventAtTime(telemetry, sourceTimeMs)
  if (!lookup) return undefined
  const smoothed = smoothCursorPosition(telemetry, lookup.index, state.canvas.cursorSettings)
  const fitted = fitCursorPoint(smoothed, telemetry, state.canvas.width, state.canvas.height)
  const desiredScale = Math.max(1.05, state.canvas.width / Math.max(1, segment.target.width))
  return zoomTargetForCursorPoint({ x: fitted.x, y: fitted.y }, state.canvas, desiredScale)
}

/**
 * Build a single preview composition for a given timeline time.
 *
 * This is the one place that decides, for a given frame, what every layer
 * (screen, zoom, camera, mask, caption, cursor) should look like. Preview
 * components and the export plan should derive from the same composition
 * wherever possible so they cannot diverge silently.
 */
export function resolvePreviewComposition(
  state: TimelineState,
  timeMs: number,
  options: PreviewCompositionOptions = {},
): PreviewComposition {
  const canvas = { width: state.canvas.width, height: state.canvas.height }

  const screenClip = findTimelineClipAt(state, "screen", timeMs)
  const screenSourceMs = screenClip ? timelineToSource(screenClip, timeMs) : null
  const activeZoom = findManualZoomAtTime(state, timeMs)
  const followTarget = activeZoom
    ? resolveFollowCursorTarget(activeZoom, state, timeMs, options.cursorTelemetry)
    : undefined
  const zoomTransform = activeZoom
    ? resolveZoomTransform(activeZoom, timeMs, state.canvas, { target: followTarget })
    : null

  const cameras: CameraLayer[] = state.tracks
    .filter((track) => track.kind === "camera" && !track.muted)
    .flatMap((track) =>
      track.clips
        .filter((clip): clip is CameraClip => clip.kind === "camera")
        .map((clip) => {
          const active = isActiveClip(clip, timeMs) && clip.transform.visible !== false
          const sourceMs = active ? clip.sourceInMs + (timeMs - clip.startMs) * clip.speed : null
          return { clip, active, sourceMs }
        }),
    )

  const masks: MaskLayer[] = state.tracks
    .filter((track) => track.kind === "effects" && !track.muted)
    .flatMap((track) =>
      track.clips
        .filter((clip): clip is MaskClip => clip.kind === "mask")
        .map((clip) => ({
          clip,
          active: clip.enabled !== false && isActiveClip(clip, timeMs),
          rect: clampRect(clip.rect, state.canvas),
        })),
    )

  const captions: CaptionLayer[] = state.tracks
    .filter((track) => track.kind === "captions" && !track.muted)
    .flatMap((track) =>
      track.clips
        .filter((clip): clip is CaptionClip => clip.kind === "caption")
        .map((clip) => ({
          clip,
          active: isActiveClip(clip, timeMs),
          text: clip.text,
          placement: clip.placement ?? "bottom",
          style: clip.style,
          safeAreaMargin: clip.safeAreaMargin ?? 48,
        })),
    )

  const cursorEffect = findCursorEffectAtTime(state, timeMs)
  const cursorSourceTimeMs = timelineToCursorSourceTime(state, timeMs)
  const cursorSettings = cursorSettingsForEffect(state.canvas.cursorSettings, cursorEffect)

  let cursorSourcePoint: { x: number; y: number } | null = null
  if (cursorSourceTimeMs !== null && options.cursorTelemetry) {
    const lookup = findCursorEventAtTime(options.cursorTelemetry, cursorSourceTimeMs)
    if (lookup) {
      const smoothed = smoothCursorPosition(options.cursorTelemetry, lookup.index, cursorSettings)
      const fitted = fitCursorPoint(smoothed, options.cursorTelemetry, canvas.width, canvas.height)
      if (fitted.visible) {
        cursorSourcePoint = { x: fitted.x, y: fitted.y }
      }
    }
  }

  const cursor: CursorLayer = {
    active:
      cursorSettings.enabled &&
      screenClip !== null &&
      cursorSourceTimeMs !== null &&
      cursorSourcePoint !== null,
    sourceTimeMs: cursorSourceTimeMs,
    settings: cursorSettings,
    sourcePoint: cursorSourcePoint,
  }

  return {
    timeMs,
    canvas,
    screen: {
      active: screenClip !== null,
      clip: screenClip,
      sourceMs: screenSourceMs,
      zoomTransform,
      isGap: screenClip === null,
    },
    cameras,
    masks,
    captions,
    cursor,
  }
}

/**
 * Convert a zoom transform into the same CSS transform string used by the
 * preview video and the cursor overlay so they share one geometry.
 */
export function zoomTransformToCss(
  transform: ZoomTransform,
  canvas: { width: number; height: number },
): string {
  const translateX = (transform.translateX / Math.max(1, canvas.width)) * 100
  const translateY = (transform.translateY / Math.max(1, canvas.height)) * 100
  return `translate(${translateX}%, ${translateY}%) scale(${transform.scale})`
}
