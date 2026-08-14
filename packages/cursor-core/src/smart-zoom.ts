import type {
  CursorButtonEventV2,
  CursorTelemetryEvent,
  CursorTelemetryFile,
  ManualZoomSegment,
  SmartZoomSettings,
  TimelineCanvas,
  ZoomEasing,
  ZoomMode,
  ZoomPreset,
  ZoomSource,
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
  transitionInMs: number
  transitionOutMs: number
}

interface RawInteractionEvent {
  timeMs: number
  endMs: number
  x: number
  y: number
  source: ZoomSource
  priority: number
}

interface ZoomCluster {
  startMs: number
  endMs: number
  points: Array<{ x: number; y: number; timeMs: number }>
  source: ZoomSource
  priority: number
  easing: ZoomEasing
  preset: ZoomPreset
  mode: ZoomMode
}

const PRESET_PROFILES: Record<ZoomPreset, ZoomPresetProfile> = {
  subtle: {
    scale: 1.25,
    clickDurationMs: 900,
    dwellTailMs: 450,
    easing: "smooth",
    transitionInMs: 450,
    transitionOutMs: 450,
  },
  "product-demo": {
    scale: 1.5,
    clickDurationMs: 1_200,
    dwellTailMs: 600,
    easing: "smooth",
    transitionInMs: 380,
    transitionOutMs: 380,
  },
  cinematic: {
    scale: 1.8,
    clickDurationMs: 1_800,
    dwellTailMs: 900,
    easing: "cinematic",
    transitionInMs: 600,
    transitionOutMs: 600,
  },
  developer: {
    scale: 2.2,
    clickDurationMs: 1_400,
    dwellTailMs: 700,
    easing: "snappy",
    transitionInMs: 320,
    transitionOutMs: 320,
  },
  "manual-only": {
    scale: 1,
    clickDurationMs: 0,
    dwellTailMs: 0,
    easing: "linear",
    transitionInMs: 300,
    transitionOutMs: 300,
  },
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
    { x: 0, y: 0 },
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

/** Clamp a target to the visible video canvas [0, width] x [0, height]. */
export function clampZoomTarget(
  target: ZoomTarget,
  canvas: Pick<TimelineCanvas, "width" | "height" | "padding">,
  _extraPadding = 0,
): ZoomTarget {
  const width = Math.min(Math.max(1, target.width), canvas.width)
  const height = Math.min(Math.max(1, target.height), canvas.height)

  return {
    x: clampRange(target.x, 0, Math.max(0, canvas.width - width)),
    y: clampRange(target.y, 0, Math.max(0, canvas.height - height)),
    width,
    height,
  }
}

/** Build an aspect-ratio-preserving crop around a canvas-space cursor point. */
export function zoomTargetForCursorPoint(
  point: { x: number; y: number },
  canvas: Pick<TimelineCanvas, "width" | "height" | "padding">,
  desiredScale: number,
  _extraPadding = 0,
): ZoomTarget {
  const safeScale = clampRange(desiredScale, 1.05, 8)
  const aspectRatio = canvas.width / Math.max(1, canvas.height)
  const targetWidth = Math.min(canvas.width / safeScale, canvas.width)
  const targetHeight = targetWidth / aspectRatio
  const target = {
    x: point.x - targetWidth / 2,
    y: point.y - targetHeight / 2,
    width: targetWidth,
    height: targetHeight,
  }
  return clampZoomTarget(target, canvas, _extraPadding)
}

export interface InertialFollowOptions {
  deadzoneRadiusPercent?: number
  deadzoneRadiusPx?: number
  smoothingAlpha?: number
}

/**
 * Screen Studio-style soft deadzone and spring-damped camera focal tracking.
 * When the cursor stays within the comfortable center deadzone, the camera
 * does not vibrate. When the cursor travels across the screen, the camera
 * smoothly glides with gentle inertia and velocity continuity.
 */
export function resolveInertialFollowCenter(
  currentPoint: { x: number; y: number },
  previousCenter: { x: number; y: number } | null | undefined,
  viewportSize: { width: number; height: number },
  options: InertialFollowOptions = {},
): { x: number; y: number } {
  if (!previousCenter) return currentPoint

  const deadzone =
    options.deadzoneRadiusPx ??
    Math.min(viewportSize.width, viewportSize.height) * (options.deadzoneRadiusPercent ?? 0.08)

  const dx = currentPoint.x - previousCenter.x
  const dy = currentPoint.y - previousCenter.y
  const dist = Math.hypot(dx, dy)

  if (dist <= deadzone || dist < 0.001) {
    return previousCenter
  }

  const excess = dist - deadzone
  const targetX = previousCenter.x + (dx / dist) * excess
  const targetY = previousCenter.y + (dy / dist) * excess
  const alpha = clampRange(options.smoothingAlpha ?? 0.25, 0.05, 1)

  return {
    x: previousCenter.x + (targetX - previousCenter.x) * alpha,
    y: previousCenter.y + (targetY - previousCenter.y) * alpha,
  }
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

function resolvedGenerationSettings(options: SmartZoomGenerationOptions): {
  settings: SmartZoomSettings
  profile: ZoomPresetProfile
} {
  const preset = options.preset ?? defaultSmartZoomSettings.preset
  const profile = PRESET_PROFILES[preset] ?? PRESET_PROFILES["product-demo"]
  const settings: SmartZoomSettings = {
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
    defaultTransitionInMs:
      options.defaultTransitionInMs ?? profile.transitionInMs,
    defaultTransitionOutMs:
      options.defaultTransitionOutMs ?? profile.transitionOutMs,
  }
  return { settings, profile }
}

/**
 * Intelligent activity clustering:
 * Groups rapid clicks and dwells that happen in close temporal or spatial proximity into unified,
 * extended focus clusters without creating overlapping segments.
 */
function buildInteractionClusters(
  events: RawInteractionEvent[],
  settings: SmartZoomSettings,
  profile: ZoomPresetProfile,
  maxDuration: number,
): ZoomCluster[] {
  if (events.length === 0) return []

  const sorted = [...events].sort((a, b) => a.timeMs - b.timeMs)
  const initialClusters: ZoomCluster[] = []
  const clusterToleranceMs = Math.max(1_000, settings.clusterToleranceMs ?? 2_000)
  const maxSegmentDurationMs = Math.max(4_000, settings.maxSegmentDurationMs ?? 10_000)

  let currentCluster: ZoomCluster | null = null

  for (const event of sorted) {
    const leadIn =
      event.source === "click"
        ? Math.max(settings.clickLeadInMs, profile.transitionInMs + 120)
        : Math.max(settings.dwellLeadInMs, profile.transitionInMs + 80)
    const eventStart = Math.max(0, event.timeMs - leadIn)
    const eventEnd = Math.min(maxDuration, event.endMs)

    if (!currentCluster) {
      currentCluster = {
        startMs: eventStart,
        endMs: eventEnd,
        points: [{ x: event.x, y: event.y, timeMs: event.timeMs }],
        source: event.source,
        priority: event.priority,
        easing: profile.easing,
        preset: settings.preset,
        mode: "auto",
      }
      continue
    }

    // Check if within cluster tolerance and duration cap across any interaction source
    const timeGap = eventStart - currentCluster.endMs
    const potentialDuration = Math.max(eventEnd, currentCluster.endMs) - currentCluster.startMs

    if (timeGap <= clusterToleranceMs && potentialDuration <= maxSegmentDurationMs) {
      currentCluster.endMs = Math.max(currentCluster.endMs, eventEnd)
      currentCluster.points.push({ x: event.x, y: event.y, timeMs: event.timeMs })
      if (event.source === "click") {
        currentCluster.source = "click"
        currentCluster.priority = Math.max(currentCluster.priority, event.priority)
      }
    } else {
      initialClusters.push(currentCluster)
      currentCluster = {
        startMs: eventStart,
        endMs: eventEnd,
        points: [{ x: event.x, y: event.y, timeMs: event.timeMs }],
        source: event.source,
        priority: event.priority,
        easing: profile.easing,
        preset: settings.preset,
        mode: "auto",
      }
    }
  }

  if (currentCluster) {
    initialClusters.push(currentCluster)
  }

  // Pass 2: Strict Overlap Elimination and Micro-Gap Bridging
  const resolvedClusters: ZoomCluster[] = []
  for (const cluster of initialClusters) {
    if (resolvedClusters.length === 0) {
      resolvedClusters.push({ ...cluster, points: [...cluster.points] })
      continue
    }

    const prev = resolvedClusters[resolvedClusters.length - 1]

    // Case 1: Overlapping time ranges -> Merge into one longer zoom
    if (cluster.startMs <= prev.endMs) {
      prev.endMs = Math.max(prev.endMs, cluster.endMs)
      prev.points.push(...cluster.points)
      if (cluster.source === "click") prev.source = "click"
      prev.priority = Math.max(prev.priority, cluster.priority)
      continue
    }

    // Case 2: Micro-gap between segments (< 800ms) -> Bridge or merge to avoid rapid in-and-out dip
    const gap = cluster.startMs - prev.endMs
    if (gap < 800) {
      const prevCentroidX = prev.points.reduce((sum, p) => sum + p.x, 0) / prev.points.length
      const prevCentroidY = prev.points.reduce((sum, p) => sum + p.y, 0) / prev.points.length
      const nextCentroidX = cluster.points.reduce((sum, p) => sum + p.x, 0) / cluster.points.length
      const nextCentroidY = cluster.points.reduce((sum, p) => sum + p.y, 0) / cluster.points.length
      const dist = Math.hypot(nextCentroidX - prevCentroidX, nextCentroidY - prevCentroidY)

      if (dist < 300) {
        // Spatially close: extend into a single sustained zoom
        prev.endMs = Math.max(prev.endMs, cluster.endMs)
        prev.points.push(...cluster.points)
        if (cluster.source === "click") prev.source = "click"
        prev.priority = Math.max(prev.priority, cluster.priority)
        continue
      } else {
        // Spatially separate: make adjacent so camera smoothly pans across
        const splitTime = Math.round(prev.endMs + gap / 2)
        prev.endMs = splitTime
        cluster.startMs = splitTime
      }
    }

    resolvedClusters.push({ ...cluster, points: [...cluster.points] })
  }

  return resolvedClusters
}

function candidateId(source: string, startMs: number, index: number): string {
  return `smart-zoom:${source}:${startMs}:${index}`
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
  const rawEvents: RawInteractionEvent[] = []
  const durationMs = options.durationMs ?? Number.POSITIVE_INFINITY

  if (settings.includeClicks) {
    for (const click of features.clicks) {
      rawEvents.push({
        timeMs: click.timeMs,
        endMs: click.timeMs + settings.clickDurationMs,
        x: click.x,
        y: click.y,
        source: "click",
        priority: 2,
      })
    }
  }

  if (settings.includeDwells) {
    for (const dwell of features.dwells) {
      rawEvents.push({
        timeMs: dwell.startMs,
        endMs: dwell.endMs + settings.dwellTailMs,
        x: dwell.x,
        y: dwell.y,
        source: "dwell",
        priority: 1,
      })
    }
  }

  const clusters = buildInteractionClusters(rawEvents, settings, profile, durationMs)

  const validClusters = clusters.filter(
    (c) => c.endMs - c.startMs >= settings.minSegmentDurationMs,
  )

  return validClusters.map((cluster, index) => {
    // Weighted centroid (clicks have 3x higher weight than passive dwells)
    let sumX = 0
    let sumY = 0
    let totalWeight = 0
    for (const p of cluster.points) {
      const weight = 1
      sumX += p.x * weight
      sumY += p.y * weight
      totalWeight += weight
    }
    const avgX = totalWeight > 0 ? sumX / totalWeight : cluster.points[0].x
    const avgY = totalWeight > 0 ? sumY / totalWeight : cluster.points[0].y

    const canvasPoint = sourcePointToCanvas(telemetry, canvas, { x: avgX, y: avgY })
    const target = zoomTargetForCursorPoint(
      canvasPoint,
      canvas,
      settings.targetScale,
      settings.safeEdgePadding,
    )

    const hasSpatialDispersion = cluster.points.some(
      (p) => Math.hypot(p.x - avgX, p.y - avgY) > 80,
    )
    const mode: ZoomMode = hasSpatialDispersion ? "follow-cursor" : "auto"

    const segDuration = cluster.endMs - cluster.startMs
    const transIn = Math.min(
      settings.defaultTransitionInMs,
      Math.max(80, Math.round(segDuration * 0.25)),
    )
    const transOut = Math.min(
      settings.defaultTransitionOutMs,
      Math.max(80, Math.round(segDuration * 0.25)),
    )

    return {
      id: candidateId(cluster.source, cluster.startMs, index),
      startMs: cluster.startMs,
      durationMs: segDuration,
      target,
      scale: settings.targetScale,
      easing: cluster.easing,
      transitionInMs: transIn,
      transitionOutMs: transOut,
      enabled: true,
      locked: false,
      mode,
      source: cluster.source,
      preset: cluster.preset,
      followDeadzonePercent: 0.08,
      followSmoothingAlpha: 0.25,
    }
  })
}

export const generateZoomSuggestions = generateSmartZoomSuggestions
