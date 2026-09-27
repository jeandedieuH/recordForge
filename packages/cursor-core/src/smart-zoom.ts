import type {
  CursorButtonEventV2,
  CursorTelemetryEvent,
  CursorTelemetryFile,
  ManualZoomSegment,
  SmartZoomSettings,
  TimelineCanvas,
  TimelineState,
  ZoomEasing,
  ZoomMode,
  ZoomPreset,
  ZoomSource,
  ZoomTarget,
} from "@recordforge/contracts"
import { defaultSmartZoomSettings } from "@recordforge/contracts"
import { cursorSourceToTimelineOccurrences, sourcePointToZoomSpace } from "./time-mapping"
import { ZOOM_PRESETS, type FollowSpeed } from "./zoom-presets"

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
  /** Skip the per-event safe-edge feature pass (default true for callers that
   *  consume it); generation never reads safeEdges so it opts out. */
  includeSafeEdges?: boolean
  /** Skip the per-event movement feature pass (default true); generation
   *  builds clusters only from clicks and dwells so it opts out. */
  includeMovements?: boolean
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
  followSpeed: FollowSpeed
}

interface RawInteractionEvent {
  timeMs: number
  endMs: number
  x: number
  y: number
  source: ZoomSource
  priority: number
}

interface ZoomClusterPoint {
  x: number
  y: number
  timeMs: number
  source: ZoomSource
}

interface ZoomCluster {
  startMs: number
  endMs: number
  points: ZoomClusterPoint[]
  source: ZoomSource
  priority: number
  easing: ZoomEasing
  preset: ZoomPreset
  mode: ZoomMode
}

function toZoomPresetProfile(definition: (typeof ZOOM_PRESETS)[ZoomPreset]): ZoomPresetProfile {
  return {
    scale: definition.scale,
    clickDurationMs: definition.clickDurationMs,
    dwellTailMs: definition.dwellTailMs,
    easing: definition.easing,
    transitionInMs: definition.transitionInMs,
    transitionOutMs: definition.transitionOutMs,
    followSpeed: definition.followSpeed,
  }
}

// Generation profiles derive from ZOOM_PRESETS so the suggester and the manual
// zoom builders can never drift apart per preset.
const PRESET_PROFILES: Record<ZoomPreset, ZoomPresetProfile> = {
  subtle: toZoomPresetProfile(ZOOM_PRESETS.subtle),
  "product-demo": toZoomPresetProfile(ZOOM_PRESETS["product-demo"]),
  cinematic: toZoomPresetProfile(ZOOM_PRESETS.cinematic),
  developer: toZoomPresetProfile(ZOOM_PRESETS.developer),
  "manual-only": toZoomPresetProfile(ZOOM_PRESETS["manual-only"]),
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

  // Sum in place: a dwell window can span a large share of a long capture, so
  // slice+reduce would allocate a full copy plus an accumulator per event.
  const sampleCount = endIndex - startIndex + 1
  let sumX = 0
  let sumY = 0
  for (let index = startIndex; index <= endIndex; index++) {
    const event = telemetry.events[index]
    sumX += event.sourceX
    sumY += event.sourceY
  }
  return {
    kind: "dwell",
    startMs: start.tMs,
    endMs: end.tMs,
    durationMs: end.tMs - start.tMs,
    x: sumX / sampleCount,
    y: sumY / sampleCount,
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

  const includeMovements = options.includeMovements ?? true
  const includeSafeEdges = options.includeSafeEdges ?? true

  const movements: CursorMovementFeature[] = []
  if (includeMovements) {
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
  }

  const sourceWidth = Math.max(1, telemetry.sourceWidth)
  const sourceHeight = Math.max(1, telemetry.sourceHeight)
  const safeEdges = includeSafeEdges
    ? events.map<CursorSafeEdgeFeature>((event) => ({
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
    : []

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

/**
 * Normalize a target into the aspect-preserving crop actually consumed by the
 * video transform. Manual targets can come from older project files where
 * `scale` and the rectangle disagree; width plus the canvas aspect is the
 * deterministic source of truth, while `scale` only migrates full-canvas
 * legacy targets.
 */
export function canonicalizeZoomTarget(
  target: ZoomTarget,
  canvas: Pick<TimelineCanvas, "width" | "height" | "padding">,
  legacyScale = 1,
): ZoomTarget {
  const clamped = clampZoomTarget(target, canvas)
  const canvasWidth = Math.max(1, canvas.width)
  const canvasHeight = Math.max(1, canvas.height)
  const safeLegacyScale = Number.isFinite(legacyScale) ? clampRange(legacyScale, 1, 8) : 1
  const usesLegacyScale = Math.abs(clamped.width - canvasWidth) < 1 && safeLegacyScale > 1.01
  const minimumCropWidth = canvasWidth / 8
  const requestedCropWidth = usesLegacyScale ? canvasWidth / safeLegacyScale : clamped.width
  const cropWidth = Math.min(canvasWidth, Math.max(minimumCropWidth, requestedCropWidth))
  const cropHeight = (cropWidth * canvasHeight) / canvasWidth
  const centerX = clamped.x + clamped.width / 2
  const centerY = clamped.y + clamped.height / 2

  return clampZoomTarget(
    {
      x: centerX - cropWidth / 2,
      y: centerY - cropHeight / 2,
      width: cropWidth,
      height: cropHeight,
    },
    canvas,
  )
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
      options.defaultTransitionInMs === undefined ||
      options.defaultTransitionInMs === defaultSmartZoomSettings.defaultTransitionInMs
        ? profile.transitionInMs
        : options.defaultTransitionInMs,
    defaultTransitionOutMs:
      options.defaultTransitionOutMs === undefined ||
      options.defaultTransitionOutMs === defaultSmartZoomSettings.defaultTransitionOutMs
        ? profile.transitionOutMs
        : options.defaultTransitionOutMs,
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
        points: [{ x: event.x, y: event.y, timeMs: event.timeMs, source: event.source }],
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
      currentCluster.points.push({
        x: event.x,
        y: event.y,
        timeMs: event.timeMs,
        source: event.source,
      })
      if (event.source === "click") {
        currentCluster.source = "click"
        currentCluster.priority = Math.max(currentCluster.priority, event.priority)
      }
    } else {
      initialClusters.push(currentCluster)
      currentCluster = {
        startMs: eventStart,
        endMs: eventEnd,
        points: [{ x: event.x, y: event.y, timeMs: event.timeMs, source: event.source }],
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

/** Total timeline span (max clip end across tracks), in timeline ms. */
function totalTimelineDurationMs(state: TimelineState): number {
  let durationMs = 0
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      durationMs = Math.max(durationMs, clip.startMs + clip.durationMs)
    }
  }
  return durationMs
}

/** Generate deterministic, editable zoom suggestions from cursor activity. */
export function generateSmartZoomSuggestions(
  telemetry: CursorTelemetryFile,
  state: TimelineState,
  options: SmartZoomGenerationOptions = {},
): ManualZoomSegment[] {
  const { settings, profile } = resolvedGenerationSettings(options)
  if (settings.preset === "manual-only") return []
  if (telemetry.events.length === 0) return []

  const canvas = state.canvas
  // Generation only consumes clicks and dwells; skip the per-event movement
  // and safe-edge passes (each allocates one object per telemetry event).
  const features = analyzeCursorTelemetry(telemetry, {
    ...settings,
    includeMovements: false,
    includeSafeEdges: false,
  })
  const rawEvents: RawInteractionEvent[] = []
  const durationMs = options.durationMs ?? totalTimelineDurationMs(state)

  // Interaction timestamps are recorded in source time; a segment must be
  // placed in timeline time or it lands on the wrong content after trims,
  // splits, and speed changes. Events outside every screen clip are dropped.
  if (settings.includeClicks) {
    for (const click of features.clicks) {
      for (const occurrence of cursorSourceToTimelineOccurrences(state, click.timeMs)) {
        rawEvents.push({
          timeMs: occurrence.timeMs,
          endMs: occurrence.timeMs + settings.clickDurationMs * occurrence.clipRatio,
          x: click.x,
          y: click.y,
          source: "click",
          priority: 2,
        })
      }
    }
  }

  if (settings.includeDwells) {
    for (const dwell of features.dwells) {
      for (const occurrence of cursorSourceToTimelineOccurrences(state, dwell.startMs)) {
        rawEvents.push({
          timeMs: occurrence.timeMs,
          endMs:
            occurrence.timeMs +
            (dwell.endMs + settings.dwellTailMs - dwell.startMs) * occurrence.clipRatio,
          x: dwell.x,
          y: dwell.y,
          source: "dwell",
          priority: 1,
        })
      }
    }
  }

  const clusters = buildInteractionClusters(rawEvents, settings, profile, durationMs)

  const validClusters = clusters.filter((c) => c.endMs - c.startMs >= settings.minSegmentDurationMs)

  return validClusters.map((cluster, index) => {
    // Weighted centroid in zoom space: an intentional click outweighs a
    // passive dwell 3:1 so the camera favors what the user pointed at.
    let sumX = 0
    let sumY = 0
    let totalWeight = 0
    let bboxMinX = Number.POSITIVE_INFINITY
    let bboxMinY = Number.POSITIVE_INFINITY
    let bboxMaxX = Number.NEGATIVE_INFINITY
    let bboxMaxY = Number.NEGATIVE_INFINITY
    for (const point of cluster.points) {
      const zoomPoint = sourcePointToZoomSpace(telemetry, canvas, point)
      const weight = point.source === "click" ? 3 : 1
      sumX += zoomPoint.x * weight
      sumY += zoomPoint.y * weight
      totalWeight += weight
      bboxMinX = Math.min(bboxMinX, zoomPoint.x)
      bboxMinY = Math.min(bboxMinY, zoomPoint.y)
      bboxMaxX = Math.max(bboxMaxX, zoomPoint.x)
      bboxMaxY = Math.max(bboxMaxY, zoomPoint.y)
    }
    const firstPoint = sourcePointToZoomSpace(telemetry, canvas, cluster.points[0])
    const center = totalWeight > 0 ? { x: sumX / totalWeight, y: sumY / totalWeight } : firstPoint

    // Auto-fit: the crop grows around the cluster bounding box (plus a 35%
    // framing margin) but never exceeds the resolved preset/user scale and
    // never zooms out past 1.25× so focus zooms always read as zooms.
    const bboxWidth = Number.isFinite(bboxMaxX - bboxMinX) ? bboxMaxX - bboxMinX : 0
    const bboxHeight = Number.isFinite(bboxMaxY - bboxMinY) ? bboxMaxY - bboxMinY : 0
    const fitScale = Math.min(
      canvas.width / Math.max(1, bboxWidth * 1.35),
      canvas.height / Math.max(1, bboxHeight * 1.35),
    )
    const maxScale = settings.targetScale
    const scale = Math.min(maxScale, Math.max(Math.min(1.25, maxScale), fitScale))

    const centeredTarget = zoomTargetForCursorPoint(center, canvas, scale)

    // Shift (never resize) the crop until it contains the whole cluster when
    // the bounding box fits inside it; then re-clamp to the canvas.
    let targetX = centeredTarget.x
    let targetY = centeredTarget.y
    if (bboxWidth <= centeredTarget.width) {
      targetX = clampRange(centeredTarget.x, bboxMaxX - centeredTarget.width, bboxMinX)
    }
    if (bboxHeight <= centeredTarget.height) {
      targetY = clampRange(centeredTarget.y, bboxMaxY - centeredTarget.height, bboxMinY)
    }
    const target = clampZoomTarget({ ...centeredTarget, x: targetX, y: targetY }, canvas)

    const mode: ZoomMode = "follow-cursor"

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
      scale,
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
      followSpeed: profile.followSpeed,
    }
  })
}

export const generateZoomSuggestions = generateSmartZoomSuggestions
