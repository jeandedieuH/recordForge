import {
  cursorTelemetryFileSchema,
  defaultCursorSettings,
  type CursorEffectClip,
  type CursorSettings,
  type CursorTelemetryEvent,
  type CursorTelemetryFile,
  type ManualZoomSegment,
  type TimelineClip,
  type TimelineState,
} from "@recordforge/contracts"
import { CURSOR_ASSET_MANIFEST, type CursorAssetId } from "./assets"

export interface CursorEventLookup {
  event: CursorTelemetryEvent
  index: number
  distanceMs: number
}

export interface CursorSourcePoint {
  x: number
  y: number
}

export interface CursorFitResult {
  x: number
  y: number
  scale: number
  offsetX: number
  offsetY: number
  sourceX: number
  sourceY: number
  wasClamped: boolean
  visible: boolean
}

export interface CursorFitOptions {
  clampToSource?: boolean
}

export interface CursorViewport {
  width: number
  height: number
}

export interface CursorCanvasGeometry {
  width: number
  height: number
}

export interface CursorZoomTransform {
  scale: number
  crop: {
    x: number
    y: number
    width: number
    height: number
  }
}

export interface CursorZoomedPoint extends CursorSourcePoint {
  /** Uniform scale to apply to cursor artwork after the canvas crop. */
  scale: number
}

export function normalizeCursorTelemetry(input: unknown): CursorTelemetryFile {
  const parsed = cursorTelemetryFileSchema.parse(input)
  const events = parsed.events
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event }) =>
        Number.isFinite(event.tMs) &&
        Number.isFinite(event.sourceX) &&
        Number.isFinite(event.sourceY),
    )
    .sort((left, right) => left.event.tMs - right.event.tMs || left.index - right.index)
    .map(({ event }) => event)

  return { ...parsed, events }
}

/** Find the nearest event with a left-biased tie break shared by preview/export. */
export function findCursorEventAtTime(
  telemetry: CursorTelemetryFile,
  timeMs: number,
): CursorEventLookup | null {
  if (telemetry.events.length === 0 || !Number.isFinite(timeMs)) return null

  let low = 0
  let high = telemetry.events.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (telemetry.events[middle].tMs < timeMs) low = middle + 1
    else high = middle
  }

  const right = Math.min(low, telemetry.events.length - 1)
  const left = Math.max(0, right - 1)
  const leftDistance = Math.abs(telemetry.events[left].tMs - timeMs)
  const rightDistance = Math.abs(telemetry.events[right].tMs - timeMs)
  const index = leftDistance <= rightDistance ? left : right
  return {
    event: telemetry.events[index],
    index,
    distanceMs: Math.abs(telemetry.events[index].tMs - timeMs),
  }
}

export function isCursorClickEdge(event: CursorTelemetryEvent): boolean {
  return event.buttonEvent !== "none" && event.buttonEvent.endsWith("-down")
}

export function isCursorButtonEnabled(
  event: CursorTelemetryEvent,
  settings: Pick<CursorSettings, "leftClickEnabled" | "rightClickEnabled">,
): boolean {
  if (!isCursorClickEdge(event)) return false
  if (event.buttonEvent.startsWith("left")) return settings.leftClickEnabled
  if (event.buttonEvent.startsWith("right")) return settings.rightClickEnabled
  return true
}

export function getSmoothingFactor(
  smoothing: "off" | "smooth" | "strong",
  fallback = defaultCursorSettings.smoothFactor,
): number {
  if (smoothing === "off") return 1
  if (smoothing === "strong") return 0.12
  return fallback
}

export function smoothCursorPosition(
  telemetry: CursorTelemetryFile,
  eventIndex: number,
  settings: Pick<CursorSettings, "smoothMovement" | "smoothFactor"> & {
    smoothing?: "off" | "smooth" | "strong"
  },
): CursorSourcePoint {
  const event = telemetry.events[eventIndex]
  if (!event || !settings.smoothMovement || settings.smoothing === "off") {
    return { x: event?.sourceX ?? 0, y: event?.sourceY ?? 0 }
  }

  const factor = getSmoothingFactor(settings.smoothing ?? "smooth", settings.smoothFactor)
  const windowSize = 5
  let sumX = 0
  let sumY = 0
  let totalWeight = 0
  for (let index = Math.max(0, eventIndex - windowSize); index <= eventIndex; index++) {
    const weight = Math.pow(1 - factor, eventIndex - index)
    sumX += telemetry.events[index].sourceX * weight
    sumY += telemetry.events[index].sourceY * weight
    totalWeight += weight
  }
  return {
    x: totalWeight > 0 ? sumX / totalWeight : event.sourceX,
    y: totalWeight > 0 ? sumY / totalWeight : event.sourceY,
  }
}

export function isCursorIdle(
  telemetry: CursorTelemetryFile,
  eventIndex: number,
  timeMs: number,
  timeoutMs: number,
): boolean {
  if (eventIndex <= 0 || timeoutMs <= 0) return false
  const current = telemetry.events[eventIndex]
  for (let index = eventIndex - 1; index >= 0; index--) {
    const previous = telemetry.events[index]
    if (
      previous.sourceX !== current.sourceX ||
      previous.sourceY !== current.sourceY ||
      isCursorClickEdge(previous)
    ) {
      return Math.max(0, timeMs - previous.tMs) >= timeoutMs
    }
  }
  return Math.max(0, timeMs - current.tMs) >= timeoutMs
}

/**
 * Map normalized source coordinates into an aspect-fit output. Capture bounds
 * and DPI are resolved when telemetry is recorded; this function only handles
 * the final source-to-viewport fit shared by preview and export.
 */
export function fitCursorPoint(
  point: CursorSourcePoint,
  telemetry: Pick<CursorTelemetryFile, "sourceWidth" | "sourceHeight">,
  targetWidth: number,
  targetHeight: number,
  options: CursorFitOptions = {},
): CursorFitResult {
  const sourceWidth = Math.max(1, telemetry.sourceWidth)
  const sourceHeight = Math.max(1, telemetry.sourceHeight)
  const clampToSource = options.clampToSource ?? true
  const rawSourceX = point.x
  const rawSourceY = point.y
  const sourceX = clampToSource ? Math.min(sourceWidth, Math.max(0, rawSourceX)) : rawSourceX
  const sourceY = clampToSource ? Math.min(sourceHeight, Math.max(0, rawSourceY)) : rawSourceY
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight)
  const offsetX = (targetWidth - sourceWidth * scale) / 2
  const offsetY = (targetHeight - sourceHeight * scale) / 2
  const wasClamped = sourceX !== rawSourceX || sourceY !== rawSourceY
  const visible = targetWidth > 0 && targetHeight > 0 && Number.isFinite(scale)

  return {
    x: offsetX + sourceX * scale,
    y: offsetY + sourceY * scale,
    scale,
    offsetX,
    offsetY,
    sourceX,
    sourceY,
    wasClamped,
    visible,
  }
}

/**
 * Apply the canvas crop used by the preview video to a fitted cursor point.
 *
 * Cursor points are already in the fitted video viewport; the zoom crop is in
 * full-canvas coordinates. Converting the crop through normalized canvas
 * coordinates keeps padding, letterboxing, and side-by-side screen rectangles
 * on the same transform as the video layer.
 */
export function mapCursorPointThroughZoom(
  point: CursorSourcePoint,
  viewport: CursorViewport,
  canvas: CursorCanvasGeometry,
  transform: CursorZoomTransform | null | undefined,
): CursorZoomedPoint {
  const viewportWidth = Math.max(1, viewport.width)
  const viewportHeight = Math.max(1, viewport.height)
  const canvasWidth = Math.max(1, canvas.width)
  const canvasHeight = Math.max(1, canvas.height)

  if (!transform) return { ...point, scale: 1 }

  const cropX = Number.isFinite(transform.crop.x)
    ? (transform.crop.x / canvasWidth) * viewportWidth
    : 0
  const cropY = Number.isFinite(transform.crop.y)
    ? (transform.crop.y / canvasHeight) * viewportHeight
    : 0
  const cropWidth = Math.max(
    1e-6,
    (Number.isFinite(transform.crop.width) ? transform.crop.width : canvasWidth) / canvasWidth,
  )
  const cropHeight = Math.max(
    1e-6,
    (Number.isFinite(transform.crop.height) ? transform.crop.height : canvasHeight) / canvasHeight,
  )
  const scaleX = 1 / cropWidth
  const scaleY = 1 / cropHeight

  return {
    x: (point.x - cropX) / cropWidth,
    y: (point.y - cropY) / cropHeight,
    // Cursor artwork remains uniform even if a legacy target has a non-canvas
    // aspect ratio; the video transform uses the smaller axis as its safe fit.
    scale: Math.min(scaleX, scaleY),
  }
}

export function findTimelineClipAt(
  state: TimelineState,
  trackKind: "screen" | "cursor",
  timelineMs: number,
): TimelineClip | null {
  const track = state.tracks.find((candidate) => candidate.kind === trackKind)
  return (
    track?.clips.find(
      (clip) => timelineMs >= clip.startMs && timelineMs < clip.startMs + clip.durationMs,
    ) ?? null
  )
}

export function timelineToCursorSourceTime(
  state: TimelineState,
  timelineMs: number,
): number | null {
  const clip = findTimelineClipAt(state, "screen", timelineMs)
  if (!clip) return null

  // Use the persisted clip endpoints, not an independently rounded speed
  // multiplication, so preview time mapping matches export's endpoint mapping.
  const timelineDuration = Math.max(1, clip.durationMs)
  const sourceDuration = Math.max(0, clip.sourceOutMs - clip.sourceInMs)
  return clip.sourceInMs + ((timelineMs - clip.startMs) / timelineDuration) * sourceDuration
}

/**
 * Evaluate the fitted cursor position in canvas coordinates at a given timeline timestamp.
 * Returns null if no active screen clip exists, no telemetry is present, or cursor is hidden.
 */
export function getCursorPointAtTimelineTime(
  state: TimelineState | null | undefined,
  timelineMs: number,
  telemetry: CursorTelemetryFile | null | undefined,
  cursorEngine?: {
    evaluate: (
      timeMs: number,
      settings: CursorSettings,
    ) => { sourceX: number; sourceY: number; visible: boolean }
  } | null,
): { x: number; y: number } | null {
  if (!state || !telemetry) return null
  const sourceTimeMs = timelineToCursorSourceTime(state, timelineMs)
  if (sourceTimeMs === null) return null

  if (cursorEngine) {
    const frame = cursorEngine.evaluate(sourceTimeMs, state.canvas.cursorSettings)
    if (!frame.visible) return null
    const fitted = fitCursorPoint(
      { x: frame.sourceX, y: frame.sourceY },
      telemetry,
      state.canvas.width,
      state.canvas.height,
    )
    if (!fitted.visible) return null
    return { x: fitted.x, y: fitted.y }
  }

  const lookup = findCursorEventAtTime(telemetry, sourceTimeMs)
  if (!lookup || !lookup.event.visible) return null
  const fitted = fitCursorPoint(
    { x: lookup.event.sourceX, y: lookup.event.sourceY },
    telemetry,
    state.canvas.width,
    state.canvas.height,
  )
  if (!fitted.visible) return null
  return { x: fitted.x, y: fitted.y }
}

export function findCursorEffectAtTime(
  state: TimelineState,
  timelineMs: number,
): CursorEffectClip | null {
  const track = state.tracks.find((candidate) => candidate.kind === "cursor")
  return (
    (track?.clips.find(
      (clip): clip is CursorEffectClip =>
        clip.kind === "cursor-effect" &&
        timelineMs >= clip.startMs &&
        timelineMs < clip.startMs + clip.durationMs,
    ) as CursorEffectClip | undefined) ?? null
  )
}

export * from "./smart-zoom"
export * from "./engine"
export * from "./wasm-engine"
export * from "./assets"

export function cursorSettingsForEffect(
  base: CursorSettings | undefined,
  effect: CursorEffectClip | null,
): CursorSettings {
  const settings = { ...(base ?? defaultCursorSettings), ...(effect?.settings ?? {}) }
  if (!effect) return settings

  return {
    ...settings,
    enabled: effect.enabled,
    preset: effect.settings.preset ?? effect.presetId,
    scale: effect.settings.scale ?? effect.scale,
    smoothMovement: effect.settings.smoothMovement ?? effect.smoothing !== "off",
    smoothFactor:
      effect.settings.smoothFactor ?? getSmoothingFactor(effect.smoothing, settings.smoothFactor),
  }
}

export interface CursorRangeBadge {
  key: string
  label: string
  variant: "default" | "secondary" | "outline" | "warning"
}

/**
 * Return a small set of human-readable badges that describe how a cursor range
 * differs from the project cursor profile. Empty when the range fully inherits.
 */
export function cursorRangeOverrideLabels(
  range: CursorEffectClip,
  base: CursorSettings | undefined,
): CursorRangeBadge[] {
  const badges: CursorRangeBadge[] = []
  if (range.locked) badges.push({ key: "locked", label: "Locked", variant: "secondary" })
  if (!range.enabled) badges.push({ key: "hidden", label: "Hidden", variant: "outline" })

  const effectivePreset = range.settings?.preset ?? range.presetId
  if (base && effectivePreset !== base.preset) {
    const presetLabel =
      CURSOR_ASSET_MANIFEST[effectivePreset as CursorAssetId]?.label ?? effectivePreset
    badges.push({ key: "preset", label: `Style: ${presetLabel}`, variant: "default" })
  }

  const effectiveScale = range.settings?.scale ?? range.scale
  if (base && effectiveScale !== base.scale) {
    badges.push({
      key: "scale",
      label: `Size ${Math.round(effectiveScale * 100)}%`,
      variant: "secondary",
    })
  }

  const effectiveSmoothMovement = range.settings?.smoothMovement ?? range.smoothing !== "off"
  if (base && effectiveSmoothMovement !== base.smoothMovement) {
    badges.push({
      key: "smoothing",
      label: effectiveSmoothMovement ? "Smooth" : "Precise",
      variant: "secondary",
    })
  }

  const effectiveClick = range.settings?.clickFeedback
  if (base && effectiveClick && effectiveClick !== base.clickFeedback) {
    badges.push({ key: "click", label: `Click: ${effectiveClick}`, variant: "secondary" })
  }

  const effectiveIdle = range.settings?.autoHideIdle
  if (base && effectiveIdle !== undefined && effectiveIdle !== base.autoHideIdle) {
    badges.push({
      key: "idle",
      label: effectiveIdle ? "Idle fade" : "Always show",
      variant: "secondary",
    })
  }

  const effectiveShapeMode = range.settings?.shapeMode
  if (base && effectiveShapeMode && effectiveShapeMode !== base.shapeMode) {
    badges.push({
      key: "shape",
      label: `Shape: ${effectiveShapeMode}`,
      variant: "secondary",
    })
  }

  return badges
}

export interface ZoomSegmentBadge {
  key: string
  label: string
  variant: "default" | "secondary" | "outline" | "warning"
}

/** Human-readable badges for a zoom segment: source, lock state, and preset. */
export function zoomSegmentBadges(segment: ManualZoomSegment): ZoomSegmentBadge[] {
  const badges: ZoomSegmentBadge[] = []
  if (segment.locked) badges.push({ key: "locked", label: "Locked", variant: "secondary" })

  if (segment.mode === "follow-cursor") {
    badges.push({ key: "mode", label: "Follow cursor", variant: "default" })
  } else if (segment.mode === "smooth-pan") {
    badges.push({ key: "mode", label: "Pan", variant: "default" })
  }

  if (segment.mode === "auto") {
    badges.push({
      key: "source",
      label:
        segment.source === "click"
          ? "From click"
          : segment.source === "dwell"
            ? "From dwell"
            : segment.source === "cluster"
              ? "Action cluster"
              : "Auto",
      variant: "default",
    })
  } else if (segment.mode !== "follow-cursor" && segment.mode !== "smooth-pan") {
    badges.push({ key: "source", label: "Manual", variant: "outline" })
  }

  if (segment.preset && segment.preset !== "manual-only") {
    badges.push({ key: "preset", label: segment.preset, variant: "secondary" })
  }

  if (segment.label) {
    badges.push({ key: "label", label: segment.label, variant: "outline" })
  }

  return badges
}
