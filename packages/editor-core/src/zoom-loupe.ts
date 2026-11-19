import type {
  LoupeSettings,
  ManualZoomSegment,
  TimelineState,
  ZoomTarget,
} from "@recordforge/contracts"
import { loupeSettingsSchema } from "@recordforge/contracts"
import { canonicalizeZoomTarget, type CursorEngine } from "@recordforge/cursor-core"
import { resolveZoomTransform, type CanvasRect } from "./composition"

/**
 * Glass Loupe (#2) resolution.
 *
 * A loupe segment is a zoom segment with `style: "loupe"`. It never zooms the
 * frame: `resolveCameraShots` skips it, and the lens magnifies the segment's
 * target over the recording. Preview, render plan and both export renderers
 * read the pose produced here, so the lens cannot drift between them.
 */

/** Lens presence ramps from 0 to 1 across this fraction of its transition. */
const LENS_MIN_PRESENCE_SCALE = 0.88

// Resolved settings are derived data; caching them keeps a per-frame preview
// from re-validating the same object.
const settingsCache = new WeakMap<object, LoupeSettings>()

export function isLoupeSegment(segment: ManualZoomSegment): boolean {
  return segment.style === "loupe"
}

/** Loupe settings with schema defaults applied (single source of truth). */
export function resolveLoupeSettings(settings?: Partial<LoupeSettings> | null): LoupeSettings {
  if (!settings) return loupeSettingsSchema.parse({})
  const cached = settingsCache.get(settings)
  if (cached) return cached
  const resolved = loupeSettingsSchema.parse(settings)
  settingsCache.set(settings, resolved)
  return resolved
}

export interface LoupePose {
  /** False outside the segment or while the lens is fully faded. */
  visible: boolean
  /** 0..1 growth/fade curve shared by lens radius and opacity. */
  presence: number
  /** Lens centre in canvas pixels. */
  center: { x: number; y: number }
  /** Lens bounds in canvas pixels (square, centred on `center`). */
  rect: CanvasRect
  /** Magnified content in canvas coordinates. */
  target: ZoomTarget
  /** Magnification factor (the segment's `scale`). */
  scale: number
  /**
   * True when the lens rides a resolved cursor point; false means it is parked
   * on `settings.center`/the target centre. Callers hide the drawn cursor only
   * while the lens actually follows it.
   */
  following: boolean
  settings: LoupeSettings
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Enabled loupe segments in timeline order. Unlike camera shots they are not
 * bridged: each lens fades in and out around its own range.
 */
export function resolveLoupes(state: TimelineState): ManualZoomSegment[] {
  // References, not copies: commands always replace whole segment objects, so
  // callers may key derived caches on segment identity.
  return (state.zoomSegments ?? [])
    .filter((segment) => segment.enabled && isLoupeSegment(segment))
    .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))
}

/** The loupe segment covering `timeMs`, if any. */
export function findLoupeAtTime(state: TimelineState, timeMs: number): ManualZoomSegment | null {
  return (
    resolveLoupes(state)
      .filter(
        (segment) => timeMs >= segment.startMs && timeMs < segment.startMs + segment.durationMs,
      )
      .slice(-1)[0] ?? null
  )
}

export interface ResolveLoupeOptions {
  /**
   * Fitted screen video rect on the canvas, in canvas pixels. Defaults to the
   * full canvas (`{ x: 0, y: 0, width, height }`) so unpadded 16:9 callers keep
   * identity coordinates while padded, non-16:9, and side-by-side layouts map
   * zoom-space points onto the actual rendered screen area.
   */
  screenRect?: CanvasRect | null
  /**
   * Displayed cursor tip in canvas pixels (after any active frame zoom). When
   * provided while the lens follows the cursor, the lens sits over this visible
   * pointer while still magnifying the unzoomed screen point underneath it.
   */
  displayCursorPoint?: { x: number; y: number } | null
}

/**
 * Map a zoom-space point (`[0..canvas.width] × [0..canvas.height]`) onto the
 * fitted screen rect in canvas pixels. Identity when the screen fills the canvas.
 */
export function zoomPointToScreenRect(
  point: { x: number; y: number },
  canvas: { width: number; height: number },
  screenRect: CanvasRect,
): { x: number; y: number } {
  const canvasW = Math.max(1, canvas.width)
  const canvasH = Math.max(1, canvas.height)
  return {
    x: screenRect.x + (point.x / canvasW) * screenRect.width,
    y: screenRect.y + (point.y / canvasH) * screenRect.height,
  }
}

/**
 * Resolve the lens pose for one loupe segment at a timeline time.
 *
 * The lens always rides the cursor tip: `cursorPoint` is the recorded pointer's
 * unzoomed position in zoom space (`[0..canvas.width] × [0..canvas.height]`).
 * When provided, the magnified `target` centres on the pointer inside
 * `screenRect` and the lens centre rides `displayCursorPoint` (or the unzoomed
 * screen point when no frame zoom is active) plus `settings.offset`. Without a
 * cursor point the lens magnifies the segment target mapped into `screenRect`
 * and parks on `settings.center` (already canvas px) or that target centre.
 */
export function resolveLoupeAt(
  segment: ManualZoomSegment,
  state: TimelineState,
  timeMs: number,
  // Kept for caller compatibility — the lens rides the explicit cursor point
  // now, not a follow-camera plan evaluated through the engine.
  _cursorEngine?: CursorEngine | null,
  cursorPoint?: { x: number; y: number } | null,
  options?: ResolveLoupeOptions,
): LoupePose {
  const canvas = { width: state.canvas.width, height: state.canvas.height }
  const screenRect: CanvasRect = options?.screenRect ?? {
    x: 0,
    y: 0,
    width: canvas.width,
    height: canvas.height,
  }
  const settings = resolveLoupeSettings(segment.loupe)
  const transform = resolveZoomTransform(segment, timeMs, state.canvas)
  const presence = clamp(transform.progress, 0, 1)

  const following = cursorPoint != null
  let target: ZoomTarget
  let rawCenter: { x: number; y: number }

  if (following) {
    // Mirror `exports/loupe.rs`: a 1x1 target centred on the unzoomed screen
    // point lets `loupeSampleSquare` clamp the actual `diameter/scale` square
    // against `screenRect` without double-clamping near edges.
    const sampleCenter = zoomPointToScreenRect(cursorPoint, canvas, screenRect)
    target = {
      x: sampleCenter.x - 0.5,
      y: sampleCenter.y - 0.5,
      width: 1,
      height: 1,
    }
    rawCenter = options?.displayCursorPoint ?? sampleCenter
  } else {
    const canonical = canonicalizeZoomTarget(segment.target, state.canvas, segment.scale)
    const sampleCenter = zoomPointToScreenRect(
      {
        x: canonical.x + canonical.width / 2,
        y: canonical.y + canonical.height / 2,
      },
      canvas,
      screenRect,
    )
    const scaleX = screenRect.width / Math.max(1, canvas.width)
    const scaleY = screenRect.height / Math.max(1, canvas.height)
    target = {
      x: screenRect.x + canonical.x * scaleX,
      y: screenRect.y + canonical.y * scaleY,
      width: canonical.width * scaleX,
      height: canonical.height * scaleY,
    }
    rawCenter = settings.center ?? sampleCenter
  }

  const offset = settings.offset ?? { x: 0, y: 0 }
  const diameter =
    settings.size *
    Math.min(canvas.width, canvas.height) *
    (LENS_MIN_PRESENCE_SCALE + (1 - LENS_MIN_PRESENCE_SCALE) * presence)
  const radius = diameter / 2
  const center = {
    x: clamp(rawCenter.x + offset.x, radius, Math.max(radius, canvas.width - radius)),
    y: clamp(rawCenter.y + offset.y, radius, Math.max(radius, canvas.height - radius)),
  }

  return {
    visible: presence > 0.001,
    presence,
    center,
    rect: {
      x: center.x - radius,
      y: center.y - radius,
      width: diameter,
      height: diameter,
    },
    target,
    scale: segment.scale,
    following,
    settings,
  }
}

/**
 * The square the lens samples: `diameter / scale`, centred on the target and
 * kept inside the content rect. Mirrors `loupe_sample_square` in
 * `src-tauri/src/exports/loupe.rs`, so the preview lens and both renderers
 * magnify the same pixels — a 2x loupe samples half its own diameter.
 */
export function loupeSampleSquare(pose: LoupePose, content: CanvasRect): CanvasRect {
  const side = clamp(
    pose.rect.width / Math.max(1, pose.scale),
    1,
    Math.max(1, Math.min(content.width, content.height)),
  )
  const centreX = clamp(
    pose.target.x + pose.target.width / 2,
    content.x + side / 2,
    content.x + content.width - side / 2,
  )
  const centreY = clamp(
    pose.target.y + pose.target.height / 2,
    content.y + side / 2,
    content.y + content.height - side / 2,
  )
  return { x: centreX - side / 2, y: centreY - side / 2, width: side, height: side }
}

/**
 * Lens corner radius in canvas pixels. Circles return half the size, so the
 * same rounded-rect SDF covers both shapes.
 */
export function loupeCornerRadius(pose: LoupePose): number {
  if (pose.settings.shape === "circle") return pose.rect.width / 2
  return (pose.settings.cornerRadius * pose.rect.width) / 2
}

/** CSS pixels per canvas pixel on the preview surface. */
export function loupeSurfaceScale(
  containerWidth: number,
  containerHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number } {
  return {
    x: Math.max(0.0001, containerWidth / Math.max(1, canvasWidth)),
    y: Math.max(0.0001, containerHeight / Math.max(1, canvasHeight)),
  }
}

/**
 * Lens offset after dragging it by a CSS-pixel delta. The lens centre is the
 * cursor point (or fallback centre) plus this nudge, so a canvas drag
 * accumulates onto `loupe.offset` rather than writing an absolute centre.
 */
export function loupeOffsetAfterDrag(
  offset: { x: number; y: number },
  deltaCss: { x: number; y: number },
  surfaceScale: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: offset.x + deltaCss.x / surfaceScale.x,
    y: offset.y + deltaCss.y / surfaceScale.y,
  }
}

/**
 * Lens size (fraction of the canvas short edge) after dragging the corner
 * handle by `deltaCssX`. Growing the lens moves the handle by half the diameter
 * change on each side, hence the doubled delta.
 */
export function loupeSizeAfterResize(
  diameterPx: number,
  deltaCssX: number,
  surfaceScaleX: number,
  canvasShortEdge: number,
): number {
  const nextDiameter = Math.max(24, diameterPx + deltaCssX * 2)
  return Math.min(1, Math.max(0.08, nextDiameter / surfaceScaleX / Math.max(1, canvasShortEdge)))
}
