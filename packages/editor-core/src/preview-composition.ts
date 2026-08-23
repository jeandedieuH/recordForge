import type {
  AnnotationClip,
  CameraClip,
  CaptionClip,
  CursorSettings,
  CursorTelemetryFile,
  ImageClip,
  ManualZoomSegment,
  MaskClip,
  MaskRect,
  TextClip,
  TimelineCanvas,
  TimelineClip,
  TimelineState,
  ZoomTarget,
} from "@recordforge/contracts"
import {
  canonicalizeZoomTarget,
  clampZoomTarget,
  createCursorEngine,
  cursorSettingsForEffect,
  findCursorEffectAtTime,
  fitCursorPoint,
  resolveInertialFollowCenter,
  timelineToCursorSourceTime,
  zoomTargetForCursorPoint,
  type CursorEngine,
  type CursorFrame,
} from "@recordforge/cursor-core"
import {
  findManualZoomAtTime,
  findPreviousZoomSegment,
  resolveZoomTransform,
  type ZoomTransform,
} from "./composition"
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

export interface AnnotationLayer {
  clip: AnnotationClip
  active: boolean
}

export interface TextLayer {
  clip: TextClip
  active: boolean
}

export interface ImageLayer {
  clip: ImageClip
  active: boolean
}

export interface CursorLayer {
  active: boolean
  sourceTimeMs: number | null
  settings: CursorSettings
  /** Cursor position in source canvas coordinates, before any zoom transform. */
  sourcePoint: { x: number; y: number } | null
  /** Canonical cursor frame produced by the engine, if available. */
  frame: CursorFrame | null
}

export interface PreviewComposition {
  timeMs: number
  canvas: CanvasGeometry
  screen: ScreenLayer
  cameras: CameraLayer[]
  masks: MaskLayer[]
  captions: CaptionLayer[]
  annotations: AnnotationLayer[]
  texts: TextLayer[]
  images: ImageLayer[]
  cursor: CursorLayer
}

export interface PreviewCompositionOptions {
  cursorTelemetry?: CursorTelemetryFile | null
  cursorEngine?: CursorEngine | null
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

export const FOLLOW_CAMERA_SAMPLE_STEP_MS = 100

export function resolveFollowCursorTarget(
  segment: ManualZoomSegment,
  state: TimelineState,
  timeMs: number,
  cursorEngine: CursorEngine | null | undefined,
): ZoomTarget | undefined {
  if (segment.mode === "static" || segment.mode === "manual" || !cursorEngine) return undefined
  const sourceTimeMs = timelineToCursorSourceTime(state, timeMs)
  if (sourceTimeMs === null) return undefined
  const frame = cursorEngine.evaluate(sourceTimeMs, state.canvas.cursorSettings)
  if (!frame.visible) return undefined
  const fitted = fitCursorPoint(
    { x: frame.sourceX, y: frame.sourceY },
    cursorEngine.telemetry,
    state.canvas.width,
    state.canvas.height,
  )
  if (!fitted.visible) return undefined

  const baseTarget = canonicalizeZoomTarget(segment.target, state.canvas, segment.scale)
  const desiredScale = Math.max(1.05, state.canvas.width / Math.max(1, baseTarget.width))
  const initialCenter = {
    x: baseTarget.x + baseTarget.width / 2,
    y: baseTarget.y + baseTarget.height / 2,
  }
  const followCenter = resolveInertialFollowCenter(
    { x: fitted.x, y: fitted.y },
    initialCenter,
    { width: state.canvas.width / desiredScale, height: state.canvas.height / desiredScale },
    {
      deadzoneRadiusPercent: segment.followDeadzonePercent,
      smoothingAlpha: segment.followSmoothingAlpha,
    },
  )
  return zoomTargetForCursorPoint(followCenter, state.canvas, desiredScale)
}

/**
 * Sample follow-camera targets on the same 100ms grid used by the export plan.
 * Preview therefore displays the exact piecewise-linear camera path that Rust
 * receives instead of following a separate continuous approximation.
 */
export function resolveFollowCursorTargetAtTime(
  segment: ManualZoomSegment,
  state: TimelineState,
  timeMs: number,
  cursorEngine: CursorEngine | null | undefined,
  sampleStepMs = FOLLOW_CAMERA_SAMPLE_STEP_MS,
): ZoomTarget | undefined {
  if (segment.mode === "static" || segment.mode === "manual" || !cursorEngine) {
    return undefined
  }

  const safeStepMs = Math.max(1, Math.round(sampleStepMs))
  const segmentEndMs = segment.startMs + segment.durationMs
  const clampedTimeMs = Math.min(segmentEndMs, Math.max(segment.startMs, timeMs))
  const elapsedMs = clampedTimeMs - segment.startMs
  const leftTimeMs = segment.startMs + Math.floor(elapsedMs / safeStepMs) * safeStepMs
  const rightTimeMs = Math.min(segmentEndMs, leftTimeMs + safeStepMs)
  const leftTarget = resolveFollowCursorTarget(segment, state, leftTimeMs, cursorEngine)
  if (!leftTarget || rightTimeMs === leftTimeMs) return leftTarget

  const rightTarget = resolveFollowCursorTarget(segment, state, rightTimeMs, cursorEngine)
  if (!rightTarget) return leftTarget

  const spanMs = Math.max(1, rightTimeMs - leftTimeMs)
  const alpha = (clampedTimeMs - leftTimeMs) / spanMs
  return clampZoomTarget(
    {
      x: leftTarget.x + (rightTarget.x - leftTarget.x) * alpha,
      y: leftTarget.y + (rightTarget.y - leftTarget.y) * alpha,
      width: leftTarget.width + (rightTarget.width - leftTarget.width) * alpha,
      height: leftTarget.height + (rightTarget.height - leftTarget.height) * alpha,
    },
    state.canvas,
  )
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

  const cursorEngine =
    options.cursorEngine ??
    (options.cursorTelemetry ? createCursorEngine(options.cursorTelemetry) : null)

  const screenClip = findTimelineClipAt(state, "screen", timeMs)
  const screenSourceMs = screenClip ? timelineToSource(screenClip, timeMs) : null
  const activeZoom = findManualZoomAtTime(state, timeMs)
  const followTarget = activeZoom
    ? resolveFollowCursorTargetAtTime(activeZoom, state, timeMs, cursorEngine)
    : undefined

  const previousZoom = activeZoom ? findPreviousZoomSegment(state, activeZoom) : null

  const zoomTransform = activeZoom
    ? resolveZoomTransform(activeZoom, timeMs, state.canvas, {
        target: followTarget,
        fromTarget: previousZoom?.target,
        fromScale: previousZoom?.scale,
      })
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

  const annotations: AnnotationLayer[] = state.tracks
    .filter((track) => !track.muted)
    .flatMap((track) =>
      track.clips
        .filter((clip): clip is AnnotationClip => clip.kind === "annotation")
        .map((clip) => ({
          clip,
          active: clip.enabled !== false && isActiveClip(clip, timeMs),
        })),
    )

  const texts: TextLayer[] = state.tracks
    .filter((track) => !track.muted)
    .flatMap((track) =>
      track.clips
        .filter((clip): clip is TextClip => clip.kind === "text")
        .map((clip) => ({
          clip,
          active: clip.enabled !== false && isActiveClip(clip, timeMs),
        })),
    )

  const images: ImageLayer[] = state.tracks
    .filter((track) => !track.muted)
    .flatMap((track) =>
      track.clips
        .filter((clip): clip is ImageClip => clip.kind === "image")
        .map((clip) => ({
          clip,
          active: clip.enabled !== false && isActiveClip(clip, timeMs),
        })),
    )

  const cursorEffect = findCursorEffectAtTime(state, timeMs)
  const cursorSourceTimeMs = timelineToCursorSourceTime(state, timeMs)
  const cursorSettings = cursorSettingsForEffect(state.canvas.cursorSettings, cursorEffect)

  let cursorSourcePoint: { x: number; y: number } | null = null
  let cursorFrame: CursorFrame | null = null
  if (cursorSourceTimeMs !== null && cursorEngine) {
    const frame = cursorEngine.evaluate(cursorSourceTimeMs, cursorSettings)
    if (frame.visible) {
      const fitted = fitCursorPoint(
        { x: frame.sourceX, y: frame.sourceY },
        cursorEngine.telemetry,
        canvas.width,
        canvas.height,
      )
      if (fitted.visible) {
        cursorSourcePoint = { x: fitted.x, y: fitted.y }
        cursorFrame = frame
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
    frame: cursorFrame,
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
    annotations,
    texts,
    images,
    cursor,
  }
}

/**
 * Convert a zoom transform into the same CSS transform string used by the
 * preview video and the cursor overlay so they share one geometry.
 * Uses standard top-left origin (0 0) with scale and crop translation.
 */
export function zoomTransformToCss(
  transform: ZoomTransform,
  canvas: { width: number; height: number },
): string {
  const canvasWidth = Math.max(1, canvas.width)
  const canvasHeight = Math.max(1, canvas.height)
  const cropXPercent = (transform.crop.x / canvasWidth) * 100
  const cropYPercent = (transform.crop.y / canvasHeight) * 100
  const scaleX = canvasWidth / Math.max(1, transform.crop.width)
  const scaleY = canvasHeight / Math.max(1, transform.crop.height)
  const scale =
    Math.abs(scaleX - scaleY) < 1e-6 ? `scale(${scaleX})` : `scale(${scaleX}, ${scaleY})`
  return `${scale} translate(-${cropXPercent}%, -${cropYPercent}%)`
}
