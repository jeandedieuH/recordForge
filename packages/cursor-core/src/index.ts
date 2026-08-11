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

export function normalizeCursorTelemetry(input: unknown): CursorTelemetryFile {
  const parsed = cursorTelemetryFileSchema.parse(input)
  const events = parsed.events
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event }) =>
        Number.isFinite(event.tMs) && Number.isFinite(event.x) && Number.isFinite(event.y),
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
  return event.buttonEvent === "down" || (event.buttonEvent === "none" && event.clicked)
}

export function isCursorButtonEnabled(
  event: CursorTelemetryEvent,
  settings: Pick<CursorSettings, "leftClickEnabled" | "rightClickEnabled">,
): boolean {
  if (!isCursorClickEdge(event)) return false
  if (event.button === "left") return settings.leftClickEnabled
  if (event.button === "right") return settings.rightClickEnabled
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
    return { x: event?.x ?? 0, y: event?.y ?? 0 }
  }

  const factor = getSmoothingFactor(settings.smoothing ?? "smooth", settings.smoothFactor)
  const windowSize = 5
  let sumX = 0
  let sumY = 0
  let totalWeight = 0
  for (let index = Math.max(0, eventIndex - windowSize); index <= eventIndex; index++) {
    const weight = Math.pow(1 - factor, eventIndex - index)
    sumX += telemetry.events[index].x * weight
    sumY += telemetry.events[index].y * weight
    totalWeight += weight
  }
  return {
    x: totalWeight > 0 ? sumX / totalWeight : event.x,
    y: totalWeight > 0 ? sumY / totalWeight : event.y,
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
    if (previous.x !== current.x || previous.y !== current.y || isCursorClickEdge(previous)) {
      return Math.max(0, timeMs - previous.tMs) >= timeoutMs
    }
  }
  return Math.max(0, timeMs - current.tMs) >= timeoutMs
}

/**
 * Map source coordinates into an aspect-fit output. Capture bounds and DPI are
 * applied before fitting so preview and export use the same geometry.
 */
export function fitCursorPoint(
  point: CursorSourcePoint,
  telemetry: Pick<
    CursorTelemetryFile,
    "sourceWidth" | "sourceHeight" | "captureBounds" | "dpiScale"
  >,
  targetWidth: number,
  targetHeight: number,
  options: CursorFitOptions = {},
): CursorFitResult {
  const sourceWidth = Math.max(1, telemetry.sourceWidth)
  const sourceHeight = Math.max(1, telemetry.sourceHeight)
  const captureWidth = Math.max(1, telemetry.captureBounds.width)
  const captureHeight = Math.max(1, telemetry.captureBounds.height)
  const sourceScaleX = (sourceWidth / captureWidth) * telemetry.dpiScale.x
  const sourceScaleY = (sourceHeight / captureHeight) * telemetry.dpiScale.y
  const rawSourceX = point.x * sourceScaleX
  const rawSourceY = point.y * sourceScaleY
  const clampToSource = options.clampToSource ?? true
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
  return clip.sourceInMs + (timelineMs - clip.startMs) * clip.speed
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
    badges.push({ key: "preset", label: `Style: ${effectivePreset}`, variant: "default" })
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

  if (segment.mode === "auto") {
    badges.push({
      key: "source",
      label:
        segment.source === "click"
          ? "From click"
          : segment.source === "dwell"
            ? "From dwell"
            : "Auto",
      variant: "default",
    })
  } else {
    badges.push({ key: "source", label: "Manual", variant: "outline" })
  }

  if (segment.preset && segment.preset !== "manual-only") {
    badges.push({ key: "preset", label: segment.preset, variant: "secondary" })
  }

  return badges
}
