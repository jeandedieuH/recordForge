import type {
  AppError,
  AudioVolumeKeyframe,
  CursorTelemetryFile,
  ExportRange,
  OverlayRenderPlan,
  ProjectAsset,
  ProjectExportSettings,
  RenderPlan,
  RenderPlanAnnotation,
  RenderPlanAudio,
  RenderPlanCaption,
  RenderPlanCursorEffect,
  RenderPlanImage,
  RenderPlanMask,
  RenderCaptionMode,
  RenderChapterMode,
  RenderPlanOverlay,
  RenderPlanText,
  RenderPlanZoomMotionPlan,
  RenderPlanZoomSegment,
  RenderSegment,
  OverlayRenderItem,
  OverlayTransform,
  TimelineClip,
  TimelineState,
} from "@recordforge/domain"
import {
  buildFollowCursorMotionPlan,
  findPreviousZoomSegment,
  getManualZoomSegments,
  resolveFollowCursorTargetAtTime,
  timelineMarkersToChapters,
} from "@recordforge/editor-core"
import {
  canonicalizeZoomTarget,
  createCursorEngine,
  type CursorEngine,
} from "@recordforge/cursor-core"
import {
  annotationClipSchema,
  imageClipSchema,
  normalizeOverlayClipInput,
  overlayRenderPlanSchema,
  sortClips,
  textClipSchema,
} from "@recordforge/domain"

function editorError(code: string, message: string): AppError {
  return { category: "editor", code, message }
}

interface WindowedClip {
  sourceInMs: number
  sourceOutMs: number
  outputStartMs: number
  outputEndMs: number
}

function resolveRange(range: ExportRange | undefined): ExportRange | undefined {
  if (!range) return undefined
  const startMs = Math.round(range.startMs)
  const endMs = Math.round(range.endMs)
  if (endMs <= startMs) return undefined
  return { startMs, endMs }
}

function windowClip(clip: TimelineClip, range: ExportRange | undefined): WindowedClip | null {
  const clipStartMs = Math.round(clip.startMs)
  const clipDurationMs = Math.round(clip.durationMs)
  const clipEndMs = clipStartMs + clipDurationMs
  const rangeStartMs = range ? Math.round(range.startMs) : undefined
  const rangeEndMs = range ? Math.round(range.endMs) : undefined
  const startMs = Math.max(clipStartMs, rangeStartMs ?? 0)
  const endMs = Math.min(clipEndMs, rangeEndMs ?? clipEndMs)
  if (endMs <= startMs) return null

  const outputOffsetMs = rangeStartMs ?? 0
  const relativeStartMs = startMs - clipStartMs
  const relativeEndMs = endMs - clipStartMs
  const sourceInMs = Math.round(clip.sourceInMs)
  return {
    sourceInMs: sourceInMs + Math.round(relativeStartMs * clip.speed),
    sourceOutMs: sourceInMs + Math.round(relativeEndMs * clip.speed),
    outputStartMs: Math.round(startMs - outputOffsetMs),
    outputEndMs: Math.round(endMs - outputOffsetMs),
  }
}

function windowTimeRange(
  startMs: number,
  endMs: number,
  range: ExportRange | undefined,
): { startMs: number; endMs: number } | null {
  const rangeStart = range ? Math.round(range.startMs) : 0
  const rangeEnd = range ? Math.round(range.endMs) : undefined
  const roundedStart = Math.round(startMs)
  const roundedEnd = Math.round(endMs)
  const start = Math.max(roundedStart, rangeStart)
  const end = Math.min(roundedEnd, rangeEnd ?? roundedEnd)
  if (end <= start) return null
  return { startMs: Math.round(start - rangeStart), endMs: Math.round(end - rangeStart) }
}

function assetForClip(
  assets: ProjectAsset[] | undefined,
  assetId: string,
): ProjectAsset | undefined {
  return assets?.find((asset) => asset.id === assetId)
}

function toSegments(
  clips: TimelineClip[],
  range: ExportRange | undefined,
  includeAudioSettings = false,
  assets?: ProjectAsset[],
): RenderSegment[] {
  return sortClips(clips)
    .map((clip) => {
      const window = windowClip(clip, range)
      if (!window) return null
      const durationMs = window.outputEndMs - window.outputStartMs
      const asset = assetForClip(assets, clip.assetId)
      const sourceWidth =
        asset && typeof asset.width === "number" && asset.width > 0
          ? Math.round(asset.width)
          : undefined
      const sourceHeight =
        asset && typeof asset.height === "number" && asset.height > 0
          ? Math.round(asset.height)
          : undefined
      return {
        assetId: clip.assetId,
        ...("streamIndex" in clip && clip.streamIndex !== undefined
          ? { streamIndex: Math.round(clip.streamIndex) }
          : {}),
        ...(includeAudioSettings && clip.kind === "audio"
          ? {
              volume: clip.volume,
              fadeInMs: Math.round(Math.min(clip.fadeInMs, durationMs)),
              fadeOutMs: Math.round(Math.min(clip.fadeOutMs, durationMs)),
              ...(clip.volumeKeyframes && clip.volumeKeyframes.length > 0
                ? { volumeKeyframes: clip.volumeKeyframes }
                : {}),
            }
          : {}),
        sourceInMs: window.sourceInMs,
        sourceOutMs: window.sourceOutMs,
        speed: clip.speed,
        outputStartMs: window.outputStartMs,
        outputEndMs: window.outputEndMs,
        // Native source dimensions let the export fit the video precisely.
        ...(sourceWidth !== undefined ? { sourceWidth } : {}),
        ...(sourceHeight !== undefined ? { sourceHeight } : {}),
      }
    })
    .filter((segment): segment is RenderSegment => segment !== null)
}

function toGaps(
  segments: RenderSegment[],
  durationMs: number,
): Array<{ startMs: number; endMs: number }> {
  const gaps: Array<{ startMs: number; endMs: number }> = []
  let cursorMs = 0
  const totalDuration = Math.round(durationMs)
  for (const segment of segments) {
    const segStart = Math.round(segment.outputStartMs)
    const segEnd = Math.round(segment.outputEndMs)
    if (segStart > cursorMs) {
      gaps.push({ startMs: cursorMs, endMs: segStart })
    }
    cursorMs = Math.max(cursorMs, segEnd)
  }
  if (cursorMs < totalDuration) gaps.push({ startMs: cursorMs, endMs: totalDuration })
  return gaps
}

function toOverlays(
  clips: TimelineClip[],
  canvas: TimelineState["canvas"],
  trackVisible: boolean,
  range: ExportRange | undefined,
  assets?: ProjectAsset[],
): RenderPlanOverlay[] {
  const assetById = new Map(assets?.map((asset) => [asset.id, asset]))
  return sortClips(clips)
    .filter((clip): clip is Extract<TimelineClip, { kind: "camera" }> => clip.kind === "camera")
    .flatMap((clip) => {
      const window = windowClip(clip, range)
      if (!window) return []
      const transform = clip.transform
      const width = Math.min(Math.max(0, transform.width), canvas.width)
      const height = Math.min(Math.max(0, transform.height), canvas.height)
      const asset = assetById.get(clip.assetId)
      const isStandaloneWebcam =
        asset?.role === "webcam" &&
        Boolean(
          asset.path && !asset.path.includes(":") && asset.path.toLowerCase().endsWith(".mp4"),
        )
      const streamIndex = isStandaloneWebcam ? undefined : clip.streamIndex
      return [
        {
          assetId: clip.assetId,
          ...(streamIndex !== undefined ? { streamIndex: Math.round(streamIndex) } : {}),
          sourceInMs: window.sourceInMs,
          sourceOutMs: window.sourceOutMs,
          outputStartMs: window.outputStartMs,
          outputEndMs: window.outputEndMs,
          speed: clip.speed,
          x: Math.min(Math.max(0, transform.x), Math.max(0, canvas.width - width)),
          y: Math.min(Math.max(0, transform.y), Math.max(0, canvas.height - height)),
          width,
          height,
          crop: transform.crop,
          opacity: transform.opacity,
          visible: trackVisible && transform.visible !== false,
          shape: transform.shape,
          borderWidth: transform.borderWidth,
          borderColor: transform.borderColor,
          borderOpacity: transform.borderOpacity,
          shadowEnabled: transform.shadowEnabled,
          shadowColor: transform.shadowColor,
          shadowBlur: transform.shadowBlur,
          shadowOffsetX: transform.shadowOffsetX,
          shadowOffsetY: transform.shadowOffsetY,
          preset: transform.preset,
        },
      ]
    })
}

function toCaptions(state: TimelineState, range: ExportRange | undefined): RenderPlanCaption[] {
  return state.tracks
    .filter((track) => track.kind === "captions" && !track.muted)
    .flatMap((track) =>
      sortClips(track.clips)
        .filter(
          (clip): clip is Extract<TimelineClip, { kind: "caption" }> => clip.kind === "caption",
        )
        .flatMap((clip) => {
          const window = windowTimeRange(clip.startMs, clip.startMs + clip.durationMs, range)
          if (!window) return []
          return [
            {
              id: clip.id,
              text: clip.text,
              startMs: window.startMs,
              endMs: window.endMs,
              style: clip.style,
              placement: clip.placement ?? "bottom",
              safeAreaMargin: clip.safeAreaMargin ?? 48,
            },
          ]
        }),
    )
    .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))
}

function toMasks(state: TimelineState, range: ExportRange | undefined): RenderPlanMask[] {
  return state.tracks
    .filter((track) => track.kind === "effects" && !track.muted)
    .flatMap((track) =>
      sortClips(track.clips)
        .filter((clip): clip is Extract<TimelineClip, { kind: "mask" }> => clip.kind === "mask")
        .flatMap((clip) => {
          const window = windowTimeRange(clip.startMs, clip.startMs + clip.durationMs, range)
          if (!window) return []
          const width = Math.min(Math.max(1, clip.rect.width), state.canvas.width)
          const height = Math.min(Math.max(1, clip.rect.height), state.canvas.height)
          return [
            {
              id: clip.id,
              startMs: window.startMs,
              endMs: window.endMs,
              mode: clip.mode,
              rect: {
                x: Math.min(Math.max(0, clip.rect.x), Math.max(0, state.canvas.width - width)),
                y: Math.min(Math.max(0, clip.rect.y), Math.max(0, state.canvas.height - height)),
                width,
                height,
              },
              blurRadius: clip.blurRadius,
              pixelSize: clip.pixelSize,
              redactColor: clip.redactColor,
              enabled: clip.enabled,
            },
          ]
        }),
    )
}

function toAnnotations(
  state: TimelineState,
  range: ExportRange | undefined,
): RenderPlanAnnotation[] {
  return state.tracks
    .filter((track) => !track.muted)
    .flatMap((track) =>
      sortClips(track.clips)
        .filter(
          (clip): clip is Extract<TimelineClip, { kind: "annotation" }> =>
            clip.kind === "annotation" && clip.enabled !== false,
        )
        .flatMap((clip) => {
          const window = windowTimeRange(clip.startMs, clip.startMs + clip.durationMs, range)
          if (!window) return []
          return [
            {
              id: clip.id,
              startMs: window.startMs,
              endMs: window.endMs,
              annotationType: clip.annotationType,
              x: clip.x,
              y: clip.y,
              width: clip.width,
              height: clip.height,
              endX: clip.endX,
              endY: clip.endY,
              strokeColor: clip.strokeColor,
              strokeWidth: clip.strokeWidth,
              strokeStyle: clip.strokeStyle,
              fillColor: clip.fillColor,
              fillOpacity: clip.fillOpacity,
              cornerRadius: clip.cornerRadius,
              arrowEndHead: clip.arrowEndHead,
              arrowStartHead: clip.arrowStartHead,
              shadowEnabled: clip.shadowEnabled,
              shadowColor: clip.shadowColor,
              shadowBlur: clip.shadowBlur,
              text: clip.text,
              textColor: clip.textColor,
              fontSize: clip.fontSize,
              animationIn: clip.animationIn,
              animationOut: clip.animationOut,
              enabled: clip.enabled !== false,
            },
          ]
        }),
    )
    .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))
}

function toTexts(state: TimelineState, range: ExportRange | undefined): RenderPlanText[] {
  return state.tracks
    .filter((track) => !track.muted)
    .flatMap((track) =>
      sortClips(track.clips)
        .filter(
          (clip): clip is Extract<TimelineClip, { kind: "text" }> =>
            clip.kind === "text" && clip.enabled !== false,
        )
        .flatMap((clip) => {
          const window = windowTimeRange(clip.startMs, clip.startMs + clip.durationMs, range)
          if (!window) return []
          return [
            {
              id: clip.id,
              startMs: window.startMs,
              endMs: window.endMs,
              presetId: clip.presetId,
              category: clip.category,
              primaryText: clip.primaryText,
              secondaryText: clip.secondaryText,
              tagText: clip.tagText,
              x: clip.x,
              y: clip.y,
              width: clip.width,
              height: clip.height,
              alignment: clip.alignment,
              fontFamily: clip.fontFamily,
              fontSize: clip.fontSize,
              fontWeight: clip.fontWeight,
              textColor: clip.textColor,
              secondaryTextColor: clip.secondaryTextColor,
              accentColor: clip.accentColor,
              backdropStyle: clip.backdropStyle,
              backdropColor: clip.backdropColor,
              backdropOpacity: clip.backdropOpacity,
              backdropBlur: clip.backdropBlur,
              backdropBorderRadius: clip.backdropBorderRadius,
              backdropPaddingX: clip.backdropPaddingX,
              backdropPaddingY: clip.backdropPaddingY,
              shadowEnabled: clip.shadowEnabled,
              shadowColor: clip.shadowColor,
              shadowBlur: clip.shadowBlur,
              animationIn: clip.animationIn,
              animationOut: clip.animationOut,
              autoScaleText: clip.autoScaleText ?? true,
              enabled: clip.enabled !== false,
            },
          ]
        }),
    )
    .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))
}

function toImages(state: TimelineState, range: ExportRange | undefined): RenderPlanImage[] {
  return state.tracks
    .filter((track) => !track.muted)
    .flatMap((track) =>
      sortClips(track.clips)
        .filter(
          (clip): clip is Extract<TimelineClip, { kind: "image" }> =>
            clip.kind === "image" && clip.enabled !== false,
        )
        .flatMap((clip) => {
          const window = windowTimeRange(clip.startMs, clip.startMs + clip.durationMs, range)
          if (!window) return []
          return [
            {
              id: clip.id,
              assetId: clip.assetId,
              startMs: window.startMs,
              endMs: window.endMs,
              x: clip.x,
              y: clip.y,
              width: clip.width,
              height: clip.height,
              opacity: clip.opacity,
              borderRadius: clip.borderRadius,
              borderWidth: clip.borderWidth,
              borderColor: clip.borderColor,
              shadowEnabled: clip.shadowEnabled,
              shadowColor: clip.shadowColor,
              shadowBlur: clip.shadowBlur,
              fit: clip.fit,
              animationIn: clip.animationIn,
              animationOut: clip.animationOut,
              enabled: clip.enabled !== false,
            },
          ]
        }),
    )
    .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))
}

const OVERLAY_GROUP_OFFSET: Record<"image" | "annotation" | "text", number> = {
  image: 0,
  annotation: 1_000_000,
  text: 2_000_000,
}

function overlayZIndex(
  kind: "image" | "annotation" | "text",
  zIndex: number,
  trackIndex: number,
  clipIndex: number,
): number {
  const insertionOrder = trackIndex * 1_000 + clipIndex
  return OVERLAY_GROUP_OFFSET[kind] + zIndex + (zIndex === 0 ? insertionOrder : 0)
}

function overlayTransform(
  clip: Extract<TimelineClip, { kind: "annotation" | "text" | "image" }>,
  zIndex: number,
): OverlayTransform {
  return {
    x: clip.x,
    y: clip.y,
    width: clip.width,
    height: clip.height,
    rotation: clip.rotation,
    anchorX: clip.anchorX,
    anchorY: clip.anchorY,
    zIndex,
    opacity: clip.opacity,
  }
}

interface OverlayCandidate {
  item: OverlayRenderItem
  trackIndex: number
  clipIndex: number
}

function toOverlayRenderPlan(
  state: TimelineState,
  range: ExportRange | undefined,
  assets: ProjectAsset[] | undefined,
): OverlayRenderPlan {
  const candidates: OverlayCandidate[] = []

  state.tracks.forEach((track, trackIndex) => {
    if (track.muted) return
    track.clips.forEach((clip, clipIndex) => {
      if (clip.kind !== "annotation" && clip.kind !== "text" && clip.kind !== "image") return

      const window = windowTimeRange(clip.startMs, clip.startMs + clip.durationMs, range)
      if (!window) return

      if (clip.kind === "annotation") {
        const normalized = annotationClipSchema.parse(normalizeOverlayClipInput(clip))
        if (!normalized.enabled) return
        candidates.push({
          trackIndex,
          clipIndex,
          item: {
            kind: "annotation",
            id: normalized.id,
            startMs: window.startMs,
            endMs: window.endMs,
            transform: overlayTransform(
              normalized,
              overlayZIndex("annotation", normalized.zIndex, trackIndex, clipIndex),
            ),
            animation: normalized.overlayAnimation,
            enabled: true,
            annotationType: normalized.annotationType,
            endX: normalized.endX,
            endY: normalized.endY,
            strokeColor: normalized.strokeColor,
            strokeWidth: normalized.strokeWidth,
            strokeStyle: normalized.strokeStyle,
            fillColor: normalized.fillColor,
            fillOpacity: normalized.fillOpacity,
            cornerRadius: normalized.cornerRadius,
            arrowEndHead: normalized.arrowEndHead,
            arrowStartHead: normalized.arrowStartHead,
            shadowEnabled: normalized.shadowEnabled,
            shadowColor: normalized.shadowColor,
            shadowBlur: normalized.shadowBlur,
            text: normalized.text,
            textColor: normalized.textColor,
            fontSize: normalized.fontSize,
          },
        })
        return
      }

      if (clip.kind === "text") {
        const normalized = textClipSchema.parse(normalizeOverlayClipInput(clip))
        if (!normalized.enabled) return
        candidates.push({
          trackIndex,
          clipIndex,
          item: {
            kind: "text",
            id: normalized.id,
            startMs: window.startMs,
            endMs: window.endMs,
            transform: overlayTransform(
              normalized,
              overlayZIndex("text", normalized.zIndex, trackIndex, clipIndex),
            ),
            animation: normalized.overlayAnimation,
            enabled: true,
            presetId: normalized.presetId,
            category: normalized.category,
            primaryText: normalized.primaryText,
            secondaryText: normalized.secondaryText,
            tagText: normalized.tagText,
            alignment: normalized.alignment,
            fontFamily: normalized.fontFamily,
            fontSize: normalized.fontSize,
            fontWeight: normalized.fontWeight,
            textColor: normalized.textColor,
            secondaryTextColor: normalized.secondaryTextColor,
            accentColor: normalized.accentColor,
            backdropStyle: normalized.backdropStyle,
            backdropColor: normalized.backdropColor,
            backdropOpacity: normalized.backdropOpacity,
            backdropBlur: normalized.backdropBlur,
            backdropBorderRadius: normalized.backdropBorderRadius,
            backdropPaddingX: normalized.backdropPaddingX,
            backdropPaddingY: normalized.backdropPaddingY,
            shadowEnabled: normalized.shadowEnabled,
            shadowColor: normalized.shadowColor,
            shadowBlur: normalized.shadowBlur,
            autoScaleText: normalized.autoScaleText ?? true,
          },
        })
        return
      }

      const normalized = imageClipSchema.parse(normalizeOverlayClipInput(clip))
      if (!normalized.enabled) return
      candidates.push({
        trackIndex,
        clipIndex,
        item: {
          kind: "image",
          id: normalized.id,
          startMs: window.startMs,
          endMs: window.endMs,
          transform: overlayTransform(
            normalized,
            overlayZIndex("image", normalized.zIndex, trackIndex, clipIndex),
          ),
          animation: normalized.overlayAnimation,
          enabled: true,
          assetId: normalized.assetId,
          fit: normalized.fit,
          borderRadius: normalized.borderRadius,
          borderWidth: normalized.borderWidth,
          borderColor: normalized.borderColor,
          shadowEnabled: normalized.shadowEnabled,
          shadowColor: normalized.shadowColor,
          shadowBlur: normalized.shadowBlur,
        },
      })
    })
  })

  candidates.sort(
    (left, right) =>
      left.item.transform.zIndex - right.item.transform.zIndex ||
      left.trackIndex - right.trackIndex ||
      left.clipIndex - right.clipIndex ||
      left.item.id.localeCompare(right.item.id),
  )

  const imageAssetIds = new Set(
    candidates.flatMap((candidate) =>
      candidate.item.kind === "image" ? [candidate.item.assetId] : [],
    ),
  )
  const overlayAssets = (assets ?? [])
    .filter((asset) => imageAssetIds.has(asset.id))
    .map((asset) => ({
      id: asset.id,
      kind: "image" as const,
      ...(typeof asset.width === "number" && asset.width > 0 ? { width: asset.width } : {}),
      ...(typeof asset.height === "number" && asset.height > 0 ? { height: asset.height } : {}),
      ...(asset.contentHash ? { contentHash: asset.contentHash } : {}),
    }))

  return overlayRenderPlanSchema.parse({
    canvas: { width: state.canvas.width, height: state.canvas.height },
    items: candidates.map(({ item }) => item),
    assets: overlayAssets,
    fonts: [],
  })
}

export function buildOverlayRenderPlan(
  state: TimelineState,
  assets?: ProjectAsset[],
): OverlayRenderPlan {
  return toOverlayRenderPlan(state, undefined, assets)
}

function toZoomSegments(
  state: TimelineState,
  range: ExportRange | undefined,
  options?: { cursorTelemetry?: CursorTelemetryFile | null; cursorEngine?: CursorEngine | null },
): RenderPlanZoomSegment[] {
  const engine =
    options?.cursorEngine ??
    (options?.cursorTelemetry ? createCursorEngine(options.cursorTelemetry) : null)
  return getManualZoomSegments(state)
    .filter((segment) => segment.enabled)
    .flatMap((segment) => {
      const window = windowTimeRange(segment.startMs, segment.startMs + segment.durationMs, range)
      if (!window) return []
      const duration = window.endMs - window.startMs
      const defaultTrans = Math.min(450, Math.max(60, Math.round(duration * 0.3)))
      const prevSegment = findPreviousZoomSegment(state, segment)
      const previousTarget =
        prevSegment?.mode === "follow-cursor" && engine
          ? resolveFollowCursorTargetAtTime(
              prevSegment,
              state,
              prevSegment.startMs + Math.max(1, prevSegment.durationMs),
              engine,
            )
          : prevSegment?.target
      const fromTarget = previousTarget
        ? canonicalizeZoomTarget(previousTarget, state.canvas, prevSegment?.scale ?? 1)
        : undefined
      const fromScale = prevSegment ? prevSegment.scale : undefined

      let motionPlan: RenderPlanZoomMotionPlan | undefined = undefined
      if (engine && segment.mode === "follow-cursor") {
        const sourceTimelineOffsetMs = range ? Math.round(range.startMs) : 0
        motionPlan = buildFollowCursorMotionPlan(segment, state, engine, {
          windowStartMs: window.startMs + sourceTimelineOffsetMs,
          windowEndMs: window.endMs + sourceTimelineOffsetMs,
          timeOffsetMs: sourceTimelineOffsetMs,
        })
      }

      return [
        {
          id: segment.id,
          startMs: window.startMs,
          endMs: window.endMs,
          target: canonicalizeZoomTarget(segment.target, state.canvas, segment.scale),
          scale: segment.scale ?? 1.5,
          easing: segment.easing ?? "smooth",
          transitionInMs: segment.transitionInMs ?? defaultTrans,
          transitionOutMs: segment.transitionOutMs ?? defaultTrans,
          enabled: segment.enabled,
          mode: segment.mode,
          source: segment.source,
          preset: segment.preset,
          followDeadzonePercent: segment.followDeadzonePercent,
          followSmoothingAlpha: segment.followSmoothingAlpha,
          label: segment.label,
          fromTarget,
          fromScale,
          motionPlan,
        },
      ]
    })
    .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))
}

function toCursorEffects(
  state: TimelineState,
  range: ExportRange | undefined,
  assets?: ProjectAsset[],
): RenderPlanCursorEffect[] {
  const track = state.tracks.find((candidate) => candidate.kind === "cursor")
  if (track && track.clips.length > 0) {
    return track.clips
      .filter(
        (clip): clip is Extract<TimelineClip, { kind: "cursor-effect" }> =>
          clip.kind === "cursor-effect" && clip.enabled,
      )
      .flatMap((clip) => {
        const window = windowTimeRange(clip.startMs, clip.startMs + clip.durationMs, range)
        if (!window) return []
        return [
          {
            id: clip.id,
            assetId: clip.assetId,
            startMs: window.startMs,
            endMs: window.endMs,
            enabled: clip.enabled,
            presetId: clip.presetId,
            scale: clip.scale,
            smoothing: clip.smoothing,
            settings: clip.settings,
          },
        ]
      })
      .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))
  }

  const cursorAsset = assets?.find((asset) => asset.role === "cursor_events")
  const settings = state.canvas.cursorSettings
  if (cursorAsset && (settings?.enabled ?? true)) {
    const screenTrack = state.tracks.find((candidate) => candidate.kind === "screen")
    const durationMs = screenTrack
      ? screenTrack.clips.reduce(
          (max, c) => Math.max(max, Math.round(c.startMs) + Math.round(c.durationMs)),
          0,
        )
      : 0
    const window = windowTimeRange(0, durationMs, range)
    if (!window) return []
    return [
      {
        id: `cursor-effect:${cursorAsset.id}`,
        assetId: cursorAsset.id,
        startMs: window.startMs,
        endMs: window.endMs,
        enabled: true,
        presetId: settings?.preset ?? "recorded-system",
        scale: settings?.scale ?? 1,
        smoothing: settings?.smoothMovement ? "smooth" : "off",
        settings: settings ?? {},
      },
    ]
  }

  return []
}

export function isTimelineAudioMuted(state: TimelineState): boolean {
  const audioTracks = state.tracks.filter((track) => track.kind === "audio")
  if (audioTracks.length === 0) return false
  const hasSoloTrack = audioTracks.some((track) => track.solo)
  return audioTracks.every((track) => track.muted || (hasSoloTrack && !track.solo))
}

export interface AudioVolumeFilterOptions {
  durationMs: number
  volume?: number
  fadeInMs?: number
  fadeOutMs?: number
  volumeKeyframes?: AudioVolumeKeyframe[]
  forceEval?: boolean
}

/**
 * Generates an FFmpeg audio filter string for volume control, fades, and dynamic keyframed envelopes.
 *
 * - When multi-point keyframes are present (or forceEval is true):
 *   Generates a `volume='<expr>':eval=frame` filter with continuous piecewise linear interpolation
 *   across keyframes, including optional fade-in and fade-out ramps.
 *
 * - When only static volume and/or standard fades are present:
 *   Generates standard FFmpeg `volume=X.XXXX` and `afade=t=in:...`, `afade=t=out:...` filters.
 */
export function generateAudioVolumeFilter(options: AudioVolumeFilterOptions): string {
  const durationMs = Math.max(1, Math.round(options.durationMs))
  const durationSec = durationMs / 1000
  const baseVolume = Math.max(0, Math.min(2, options.volume ?? 1))
  const fadeInMs = Math.max(0, Math.min(durationMs, Math.round(options.fadeInMs ?? 0)))
  const fadeOutMs = Math.max(0, Math.min(durationMs, Math.round(options.fadeOutMs ?? 0)))
  const fadeInSec = fadeInMs / 1000
  const fadeOutSec = fadeOutMs / 1000
  const fadeOutStartSec = Math.max(0, (durationMs - fadeOutMs) / 1000)

  const rawKeyframes = (options.volumeKeyframes ?? [])
    .filter((kf) => typeof kf.timeMs === "number" && typeof kf.volume === "number")
    .sort((a, b) => a.timeMs - b.timeMs)

  if (rawKeyframes.length > 0 || options.forceEval) {
    return generateKeyframedVolumeFilter({
      durationSec,
      baseVolume,
      fadeInSec,
      fadeOutSec,
      fadeOutStartSec,
      keyframes: rawKeyframes,
    })
  }

  // Standard volume with optional afade filters
  const filters: string[] = []
  filters.push(`volume=${baseVolume.toFixed(4)}`)

  if (fadeInSec > 0) {
    filters.push(`afade=t=in:st=0:d=${fadeInSec.toFixed(3)}`)
  }

  if (fadeOutSec > 0) {
    filters.push(`afade=t=out:st=${fadeOutStartSec.toFixed(3)}:d=${fadeOutSec.toFixed(3)}`)
  }

  return filters.join(",")
}

function generateKeyframedVolumeFilter(params: {
  durationSec: number
  baseVolume: number
  fadeInSec: number
  fadeOutSec: number
  fadeOutStartSec: number
  keyframes: AudioVolumeKeyframe[]
}): string {
  const { durationSec, baseVolume, fadeInSec, fadeOutSec, fadeOutStartSec, keyframes } = params

  if (keyframes.length === 0) {
    let expr = baseVolume.toFixed(4)
    if (fadeOutSec > 0) {
      expr = `if(gt(t,${fadeOutStartSec.toFixed(3)}),(${baseVolume.toFixed(4)}*(${durationSec.toFixed(3)}-t)/${fadeOutSec.toFixed(3)}),${expr})`
    }
    if (fadeInSec > 0) {
      expr = `if(lt(t,${fadeInSec.toFixed(3)}),(${baseVolume.toFixed(4)}*t/${fadeInSec.toFixed(3)}),${expr})`
    }
    return `volume='${expr}':eval=frame`
  }

  const kfs = keyframes.map((kf) => ({
    t: Math.max(0, Math.min(durationSec, kf.timeMs / 1000)),
    v: Math.max(0, Math.min(2, kf.volume * baseVolume)),
  }))

  const firstKf = kfs[0]!
  const lastKf = kfs[kfs.length - 1]!

  let afterLastKfExpr: string
  const effectiveFadeOutStart = Math.max(lastKf.t, fadeOutStartSec)
  const effectiveFadeOutDuration = durationSec - effectiveFadeOutStart
  if (fadeOutSec > 0 && effectiveFadeOutDuration > 0.001) {
    afterLastKfExpr = `if(gt(t,${effectiveFadeOutStart.toFixed(3)}),(${lastKf.v.toFixed(4)}*(${durationSec.toFixed(3)}-t)/${effectiveFadeOutDuration.toFixed(3)}),${lastKf.v.toFixed(4)})`
  } else {
    afterLastKfExpr = lastKf.v.toFixed(4)
  }

  let expr = afterLastKfExpr
  for (let i = kfs.length - 2; i >= 0; i--) {
    const kfA = kfs[i]!
    const kfB = kfs[i + 1]!
    const spanT = kfB.t - kfA.t
    const spanV = kfB.v - kfA.v

    let segExpr: string
    if (spanT > 0.0001) {
      if (Math.abs(spanV) > 0.0001) {
        segExpr = `${kfA.v.toFixed(4)}+(${spanV.toFixed(4)})*(t-${kfA.t.toFixed(3)})/${spanT.toFixed(3)}`
      } else {
        segExpr = kfA.v.toFixed(4)
      }
    } else {
      segExpr = kfA.v.toFixed(4)
    }

    expr = `if(lt(t,${kfB.t.toFixed(3)}),${segExpr},${expr})`
  }

  if (firstKf.t > 0.001) {
    let beforeFirstKfExpr: string
    const effectiveFadeInEnd = Math.min(firstKf.t, fadeInSec)
    if (fadeInSec > 0 && effectiveFadeInEnd > 0.001) {
      beforeFirstKfExpr = `if(lt(t,${effectiveFadeInEnd.toFixed(3)}),(${firstKf.v.toFixed(4)}*t/${effectiveFadeInEnd.toFixed(3)}),${firstKf.v.toFixed(4)})`
    } else {
      beforeFirstKfExpr = firstKf.v.toFixed(4)
    }
    expr = `if(lt(t,${firstKf.t.toFixed(3)}),${beforeFirstKfExpr},${expr})`
  } else if (fadeInSec > 0) {
    expr = `if(lt(t,${fadeInSec.toFixed(3)}),(${firstKf.v.toFixed(4)}*t/${fadeInSec.toFixed(3)}),${expr})`
  }

  return `volume='${expr}':eval=frame`
}

export interface AudioSegmentFilterOptions {
  includeAtempo?: boolean
  includeDelay?: boolean
  includePad?: boolean
  projectDurationMs?: number
  label?: string
}

/**
 * Generates the complete FFmpeg audio filter for an individual segment, including atrim,
 * optional atempo speed adjustment, volume/afade/eval filters, adelay, and apad.
 */
export function generateAudioSegmentFilter(
  segment: RenderSegment,
  options?: AudioSegmentFilterOptions,
): string {
  const parts: string[] = []

  // 1. atrim and pts normalization
  parts.push(
    `atrim=start=${(segment.sourceInMs / 1000).toFixed(3)}:end=${(segment.sourceOutMs / 1000).toFixed(3)}`,
  )
  parts.push("asetpts=PTS-STARTPTS")

  // 2. atempo speed correction
  if (options?.includeAtempo && Math.abs(segment.speed - 1) > 0.001) {
    parts.push(buildAtempoFilter(segment.speed))
  }

  // 3. volume / afade / eval filter
  const durationMs = segment.outputEndMs - segment.outputStartMs
  const volumeFilter =
    segment.audioFilter ??
    generateAudioVolumeFilter({
      durationMs,
      volume: segment.volume,
      fadeInMs: segment.fadeInMs,
      fadeOutMs: segment.fadeOutMs,
      volumeKeyframes: segment.volumeKeyframes,
    })
  parts.push(volumeFilter)

  // 4. adelay for timeline offset
  if (options?.includeDelay && segment.outputStartMs > 0) {
    parts.push(`adelay=${Math.round(segment.outputStartMs)}:all=1`)
  }

  // 5. apad for total project duration
  if (options?.includePad && options.projectDurationMs && options.projectDurationMs > 0) {
    parts.push(`apad=pad_dur=${(options.projectDurationMs / 1000).toFixed(3)}`)
  }

  const filterChain = parts.join(",")
  return options?.label ? `${filterChain}[${options.label}]` : filterChain
}

function buildAtempoFilter(speed: number): string {
  let remaining = Math.max(0.01, speed)
  const filters: string[] = []
  while (remaining > 2.0) {
    filters.push("atempo=2.0")
    remaining /= 2.0
  }
  while (remaining < 0.5) {
    filters.push("atempo=0.5")
    remaining /= 0.5
  }
  filters.push(`atempo=${remaining.toFixed(4)}`)
  return filters.join(",")
}

function buildAudioTracks(state: TimelineState, range: ExportRange | undefined): RenderPlanAudio[] {
  const audioTracks = state.tracks.filter(
    (track) => track.kind === "audio" && track.clips.length > 0,
  )
  const hasSoloTrack = audioTracks.some((track) => track.solo)
  return audioTracks.flatMap((track) => {
    const clips = sortClips(track.clips).filter(
      (clip): clip is Extract<TimelineClip, { kind: "audio" }> => clip.kind === "audio",
    )
    const segments = clips.flatMap((clip) =>
      toSegments([clip], range, true).map((segment) => {
        const segDurationMs = segment.outputEndMs - segment.outputStartMs
        const effectiveVolume = Math.min(2, clip.volume * track.volume)
        const audioFilter = generateAudioVolumeFilter({
          durationMs: segDurationMs,
          volume: effectiveVolume,
          fadeInMs: segment.fadeInMs,
          fadeOutMs: segment.fadeOutMs,
          volumeKeyframes: segment.volumeKeyframes,
        })
        return {
          ...segment,
          volume: effectiveVolume,
          audioFilter,
        }
      }),
    )
    const firstAudioClip = clips[0]
    if (!firstAudioClip || segments.length === 0) return []
    return [
      {
        assetId: firstAudioClip.assetId,
        streamIndex: firstAudioClip.streamIndex,
        role: firstAudioClip.role,
        muted: track.muted || (hasSoloTrack && !track.solo),
        volume: track.volume,
        segments,
      },
    ]
  })
}

export interface BuildRenderPlanInput {
  state: TimelineState
  projectId: string
  captionMode?: RenderCaptionMode
  chapterMode?: RenderChapterMode
  settings?: ProjectExportSettings
  range?: ExportRange
  assets?: ProjectAsset[]
  cursorTelemetry?: CursorTelemetryFile | null
  cursorEngine?: CursorEngine | null
}

// Build a render plan from timeline metadata only. Rust resolves project assets
// and the destination path after validating the project identity.
export function buildRenderPlan(
  input: BuildRenderPlanInput,
): { ok: true; value: RenderPlan } | { ok: false; error: AppError } {
  const { state } = input
  if (!input.projectId.trim()) {
    return {
      ok: false,
      error: editorError("missing_project_id", "A saved project is required for export"),
    }
  }

  const requestedRange =
    input.range ??
    (input.settings?.preset === "selected-range" ? (input.settings.range ?? undefined) : undefined)
  const range = resolveRange(requestedRange)
  if (requestedRange && !range) {
    return {
      ok: false,
      error: editorError("invalid_export_range", "Export range must have a positive duration"),
    }
  }
  if (input.settings?.preset === "selected-range" && !range) {
    return {
      ok: false,
      error: editorError("missing_export_range", "Selected-range export requires a range"),
    }
  }

  const screenTrack = state.tracks.find((track) => track.kind === "screen")
  if (!screenTrack || screenTrack.clips.length === 0) {
    return {
      ok: false,
      error: editorError("no_screen_track", "Timeline has no screen track to render"),
    }
  }

  const segments = toSegments(screenTrack.clips, range, false, input.assets)
  if (segments.length === 0) {
    return {
      ok: false,
      error: editorError(
        "empty_export_range",
        "The selected export range contains no screen media",
      ),
    }
  }

  const screenDurationMs = segments.reduce(
    (duration, segment) => Math.max(duration, segment.outputEndMs),
    0,
  )
  const durationMs = Math.round(range ? range.endMs - range.startMs : screenDurationMs)
  const effectiveRange: ExportRange = range ?? { startMs: 0, endMs: screenDurationMs }

  const cameraTrack = state.tracks.find((track) => track.kind === "camera")
  const audioTracks = buildAudioTracks(state, effectiveRange)
  const zoomSegments = toZoomSegments(state, effectiveRange, {
    cursorTelemetry: input.cursorTelemetry,
    cursorEngine: input.cursorEngine,
  })
  const cursorEffects = toCursorEffects(state, effectiveRange, input.assets)
  const captions = toCaptions(state, effectiveRange)
  const masks = toMasks(state, effectiveRange)
  const annotations = toAnnotations(state, effectiveRange)
  const texts = toTexts(state, effectiveRange)
  const images = toImages(state, effectiveRange)
  const overlayRenderPlan = toOverlayRenderPlan(state, effectiveRange, input.assets)
  const gaps = toGaps(segments, durationMs)
  const chapters = timelineMarkersToChapters(
    state.markers,
    durationMs,
    range,
    state.name || "Intro",
  )

  if (captions.some((caption) => caption.endMs > durationMs)) {
    return {
      ok: false,
      error: editorError(
        "invalid_caption_range",
        "A caption extends beyond the rendered screen timeline",
      ),
    }
  }
  if (masks.some((mask) => mask.endMs > durationMs)) {
    return {
      ok: false,
      error: editorError(
        "invalid_mask_range",
        "A privacy mask extends beyond the rendered screen timeline",
      ),
    }
  }
  for (let index = 1; index < captions.length; index++) {
    if (captions[index].startMs < captions[index - 1].endMs) {
      return {
        ok: false,
        error: editorError(
          "caption_overlap",
          "Caption clips overlap and cannot be rendered safely",
        ),
      }
    }
  }

  const overlays = cameraTrack
    ? toOverlays(cameraTrack.clips, state.canvas, !cameraTrack.muted, effectiveRange, input.assets)
    : []
  const firstScreenAssetId = segments[0].assetId
  return {
    ok: true,
    value: {
      projectId: input.projectId,
      canvas: state.canvas,
      durationMs,
      segments,
      gaps,
      audio: audioTracks[0] ?? {
        assetId: firstScreenAssetId,
        muted: false,
        volume: 1,
        segments: [],
      },
      audioTracks,
      overlays,
      captions,
      captionMode: input.captionMode ?? input.settings?.captionMode ?? "burn-in",
      chapters,
      chapterMode:
        input.settings?.container === "gif" ||
        input.settings?.container === "webp" ||
        (typeof input.settings?.preset === "string" &&
          (input.settings.preset.startsWith("gif-") || input.settings.preset.startsWith("webp-")))
          ? (input.chapterMode ?? input.settings?.chapterMode) === "both" ||
            (input.chapterMode ?? input.settings?.chapterMode) === "sidecar"
            ? "sidecar"
            : "none"
          : (input.chapterMode ?? input.settings?.chapterMode ?? "embed"),
      masks,
      zoomSegments,
      cursorEffects,
      overlayRenderPlan,
      annotations,
      texts,
      images,
    },
  }
}
