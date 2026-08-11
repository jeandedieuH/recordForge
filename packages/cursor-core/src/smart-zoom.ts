import type {
  CursorButtonEventV2,
  CursorTelemetryEvent,
  CursorTelemetryFile,
  ManualZoomSegment,
  SmartZoomSettings,
  TimelineCanvas,
  ZoomEasing,
  ZoomPreset,
  ZoomTarget,
} from "@recordforge/contracts"
import { defaultSmartZoomSettings } from "@recordforge/contracts"

export interface CursorClickFeature {
  kind: "click"
  timeMs: number
  x: number
  y: number
  button: "left" | "right" | "middle"
  buttonEvent: CursorButtonEventV2
}

export interface CursorDwellFeature {
  kind: "dwell"
  startMs: number
  endMs: number
  durationMs: number
  x: number
  y: number
}

export interface CursorMovementFeature {
  kind: "movement"
  startMs: number
  endMs: number
  durationMs: number
  distancePx: number
  speedPxPerSecond: number
  from: { x: number; y: number }
  to: { x: number; y: number }
}

export interface CursorSafeEdgeFeature {
  kind: "safe-edge"
  timeMs: number
  x: number
  y: number
  distanceToLeft: number
  distanceToRight: number
  distanceToTop: number
  distanceToBottom: number
  nearLeft: boolean
  nearRight: boolean
  nearTop: boolean
  nearBottom: boolean
}

export interface CursorInteractionFeatures {
  clicks: CursorClickFeature[]
  dwells: CursorDwellFeature[]
  movements: CursorMovementFeature[]
  safeEdges: CursorSafeEdgeFeature[]
}

export interface CursorAnalysisOptions {
  minDwellMs?: number
  dwellTolerancePx?: number
  minMovementPx?: number
  safeEdgePadding?: number
}

export interface SmartZoomGenerationOptions extends Partial<SmartZoomSettings> {
  durationMs?: number
  minMovementPx?: number
}

interface ZoomPresetProfile {
  scale: number
  clickDurationMs: number
  dwellTailMs: number
  easing: ZoomEasing
}

interface ZoomCandidate {
  startMs: number
  endMs: number
  x: number
  y: number
  source: "click" | "dwell"
  priority: number
  easing: ZoomEasing
  preset: ZoomPreset
}

const PRESET_PROFILES: Record<ZoomPreset, ZoomPresetProfile> = {
  subtle: { scale: 1.25, clickDurationMs: 850, dwellTailMs: 420, easing: "smooth" },
  "product-demo": { scale: 1.5, clickDurationMs: 1_100, dwellTailMs: 540, easing: "ease-in-out" },
  cinematic: { scale: 1.8, clickDurationMs: 1_600, dwellTailMs: 800, easing: "cinematic" },
  "manual-only": { scale: 1, clickDurationMs: 0, dwellTailMs: 0, easing: "linear" },
}

function distanceBetween(left: { x: number; y: number }, right: { x: number; y: number }): number {
  return Math.hypot(left.x - right.x, left.y - right.y)
}

function sourcePoint(event: CursorTelemetryEvent): { x: number; y: number } {
  return { x: event.sourceX, y: event.sourceY }
}

function clampRange(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function finishDwell(
  telemetry: CursorTelemetryFile,
  startIndex: number,
  endIndex: number,
  minDwellMs: number,
): CursorDwellFeature | null {
  const start = telemetry.events[startIndex]
  const end = telemetry.events[endIndex]
  if (!start || !end || end.tMs - start.tMs < minDwellMs) return null

  const samples = telemetry.events.slice(startIndex, endIndex + 1)
  const position = samples.reduce(
    (sum, event) => ({ x: sum.x + event.sourceX, y: sum.y + event.sourceY }),
    {
      x: 0,
      y: 0,
    },
  )
  return {
    kind: "dwell",
    startMs: start.tMs,
    endMs: end.tMs,
    durationMs: end.tMs - start.tMs,
    x: position.x / samples.length,
    y: position.y / samples.length,
  }
}

export function analyzeCursorTelemetry(
  telemetry: CursorTelemetryFile,
  options: CursorAnalysisOptions = {},
): CursorInteractionFeatures {
  const events = telemetry.events
  const minDwellMs = Math.max(100, options.minDwellMs ?? defaultSmartZoomSettings.minDwellMs)
  const dwellTolerancePx = Math.max(
    0,
    options.dwellTolerancePx ?? defaultSmartZoomSettings.dwellTolerancePx,
  )
  const minMovementPx = Math.max(1, options.minMovementPx ?? 48)
  const safeEdgePadding = Math.max(
    0,
    options.safeEdgePadding ?? defaultSmartZoomSettings.safeEdgePadding,
  )
  function clickButton(event: CursorTelemetryEvent): "left" | "right" | "middle" {
    const prefix = event.buttonEvent.split("-")[0]
    if (prefix === "left" || prefix === "right" || prefix === "middle") return prefix
    return "left"
  }

  const clicks = events.flatMap<CursorClickFeature>((event) =>
    event.buttonEvent !== "none" && event.buttonEvent.endsWith("-down")
      ? [
          {
            kind: "click",
            timeMs: event.tMs,
            x: event.sourceX,
            y: event.sourceY,
            button: clickButton(event),
            buttonEvent: event.buttonEvent,
          },
        ]
      : [],
  )

  const dwells: CursorDwellFeature[] = []
  if (events.length > 0) {
    let startIndex = 0
    const anchor = sourcePoint(events[0])
    for (let index = 1; index < events.length; index++) {
      const event = events[index]
      if (distanceBetween(anchor, sourcePoint(event)) > dwellTolerancePx) {
        const dwell = finishDwell(telemetry, startIndex, index - 1, minDwellMs)
        if (dwell) dwells.push(dwell)
        startIndex = index
        anchor.x = event.sourceX
        anchor.y = event.sourceY
      }
    }
    const dwell = finishDwell(telemetry, startIndex, events.length - 1, minDwellMs)
    if (dwell) dwells.push(dwell)
  }

  const movements: CursorMovementFeature[] = []
  for (let index = 1; index < events.length; index++) {
    const previous = events[index - 1]
    const current = events[index]
    const durationMs = current.tMs - previous.tMs
    const distancePx = distanceBetween(sourcePoint(previous), sourcePoint(current))
    if (durationMs <= 0 || distancePx < minMovementPx) continue
    movements.push({
      kind: "movement",
      startMs: previous.tMs,
      endMs: current.tMs,
      durationMs,
      distancePx,
      speedPxPerSecond: (distancePx * 1_000) / durationMs,
      from: sourcePoint(previous),
      to: sourcePoint(current),
    })
  }

  const sourceWidth = Math.max(1, telemetry.sourceWidth)
  const sourceHeight = Math.max(1, telemetry.sourceHeight)
  const safeEdges = events.map<CursorSafeEdgeFeature>((event) => ({
    kind: "safe-edge",
    timeMs: event.tMs,
    x: event.sourceX,
    y: event.sourceY,
    distanceToLeft: event.sourceX,
    distanceToRight: Math.max(0, sourceWidth - event.sourceX),
    distanceToTop: event.sourceY,
    distanceToBottom: Math.max(0, sourceHeight - event.sourceY),
    nearLeft: event.sourceX <= safeEdgePadding,
    nearRight: sourceWidth - event.sourceX <= safeEdgePadding,
    nearTop: event.sourceY <= safeEdgePadding,
    nearBottom: sourceHeight - event.sourceY <= safeEdgePadding,
  }))

  return { clicks, dwells, movements, safeEdges }
}

/** Clamp a target to the same padded visible canvas used by preview and export. */
export function clampZoomTarget(
  target: ZoomTarget,
  canvas: Pick<TimelineCanvas, "width" | "height" | "padding">,
  extraPadding = 0,
): ZoomTarget {
  const padding = Math.max(0, (canvas.padding ?? 0) + extraPadding)
  const left = Math.min(padding, Math.max(0, canvas.width - 1))
  const top = Math.min(padding, Math.max(0, canvas.height - 1))
  const right = Math.max(left + 1, canvas.width - padding)
  const bottom = Math.max(top + 1, canvas.height - padding)
  const width = Math.min(Math.max(1, target.width), right - left)
  const height = Math.min(Math.max(1, target.height), bottom - top)

  return {
    x: clampRange(target.x, left, right - width),
    y: clampRange(target.y, top, bottom - height),
    width,
    height,
  }
}

/** Build an aspect-ratio-preserving crop around a canvas-space cursor point. */
export function zoomTargetForCursorPoint(
  point: { x: number; y: number },
  canvas: Pick<TimelineCanvas, "width" | "height" | "padding">,
  desiredScale: number,
  extraPadding = 0,
): ZoomTarget {
  const safeScale = clampRange(desiredScale, 1.05, 8)
  // Derive both dimensions from the output canvas, not the padded content
  // rectangle. Padding can have a different aspect ratio and must not distort
  // the crop used by preview/export.
  const safePadding = Math.max(0, (canvas.padding ?? 0) + extraPadding)
  const availableWidth = Math.max(1, canvas.width - safePadding * 2)
  const availableHeight = Math.max(1, canvas.height - safePadding * 2)
  const aspectRatio = canvas.width / Math.max(1, canvas.height)
  const targetWidth = Math.min(
    canvas.width / safeScale,
    availableWidth,
    availableHeight * aspectRatio,
  )
  const targetHeight = targetWidth / aspectRatio
  const target = {
    x: point.x - targetWidth / 2,
    y: point.y - targetHeight / 2,
    width: targetWidth,
    height: targetHeight,
  }
  return clampZoomTarget(target, canvas, extraPadding)
}

function mergeCandidateRange(
  candidate: ZoomCandidate,
  previous: ZoomCandidate | undefined,
): ZoomCandidate | null {
  if (!previous || candidate.startMs >= previous.endMs) return candidate
  const startMs = previous.endMs
  if (candidate.endMs - startMs < 100) return null
  return { ...candidate, startMs }
}

function resolvedGenerationSettings(options: SmartZoomGenerationOptions): {
  settings: SmartZoomSettings
  profile: ZoomPresetProfile
} {
  const preset = options.preset ?? defaultSmartZoomSettings.preset
  const profile = PRESET_PROFILES[preset]
  const settings = {
    ...defaultSmartZoomSettings,
    ...options,
    preset,
    targetScale:
      options.targetScale === undefined ||
      options.targetScale === defaultSmartZoomSettings.targetScale
        ? profile.scale
        : options.targetScale,
    clickDurationMs:
      options.clickDurationMs === undefined ||
      options.clickDurationMs === defaultSmartZoomSettings.clickDurationMs
        ? profile.clickDurationMs
        : options.clickDurationMs,
    dwellTailMs:
      options.dwellTailMs === undefined ||
      options.dwellTailMs === defaultSmartZoomSettings.dwellTailMs
        ? profile.dwellTailMs
        : options.dwellTailMs,
  }
  return { settings, profile }
}

export function sourcePointToCanvas(
  telemetry: CursorTelemetryFile,
  canvas: Pick<TimelineCanvas, "width" | "height">,
  point: { x: number; y: number },
): { x: number; y: number } {
  const sourceWidth = Math.max(1, telemetry.sourceWidth)
  const sourceHeight = Math.max(1, telemetry.sourceHeight)
  const sourceX = clampRange(point.x, 0, sourceWidth)
  const sourceY = clampRange(point.y, 0, sourceHeight)
  const scale = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight)
  return {
    x: (canvas.width - sourceWidth * scale) / 2 + sourceX * scale,
    y: (canvas.height - sourceHeight * scale) / 2 + sourceY * scale,
  }
}

function candidateId(candidate: ZoomCandidate, index: number): string {
  return `smart-zoom:${candidate.source}:${candidate.startMs}:${index}`
}

/** Generate deterministic, editable zoom suggestions from cursor activity. */
export function generateSmartZoomSuggestions(
  telemetry: CursorTelemetryFile,
  canvas: TimelineCanvas,
  options: SmartZoomGenerationOptions = {},
): ManualZoomSegment[] {
  const { settings, profile } = resolvedGenerationSettings(options)
  if (settings.preset === "manual-only") return []
  if (telemetry.events.length === 0) return []

  const features = analyzeCursorTelemetry(telemetry, settings)
  const candidates: ZoomCandidate[] = []
  const durationMs = options.durationMs ?? Number.POSITIVE_INFINITY
  if (settings.includeClicks) {
    for (const click of features.clicks) {
      candidates.push({
        startMs: Math.max(0, click.timeMs - settings.clickLeadInMs),
        endMs: Math.min(durationMs, click.timeMs + settings.clickDurationMs),
        x: click.x,
        y: click.y,
        source: "click",
        priority: 2,
        easing: profile.easing,
        preset: settings.preset,
      })
    }
  }
  if (settings.includeDwells) {
    for (const dwell of features.dwells) {
      candidates.push({
        startMs: Math.max(0, dwell.startMs - settings.dwellLeadInMs),
        endMs: Math.min(durationMs, dwell.endMs + settings.dwellTailMs),
        x: dwell.x,
        y: dwell.y,
        source: "dwell",
        priority: 1,
        easing: profile.easing,
        preset: settings.preset,
      })
    }
  }

  const sortedCandidates = candidates
    .filter((candidate) => candidate.endMs - candidate.startMs >= settings.minSegmentDurationMs)
    .map((candidate) => ({
      ...candidate,
      endMs: Math.min(candidate.endMs, candidate.startMs + settings.maxSegmentDurationMs),
    }))
    .sort((left, right) => left.startMs - right.startMs || right.priority - left.priority)
  const resolved: ZoomCandidate[] = []
  for (const candidate of sortedCandidates) {
    const adjusted = mergeCandidateRange(candidate, resolved[resolved.length - 1])
    if (adjusted && adjusted.endMs - adjusted.startMs >= settings.minSegmentDurationMs) {
      resolved.push(adjusted)
    }
  }

  return resolved.map((candidate, index) => {
    const point = sourcePointToCanvas(telemetry, canvas, candidate)
    return {
      id: candidateId(candidate, index),
      startMs: candidate.startMs,
      durationMs: candidate.endMs - candidate.startMs,
      target: zoomTargetForCursorPoint(
        point,
        canvas,
        settings.targetScale,
        settings.safeEdgePadding,
      ),
      scale: 1,
      easing: candidate.easing,
      enabled: true,
      locked: false,
      mode: "auto",
      source: candidate.source,
      preset: candidate.preset,
    }
  })
}

export const generateZoomSuggestions = generateSmartZoomSuggestions
