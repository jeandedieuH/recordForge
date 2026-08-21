import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { toAssetUrl } from "../../../lib/assets"
import {
  type AnnotationClip,
  type AnnotationType,
  type CursorSmoothing,
  type ImageClip,
  type ManualZoomSegment,
  type MaskClip,
  type MediaJob,
  type MediaVideoTrackOutput,
  type TextClip,
  type TimelineClip,
  type TimelineMarker,
  type TimelineTrack,
  type ZoomPreset,
} from "@recordforge/contracts"
import {
  buildSmartZoomSegment,
  createAddAnnotationClipCommand,
  createAddExternalAudioClipCommand,
  createAddImageClipCommand,
  createAddMaskClipCommand,
  createAddMarkerCommand,
  createAddZoomSegmentCommand,
  createDeleteClipCommand,
  createDeleteClipsCommand,
  createDeleteMarkerCommand,
  createDeleteRangeCommand,
  createDeleteCursorRangeCommand,
  createDeleteZoomSegmentCommand,
  createDuplicateClipCommand,
  createDuplicateClipsCommand,
  createMoveClipCommand,
  createMoveClipsCommand,
  createRippleDeleteClipCommand,
  createRippleDeleteClipsCommand,
  createRippleDeleteRangeCommand,
  createResizeCursorRangeCommand,
  createSplitClipCommand,
  createSplitCursorRangeCommand,
  createSplitZoomSegmentCommand,
  createTrimClipCommand,
  createUpdateCursorRangeCommand,
  createUpdateTrackCommand,
  createUpdateZoomSegmentCommand,
  findClip,
  getManualZoomSegments,
  resolvePreviewComposition,
  sourceToTimelineForTrack,
  zoomTransformToCss,
  type PlaybackBoundary,
  canvasShadowStyle,
  computeBackgroundImageLayerStyle,
} from "@recordforge/editor-core"
import {
  findCursorEventAtTime,
  getCursorPointAtTimelineTime,
  isCursorClickEdge,
  sourcePointToCanvas,
  zoomTargetForCursorPoint,
} from "@recordforge/cursor-core"
import { buildOverlayRenderPlan, isTimelineAudioMuted } from "@recordforge/media-core"
import { AlertCircle, Monitor } from "lucide-react"
import { Button, EmptyState, Progress, Skeleton, cn, useToast } from "@recordforge/ui"
import { useEditorStore } from "../../../stores/editor-store"
import { useTimelineStore } from "../../../stores/timeline-store"
import type {
  DerivativeResource,
  WaveformResources,
  ThumbnailManifest,
  VideoTrackThumbnailResources,
} from "../media/derivative-resources"
import { AudioTrackPreview } from "./audio-track-preview"
import { CaptionPreview } from "./caption-preview"
import { CameraPreview } from "./camera-preview"
import { MaskPreview } from "./mask-preview"
import { ZoomCanvasOverlay } from "../canvas/zoom-canvas-overlay"
import { OverlayCanvas } from "../canvas/overlay-canvas"
import { OverlaySelectionLayer } from "../canvas/overlay-selection-layer"
import { usePreRenderedBackground } from "../canvas/background-cache"
import { assetDurationMs, createImageClipForAsset } from "../assets/asset-clip-factory"
import { TimelineLanes, type CursorRangeAction, type ZoomSegmentAction } from "./timeline-lanes"
import { TimelineToolbar, type TimelineTool } from "./timeline-toolbar"
import { formatTimelineTime } from "./timeline-ruler"
import { useOverlayInteraction } from "../canvas/use-overlay-interaction"
import { useTimelineInteraction } from "./use-timeline-interaction"
import { usePlaybackClock } from "./use-playback-clock"
import { CustomCursorOverlay } from "../cursor"
import { ResizableHandle } from "../shell/resizable-handle"
import { useResizableDimension } from "../shell/use-resizable-dimension"

interface TimelineViewProps {
  recordingId: string
  thumbnailResource: DerivativeResource<ThumbnailManifest> & { retry: () => void }
  videoThumbnailResources?: VideoTrackThumbnailResources
  waveformResources: WaveformResources
  drawMode?: boolean
  drawType?: AnnotationType
  drawColor?: string
}

interface SelectedClip {
  clip: TimelineClip
  track: TimelineTrack
}

interface VideoBounds {
  left: number
  top: number
  width: number
  height: number
  scale: number
}

function isOverlayClip(clip: TimelineClip): clip is AnnotationClip | TextClip | ImageClip {
  return clip.kind === "annotation" || clip.kind === "text" || clip.kind === "image"
}

function isPreparingJob(job: MediaJob | null): boolean {
  return job?.kind === "prepare" && (job.status === "pending" || job.status === "running")
}

function isFailedPreparationJob(job: MediaJob | null): boolean {
  return job?.kind === "prepare" && job.status === "failed"
}

function TimelineLoadingState() {
  return (
    <div
      className="flex h-full min-h-160 flex-col overflow-hidden bg-background text-foreground select-none"
      aria-label="Loading timeline"
      aria-busy="true"
    >
      {/* Top Section: Monitor Canvas Preview */}
      <div className="flex min-h-0 flex-1 border-b border-border">
        <div className="flex min-w-0 flex-1 flex-col bg-background p-4">
          <div className="@container-size relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl border border-border bg-black p-2 shadow-e2">
            {/* Centered Canvas Container */}
            <div className="relative flex aspect-video max-h-full w-full max-w-4xl items-center justify-center rounded-lg border border-border/20 bg-surface-dim/40">
              <div className="flex flex-col items-center gap-3 text-center">
                <div className="flex size-16 items-center justify-center rounded-2xl bg-surface-dim text-primary/30">
                  <Monitor className="size-8 animate-pulse" aria-hidden />
                </div>
                <Skeleton className="h-4 w-32 rounded-md" />
              </div>
            </div>

            {/* Media status badge skeleton at top-left */}
            <div className="pointer-events-none absolute left-4 top-4 flex items-center gap-1.5 rounded-full border border-border/80 bg-background/80 px-2.5 py-1 backdrop-blur shadow-e1">
              <Skeleton className="size-1.5 rounded-full" />
              <Skeleton className="h-2.5 w-20 rounded" />
            </div>
          </div>
        </div>
      </div>

      {/* Resizable handle divider placeholder */}
      <div className="h-1 shrink-0 border-y border-border bg-surface-dim" />

      {/* Bottom Section: Integrated Toolbar & Timeline Lanes */}
      <div className="flex shrink-0 flex-col bg-surface-dim" style={{ height: 340 }}>
        {/* TimelineToolbar Skeleton */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-dim/80 px-3 py-1.5 backdrop-blur-md">
          {/* Left Section: Tool Selection & Quick Actions */}
          <div className="flex items-center gap-1.5">
            <div className="flex items-center rounded-lg border border-border/80 bg-surface/90 p-0.5 shadow-e1 gap-1">
              <Skeleton className="size-7 rounded-md" />
              <Skeleton className="size-7 rounded-md" />
              <Skeleton className="size-7 rounded-md" />
            </div>
            <div className="h-4 w-px bg-border/60" />
            <Skeleton className="h-7 w-20 rounded-md" />
            <Skeleton className="size-7 rounded-md" />
            <Skeleton className="h-7 w-16 rounded-md" />
            <Skeleton className="h-7 w-18 rounded-md" />
          </div>

          {/* Center Section: Transport Controls & Timecode */}
          <div className="flex items-center gap-2">
            <Skeleton className="size-7 rounded-md" />
            <Skeleton className="size-7 rounded-md" />
            <Skeleton className="size-8 rounded-full" />
            <Skeleton className="size-7 rounded-md" />
            <Skeleton className="size-7 rounded-md" />
            <Skeleton className="h-6 w-32 rounded-md" />
          </div>

          {/* Right Section: Playback Speed & Zoom Controls */}
          <div className="flex items-center gap-2">
            <Skeleton className="h-7 w-18 rounded-md" />
            <div className="hidden h-4 w-px bg-border/60 sm:block" />
            <div className="hidden items-center gap-1 sm:flex">
              <Skeleton className="size-7 rounded-md" />
              <Skeleton className="h-2 w-20 rounded-full" />
              <Skeleton className="size-7 rounded-md" />
              <Skeleton className="h-6 w-12 rounded-md" />
              <Skeleton className="h-3 w-8 rounded" />
            </div>
          </div>
        </div>

        {/* TimelineLanes Skeleton */}
        <div className="flex min-h-0 flex-1 select-none overflow-hidden">
          {/* Left Column: Track Headers */}
          <div className="w-56 shrink-0 overflow-hidden border-r border-border bg-surface shadow-e1 z-20 flex flex-col">
            <div className="flex h-13 flex-col justify-center border-b border-border/80 bg-surface-dim/95 px-3">
              <Skeleton className="h-3 w-24 rounded" />
              <Skeleton className="mt-1.5 h-2 w-16 rounded" />
            </div>
            <div className="flex flex-col divide-y divide-border/40">
              {[
                { label: "Screen", width: "w-20" },
                { label: "Audio", width: "w-16" },
                { label: "Camera", width: "w-18" },
              ].map((item, idx) => (
                <div key={idx} className="flex h-14 items-center justify-between px-3">
                  <div className="flex items-center gap-2">
                    <Skeleton className="size-4 rounded" />
                    <Skeleton className={`h-3.5 ${item.width} rounded`} />
                  </div>
                  <div className="flex items-center gap-1">
                    <Skeleton className="size-5 rounded" />
                    <Skeleton className="size-5 rounded" />
                    <Skeleton className="size-5 rounded" />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right Column: Scrollable Ruler & Tracks Area */}
          <div className="min-w-0 flex-1 overflow-hidden flex flex-col bg-surface-dim/40">
            {/* Ruler Skeleton */}
            <div className="flex h-13 items-center border-b border-border/80 bg-surface-dim/90 px-4">
              <div className="flex w-full items-center justify-between opacity-60">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="flex flex-col items-center gap-1">
                    <Skeleton className="h-2 w-10 rounded" />
                    <div className="h-2 w-px bg-border" />
                  </div>
                ))}
              </div>
            </div>

            {/* Track Lanes Skeleton */}
            <div className="flex flex-1 flex-col gap-2 p-2">
              <div className="flex h-14 items-center rounded-md bg-surface-dim/60 px-2">
                <Skeleton className="h-10 w-3/4 rounded-lg bg-overlay/80" />
              </div>
              <div className="flex h-14 items-center rounded-md bg-surface-dim/60 px-2">
                <Skeleton className="h-10 w-4/5 rounded-lg bg-overlay/80" />
              </div>
              <div className="flex h-14 items-center rounded-md bg-surface-dim/60 px-2">
                <Skeleton className="h-10 w-1/2 rounded-lg bg-overlay/80" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function EditorErrorState({
  recordingId,
  message,
  onRetry,
}: {
  recordingId: string
  message: string
  onRetry: () => void
}) {
  return (
    <div className="flex h-full min-h-160 items-center justify-center p-8">
      <EmptyState
        icon={AlertCircle}
        title="Couldn't load this recording"
        description="The editor could not load the recording assets. Try again, or return to the library."
        action={<Button onClick={onRetry}>Retry loading</Button>}
        secondaryAction={
          <span className="text-xs text-subtle-foreground">
            {import.meta.env.DEV
              ? `${message} (${recordingId})`
              : "Your original recording is unchanged."}
          </span>
        }
        className="max-w-lg"
      />
    </div>
  )
}

export function TimelineView({
  recordingId,
  thumbnailResource,
  videoThumbnailResources,
  waveformResources,
  drawMode = false,
  drawType = "rectangle",
  drawColor = "#38bdf8",
}: TimelineViewProps) {
  const engine = useTimelineStore((state) => state.engine)
  const draftTimeline = useTimelineStore((state) => state.draftTimeline)
  const timeline = draftTimeline ?? engine?.history.present ?? null
  const view = useTimelineStore((state) => state.view)
  const recording = useTimelineStore((state) => state.recording)
  const project = useTimelineStore((state) => state.project)
  const assetPaths = useTimelineStore((state) => state.assetPaths)
  const metadata = useTimelineStore((state) => state.metadata)
  const cursorTelemetry = useTimelineStore((state) => state.cursorTelemetry)
  const cursorEngine = useTimelineStore((state) => state.cursorEngine)
  const activeJob = useTimelineStore((state) => state.activeJob)
  const cursorClickSourceTimesMs = useMemo(() => {
    if (!cursorTelemetry) return []
    return cursorTelemetry.events.filter(isCursorClickEdge).map((event) => event.tMs)
  }, [cursorTelemetry])
  const isLoading = useTimelineStore((state) => state.isLoading)
  const error = useTimelineStore((state) => state.error)
  const draftError = useTimelineStore((state) => state.draftError)
  const load = useTimelineStore((state) => state.load)
  const execute = useTimelineStore((state) => state.execute)
  const undo = useTimelineStore((state) => state.undo)
  const redo = useTimelineStore((state) => state.redo)
  const save = useTimelineStore((state) => state.save)
  const play = useTimelineStore((state) => state.play)
  const pause = useTimelineStore((state) => state.pause)
  const togglePlay = useTimelineStore((state) => state.togglePlay)
  const seek = useTimelineStore((state) => state.seek)
  const setPlaybackRate = useTimelineStore((state) => state.setPlaybackRate)
  const setZoom = useTimelineStore((state) => state.setZoom)
  const setScroll = useTimelineStore((state) => state.setScroll)
  const setSnapEnabled = useTimelineStore((state) => state.setSnapEnabled)
  const setSnapThreshold = useTimelineStore((state) => state.setSnapThreshold)
  const toggleTrackCollapsed = useTimelineStore((state) => state.toggleTrackCollapsed)
  const setTrackHeight = useTimelineStore((state) => state.setTrackHeight)
  const setSelection = useTimelineStore((state) => state.setSelection)
  const clearError = useTimelineStore((state) => state.clearError)
  const missingAssets = useEditorStore((state) => state.missingAssets)
  const { toast } = useToast()

  const videoRef = useRef<HTMLVideoElement>(null)
  const monitorRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const [videoBounds, setVideoBounds] = useState<VideoBounds | null>(null)
  const [tool, setTool] = useState<TimelineTool>("select")
  const [useOriginalMedia, setUseOriginalMedia] = useState(false)
  const [mediaError, setMediaError] = useState(false)
  const [thumbnailSpriteError, setThumbnailSpriteError] = useState(false)

  const [timelineHeight, setTimelineHeight] = useResizableDimension({
    defaultValue: 340,
    min: 180,
    max: 560,
    storageKey: "recordforge:editor:timelineHeight",
  })

  const interaction = useTimelineInteraction()
  const overlayInteraction = useOverlayInteraction({
    canvasRef,
    canvasWidth: timeline?.canvas.width ?? 1,
    canvasHeight: timeline?.canvas.height ?? 1,
  })

  const selectedClip = useMemo<SelectedClip | null>(() => {
    const selection = view.selection
    if (!timeline || !selection || selection.kind !== "clip") return null
    for (const track of timeline.tracks) {
      const clip = track.clips.find((candidate) => candidate.id === selection.primaryClipId)
      if (clip) return { clip, track }
    }
    return null
  }, [timeline, view.selection])

  const selectedOverlayClip =
    selectedClip && isOverlayClip(selectedClip.clip) ? selectedClip.clip : null

  const selectedMarker = useMemo<TimelineMarker | null>(() => {
    const selection = view.selection
    if (!timeline || !selection || selection.kind !== "marker") return null
    return timeline.markers.find((marker) => marker.id === selection.markerId) ?? null
  }, [timeline, view.selection])

  useEffect(() => {
    if (view.selection?.kind === "clip" && !selectedClip) setSelection(null)
    if (view.selection?.kind === "marker" && !selectedMarker) setSelection(null)
  }, [selectedClip, selectedMarker, setSelection, view.selection])

  useEffect(() => {
    setUseOriginalMedia(false)
    setMediaError(false)
    setThumbnailSpriteError(false)
  }, [recordingId])

  useEffect(() => {
    setThumbnailSpriteError(false)
  }, [activeJob?.id, activeJob?.outputs?.thumbnailManifestPath])

  const proxyPath = activeJob?.outputs?.proxyPath ?? null
  const originalPath = recording?.outputPath ?? null
  const isUsingProxy = Boolean(proxyPath && !useOriginalMedia)
  const isPreparing = isPreparingJob(activeJob)
  const isPreparationFailed = isFailedPreparationJob(activeJob)
  const mediaPath = isUsingProxy ? proxyPath : originalPath
  const mediaUrl = useMemo(
    () => toAssetUrl(mediaPath, recording?.workDir),
    [mediaPath, recording?.workDir],
  )
  const composition = useMemo(
    () =>
      timeline ? resolvePreviewComposition(timeline, view.playheadMs, { cursorEngine }) : null,
    [cursorEngine, timeline, view.playheadMs],
  )

  const zoomTransformStyle = useMemo(
    () =>
      composition?.screen.zoomTransform
        ? zoomTransformToCss(
            composition.screen.zoomTransform,
            timeline?.canvas ?? { width: 1, height: 1 },
          )
        : undefined,
    [composition, timeline?.canvas],
  )
  const selectedZoomSegment = useMemo(() => {
    if (!view.selection || view.selection.kind !== "zoom" || !timeline) return null
    const zoomSelection = view.selection
    return (timeline.zoomSegments ?? []).find((s) => s.id === zoomSelection.segmentId) ?? null
  }, [view.selection, timeline])
  const cursorPointAtPlayhead = useMemo(() => {
    if (composition?.cursor.sourcePoint) {
      return composition.cursor.sourcePoint
    }
    return getCursorPointAtTimelineTime(timeline, view.playheadMs, cursorTelemetry, cursorEngine)
  }, [composition?.cursor.sourcePoint, timeline, view.playheadMs, cursorTelemetry, cursorEngine])
  const cursorClickTimesMs = useMemo(() => {
    if (!timeline) return []
    const screenAssetId = timeline.tracks.find((track) => track.kind === "screen")?.clips[0]
      ?.assetId
    if (!screenAssetId) return []
    return cursorClickSourceTimesMs.flatMap((sourceTimeMs) => {
      const mapped = sourceToTimelineForTrack(timeline, "screen", screenAssetId, sourceTimeMs)
      return mapped ? [mapped.timelineMs] : []
    })
  }, [cursorClickSourceTimesMs, timeline])
  const audioTrackOutputs = activeJob?.outputs?.audioTracks ?? []
  const cameraVideoOutputs: MediaVideoTrackOutput[] = activeJob?.outputs?.videoTracks ?? []
  const cameraClips = useMemo(
    () =>
      timeline?.tracks
        .filter((track) => track.kind === "camera" && !track.muted)
        .flatMap((track) =>
          track.clips.filter(
            (clip): clip is Extract<TimelineClip, { kind: "camera" }> => clip.kind === "camera",
          ),
        ) ?? [],
    [timeline],
  )
  const maskClips = useMemo(
    () =>
      timeline?.tracks
        .filter((track) => track.kind === "effects" && !track.muted)
        .flatMap((track) => track.clips.filter((clip): clip is MaskClip => clip.kind === "mask")) ??
      [],
    [timeline],
  )
  const captionClips = useMemo(
    () =>
      timeline?.tracks
        .filter((track) => track.kind === "captions" && !track.muted)
        .flatMap((track) =>
          track.clips.filter(
            (clip): clip is Extract<TimelineClip, { kind: "caption" }> => clip.kind === "caption",
          ),
        ) ?? [],
    [timeline],
  )
  const annotationClips = useMemo(
    () =>
      timeline?.tracks
        .filter((track) => !track.muted)
        .flatMap((track) =>
          track.clips.filter((clip): clip is AnnotationClip => clip.kind === "annotation"),
        ) ?? [],
    [timeline],
  )
  const textClips = useMemo(
    () =>
      timeline?.tracks
        .filter((track) => !track.muted)
        .flatMap((track) => track.clips.filter((clip): clip is TextClip => clip.kind === "text")) ??
      [],
    [timeline],
  )
  const imageClips = useMemo(
    () =>
      timeline?.tracks
        .filter((track) => !track.muted)
        .flatMap((track) =>
          track.clips.filter((clip): clip is ImageClip => clip.kind === "image"),
        ) ?? [],
    [timeline],
  )
  const overlayRenderPlan = useMemo(
    () => (timeline ? buildOverlayRenderPlan(timeline, project?.assets) : null),
    [project?.assets, timeline],
  )
  const overlayAssetUrls = useMemo(
    () =>
      Object.fromEntries(
        (project?.assets ?? [])
          .filter(
            (asset) =>
              (asset.kind === "image" || asset.role === "graphic") && asset.status !== "missing",
          )
          .flatMap((asset) => {
            const rawPath = assetPaths[asset.id] ?? asset.path
            const url = toAssetUrl(rawPath, recording?.workDir)
            return url ? [[asset.id, url] as const] : []
          }),
      ),
    [assetPaths, project?.assets, recording?.workDir],
  )
  const isPreviewMuted =
    audioTrackOutputs.length > 0 || (timeline ? isTimelineAudioMuted(timeline) : false)
  const retryThumbnail = useCallback(() => {
    setThumbnailSpriteError(false)
    thumbnailResource.retry()
  }, [thumbnailResource.retry])

  const isSideBySideAtPlayhead = useMemo(() => {
    return cameraClips.some(
      (clip) =>
        clip.transform.preset === "side-by-side" &&
        clip.transform.visible !== false &&
        view.playheadMs >= clip.startMs &&
        view.playheadMs < clip.startMs + clip.durationMs,
    )
  }, [cameraClips, view.playheadMs])

  const updateVideoBounds = useCallback(() => {
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas) {
      setVideoBounds(null)
      return
    }

    const canvasRect = canvas.getBoundingClientRect()
    const canvasWidth = canvas.clientWidth
    const canvasHeight = canvas.clientHeight
    if (canvasWidth <= 0 || canvasHeight <= 0) {
      setVideoBounds(null)
      return
    }

    const width = Math.max(1, timeline?.canvas.width ?? 1)
    const height = Math.max(1, timeline?.canvas.height ?? 1)
    const padding = timeline?.canvas.padding ?? 0

    const canvasScale = canvasWidth / width

    if (isSideBySideAtPlayhead) {
      const usableWidth = width - padding * 2
      const usableHeight = height - padding * 2
      const targetScreenWidth = Math.round(usableWidth * 0.76)
      const targetScreenHeight = Math.round((targetScreenWidth / width) * height)
      const sourceWidth = video && video.videoWidth > 0 ? video.videoWidth : width
      const sourceHeight = video && video.videoHeight > 0 ? video.videoHeight : height
      const screenScale = Math.min(
        (targetScreenWidth * canvasScale) / sourceWidth,
        (targetScreenHeight * canvasScale) / sourceHeight,
      )
      const screenWidth = sourceWidth * screenScale
      const screenHeight = sourceHeight * screenScale
      const screenLeft = padding * canvasScale + (targetScreenWidth * canvasScale - screenWidth) / 2
      const screenTop =
        (padding + (usableHeight - targetScreenHeight) / 2) * canvasScale +
        (targetScreenHeight * canvasScale - screenHeight) / 2

      const nextBounds = {
        left: screenLeft,
        top: screenTop,
        width: screenWidth,
        height: screenHeight,
        scale: canvasScale * (targetScreenWidth / width),
      }
      setVideoBounds((previous) => {
        if (
          previous &&
          previous.left === nextBounds.left &&
          previous.top === nextBounds.top &&
          previous.width === nextBounds.width &&
          previous.height === nextBounds.height &&
          previous.scale === nextBounds.scale
        ) {
          return previous
        }
        return nextBounds
      })
      return
    }

    const maxScreenWidth = Math.max(1, (width - padding * 2) * canvasScale)
    const maxScreenHeight = Math.max(1, (height - padding * 2) * canvasScale)
    const sourceWidth = video && video.videoWidth > 0 ? video.videoWidth : width
    const sourceHeight = video && video.videoHeight > 0 ? video.videoHeight : height
    const screenScale = Math.min(maxScreenWidth / sourceWidth, maxScreenHeight / sourceHeight)
    const screenWidth = sourceWidth * screenScale
    const screenHeight = sourceHeight * screenScale

    const nextBounds = {
      left: (canvasRect.width - screenWidth) / 2,
      top: (canvasRect.height - screenHeight) / 2,
      width: screenWidth,
      height: screenHeight,
      scale: canvasScale,
    }
    setVideoBounds((previous) => {
      if (
        previous &&
        previous.left === nextBounds.left &&
        previous.top === nextBounds.top &&
        previous.width === nextBounds.width &&
        previous.height === nextBounds.height &&
        previous.scale === nextBounds.scale
      ) {
        return previous
      }
      return nextBounds
    })
  }, [
    isSideBySideAtPlayhead,
    timeline?.canvas.width,
    timeline?.canvas.height,
    timeline?.canvas.padding,
  ])

  const canvasStyle = useMemo<React.CSSProperties>(() => {
    if (!timeline) return {}
    const width = Math.max(1, timeline.canvas.width)
    const height = Math.max(1, timeline.canvas.height)
    return {
      width: `min(100cqw, calc(100cqh * ${width / height}))`,
      aspectRatio: `${width} / ${height}`,
    }
  }, [timeline?.canvas.width, timeline?.canvas.height])

  const preRenderedBackground = usePreRenderedBackground(timeline?.canvas, view.previewQuality)

  const backgroundLayerStyle = useMemo(() => {
    if (!timeline) return { filter: undefined, transform: undefined, overlayOpacity: undefined }
    if (preRenderedBackground.isPreRendered) {
      return {
        filter: preRenderedBackground.filter,
        transform: preRenderedBackground.transform,
        overlayOpacity: preRenderedBackground.overlayOpacity,
      }
    }
    return computeBackgroundImageLayerStyle(
      timeline.canvas.backgroundBlur,
      timeline.canvas.backgroundDim,
    )
  }, [timeline, preRenderedBackground])

  const screenStyle = useMemo<React.CSSProperties>(() => {
    if (!timeline || !videoBounds) {
      return { position: "absolute", inset: 0, overflow: "hidden" }
    }

    const shadow =
      view.previewQuality === "power"
        ? undefined
        : canvasShadowStyle(timeline.canvas, videoBounds.scale)

    return {
      position: "absolute",
      left: videoBounds.left,
      top: videoBounds.top,
      width: videoBounds.width,
      height: videoBounds.height,
      borderRadius: timeline.canvas.borderRadius * videoBounds.scale,
      boxShadow: shadow,
      overflow: "hidden",
    }
  }, [videoBounds, timeline?.canvas, view.previewQuality])

  const handleClockBoundary = useCallback(
    (boundary: PlaybackBoundary) => {
      if (boundary.kind === "end") {
        pause()
        seek(boundary.timelineMs)
      } else {
        seek(boundary.timelineMs)
      }
    },
    [pause, seek],
  )

  usePlaybackClock({
    videoRef,
    timeline,
    previewQuality: view.previewQuality,
    mediaUrl,
    onSeek: seek,
    onPause: pause,
    onPlayNext: handleClockBoundary,
  })

  useEffect(() => {
    setVideoBounds(null)
  }, [mediaUrl])

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !mediaUrl) return
    const observer = new ResizeObserver(updateVideoBounds)
    observer.observe(canvas)
    updateVideoBounds()
    return () => observer.disconnect()
  }, [mediaUrl, updateVideoBounds])

  const frameMs = Math.max(1, Math.round(1000 / Math.max(1, timeline?.canvas.fps ?? 30)))

  function stepFrame(direction: -1 | 1) {
    seek(Math.max(0, Math.min(view.durationMs, view.playheadMs + direction * frameMs)))
  }

  function zoomToFit() {
    setZoom(0)
    setScroll(0)
  }

  const handleTimelineKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null
      if (target?.closest("input, textarea, select, button")) return
      const key = event.key.toLowerCase()
      const hasModifier = event.ctrlKey || event.metaKey

      if (event.code === "Space") {
        event.preventDefault()
        togglePlay()
      } else if (hasModifier && key === "z") {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      } else if (hasModifier && key === "y") {
        event.preventDefault()
        redo()
      } else if (hasModifier && key === "s") {
        event.preventDefault()
        void save()
      } else if (hasModifier && key === "d") {
        event.preventDefault()
        duplicateSelected()
      } else if (hasModifier && (key === "=" || key === "+")) {
        event.preventDefault()
        setZoom(Math.min(100, Math.round(view.zoom + 10)))
      } else if (hasModifier && (key === "-" || key === "_")) {
        event.preventDefault()
        setZoom(Math.max(0, Math.round(view.zoom - 10)))
      } else if (event.shiftKey && key === "z") {
        event.preventDefault()
        zoomToFit()
      } else if (key === "r" && selectedOverlayClip && !hasModifier) {
        event.preventDefault()
        if (overlayInteraction.isRotateMode) overlayInteraction.finishRotateMode()
        else overlayInteraction.startRotateMode(selectedOverlayClip.id)
      } else if (key === "escape") {
        event.preventDefault()
        overlayInteraction.cancel()
        if (view.selection) {
          setSelection(null)
        }
      } else if (key === "v") {
        setTool("select")
      } else if (key === "c") {
        setTool("split")
      } else if (key === "r") {
        setTool("range")
      } else if (key === "s") {
        event.preventDefault()
        splitSelected()
      } else if (key === "m") {
        event.preventDefault()
        addMarker()
      } else if (key === "z") {
        event.preventDefault()
        handleAddZoom()
      } else if (key === "j") {
        event.preventDefault()
        setPlaybackRate(0.5)
        play()
      } else if (key === "k") {
        event.preventDefault()
        pause()
      } else if (key === "l") {
        event.preventDefault()
        setPlaybackRate(1)
        play()
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault()
        deleteSelected(event.shiftKey)
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault()
        const direction = event.key === "ArrowLeft" ? -1 : 1
        if (selectedOverlayClip && overlayInteraction.isRotateMode) {
          overlayInteraction.rotateSelected(
            selectedOverlayClip.id,
            direction * (event.shiftKey ? 15 : 1),
          )
        } else if (selectedOverlayClip && hasModifier) {
          overlayInteraction.resizeSelected(
            selectedOverlayClip.id,
            event.key === "ArrowRight"
              ? event.shiftKey
                ? 10
                : 1
              : event.key === "ArrowLeft"
                ? event.shiftKey
                  ? -10
                  : -1
                : 0,
            0,
          )
        } else if (selectedOverlayClip) {
          overlayInteraction.nudgeSelected(
            selectedOverlayClip.id,
            direction * (event.shiftKey ? 10 : 1),
            0,
          )
        } else if (event.altKey && selectedClip) {
          trimSelected(
            event.shiftKey
              ? direction === -1
                ? "end"
                : "start"
              : direction === -1
                ? "start"
                : "end",
            direction * frameMs,
          )
        } else if (hasModifier && selectedClip) {
          nudgeSelected(direction * (event.shiftKey ? 1_000 : frameMs))
        } else {
          seek(view.playheadMs + direction * (event.shiftKey ? 1_000 : frameMs))
        }
      } else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && selectedOverlayClip) {
        event.preventDefault()
        if (overlayInteraction.isRotateMode) {
          overlayInteraction.rotateSelected(
            selectedOverlayClip.id,
            (event.key === "ArrowUp" ? -1 : 1) * (event.shiftKey ? 15 : 1),
          )
        } else if (hasModifier) {
          overlayInteraction.resizeSelected(
            selectedOverlayClip.id,
            0,
            event.key === "ArrowDown" ? (event.shiftKey ? 10 : 1) : event.shiftKey ? -10 : -1,
          )
        } else {
          overlayInteraction.nudgeSelected(
            selectedOverlayClip.id,
            0,
            event.key === "ArrowDown" ? (event.shiftKey ? 10 : 1) : event.shiftKey ? -10 : -1,
          )
        }
      } else if (event.key === "Home") {
        event.preventDefault()
        seek(0)
      } else if (event.key === "End") {
        event.preventDefault()
        seek(view.durationMs)
      }
    },
    [
      addMarker,
      deleteSelected,
      duplicateSelected,
      frameMs,
      nudgeSelected,
      overlayInteraction,
      pause,
      play,
      redo,
      save,
      seek,
      selectedClip,
      selectedOverlayClip,
      setPlaybackRate,
      splitSelected,
      togglePlay,
      trimSelected,
      undo,
      view.durationMs,
      view.playheadMs,
      zoomToFit,
    ],
  )

  function splitSelected() {
    if (!selectedClip || selectedClip.track.locked) {
      // If no clip is explicitly selected, attempt to split the top clip at playhead
      if (timeline) {
        for (const track of timeline.tracks) {
          if (track.locked) continue
          const clipAtPlayhead = track.clips.find(
            (c) => view.playheadMs > c.startMs && view.playheadMs < c.startMs + c.durationMs,
          )
          if (clipAtPlayhead) {
            execute(
              clipAtPlayhead.kind === "cursor-effect"
                ? createSplitCursorRangeCommand(clipAtPlayhead.id, view.playheadMs)
                : createSplitClipCommand(clipAtPlayhead.id, view.playheadMs),
            )
            return
          }
        }
      }
      return
    }
    if (selectedClip.clip.kind === "cursor-effect") {
      execute(createSplitCursorRangeCommand(selectedClip.clip.id, view.playheadMs))
      return
    }
    execute(createSplitClipCommand(selectedClip.clip.id, view.playheadMs))
  }

  function deleteSelected(ripple: boolean) {
    const selection = view.selection
    if (!selection) return
    if (selection.kind === "range") {
      execute(
        ripple
          ? createRippleDeleteRangeCommand(selection.startMs, selection.endMs)
          : createDeleteRangeCommand(selection.startMs, selection.endMs),
      )
      setSelection(null)
      return
    }
    if (selection.kind === "marker") {
      execute(createDeleteMarkerCommand(selection.markerId))
      setSelection(null)
      return
    }
    if (selection.kind === "zoom") {
      if (ripple && timeline) {
        const segment = getManualZoomSegments(timeline).find((s) => s.id === selection.segmentId)
        if (segment) {
          execute(createRippleDeleteClipCommand(segment.id))
          setSelection(null)
          return
        }
      }
      execute(createDeleteZoomSegmentCommand(selection.segmentId))
      setSelection(null)
      return
    }
    if (selection.kind !== "clip") return
    if (selection.clipIds.length > 1) {
      execute(
        ripple
          ? createRippleDeleteClipsCommand(selection.clipIds)
          : createDeleteClipsCommand(selection.clipIds),
      )
      setSelection(null)
      return
    }
    if (
      !selectedClip ||
      selectedClip.track.locked ||
      (selectedClip.clip.kind === "cursor-effect" && selectedClip.clip.locked)
    )
      return
    if (selectedClip.clip.kind === "cursor-effect" && !ripple) {
      execute(createDeleteCursorRangeCommand(selectedClip.clip.id))
      setSelection(null)
      return
    }
    execute(
      ripple
        ? createRippleDeleteClipCommand(selectedClip.clip.id)
        : createDeleteClipCommand(selectedClip.clip.id),
    )
    setSelection(null)
  }

  function nudgeSelected(deltaMs: number) {
    if (
      !selectedClip ||
      selectedClip.track.locked ||
      (selectedClip.clip.kind === "cursor-effect" && selectedClip.clip.locked)
    )
      return
    const selection = view.selection
    if (selection?.kind === "clip" && selection.clipIds.length > 1) {
      execute(
        createMoveClipsCommand(selection.clipIds, Math.round(deltaMs), {
          coalesceKey: `keyboard-move:${selection.clipIds.slice().sort().join(",")}`,
        }),
      )
      return
    }
    const nextStartMs = Math.max(0, Math.round(selectedClip.clip.startMs + deltaMs))
    execute(
      createMoveClipCommand(selectedClip.clip.id, nextStartMs, undefined, {
        coalesceKey: `keyboard-move:${selectedClip.clip.id}`,
      }),
    )
  }

  function trimSelected(edge: "start" | "end", deltaMs: number) {
    if (
      !selectedClip ||
      selectedClip.track.locked ||
      (selectedClip.clip.kind === "cursor-effect" && selectedClip.clip.locked)
    )
      return
    const { clip } = selectedClip
    const clipEndMs = clip.startMs + clip.durationMs
    if (clip.kind === "cursor-effect") {
      const nextStartMs =
        edge === "start"
          ? Math.max(0, Math.min(clipEndMs - 1, clip.startMs + deltaMs))
          : clip.startMs
      const nextEndMs = edge === "end" ? Math.max(clip.startMs + 1, clipEndMs + deltaMs) : clipEndMs
      execute(createResizeCursorRangeCommand(clip.id, { startMs: nextStartMs, endMs: nextEndMs }))
      return
    }
    if (edge === "start") {
      const nextStartMs = Math.max(0, Math.min(clipEndMs - 1, clip.startMs + deltaMs))
      const sourceInMs = Math.max(
        0,
        clip.sourceInMs + Math.round((nextStartMs - clip.startMs) * clip.speed),
      )
      if (sourceInMs >= clip.sourceOutMs) return
      execute(
        createTrimClipCommand(clip.id, sourceInMs, clip.sourceOutMs, { startMs: nextStartMs }),
      )
      return
    }
    const nextEndMs = Math.max(clip.startMs + 1, clipEndMs + deltaMs)
    const sourceDurationMs = Math.max(metadata?.durationMs ?? 0, clip.sourceOutMs)
    const sourceOutMs = Math.min(
      sourceDurationMs,
      clip.sourceInMs + Math.round((nextEndMs - clip.startMs) * clip.speed),
    )
    if (sourceOutMs <= clip.sourceInMs) return
    execute(createTrimClipCommand(clip.id, clip.sourceInMs, sourceOutMs))
  }

  function duplicateSelected() {
    const selection = view.selection
    if (selection?.kind === "clip" && selection.clipIds.length > 1) {
      execute(createDuplicateClipsCommand(selection.clipIds))
      return
    }
    if (
      !selectedClip ||
      selectedClip.track.locked ||
      (selectedClip.clip.kind === "cursor-effect" && selectedClip.clip.locked)
    )
      return
    execute(createDuplicateClipCommand(selectedClip.clip.id))
  }

  function duplicateClip(clip: TimelineClip) {
    const selection = view.selection
    if (
      selection?.kind === "clip" &&
      selection.clipIds.length > 1 &&
      selection.clipIds.includes(clip.id)
    ) {
      execute(createDuplicateClipsCommand(selection.clipIds))
      return
    }
    execute(createDuplicateClipCommand(clip.id))
  }

  function splitClip(clip: TimelineClip, splitTimeMs?: number) {
    const timeMs = splitTimeMs ?? view.playheadMs
    if (clip.kind === "cursor-effect") {
      execute(createSplitCursorRangeCommand(clip.id, timeMs))
      return
    }
    execute(createSplitClipCommand(clip.id, timeMs))
  }

  function splitAllAtPlayhead() {
    if (!timeline) return
    const clipsToSplit = timeline.tracks.flatMap((track) => {
      if (track.locked) return []
      return track.clips.filter(
        (c) => view.playheadMs > c.startMs + 1 && view.playheadMs < c.startMs + c.durationMs - 1,
      )
    })
    for (const clip of clipsToSplit) {
      if (clip.kind === "cursor-effect") {
        execute(createSplitCursorRangeCommand(clip.id, view.playheadMs))
      } else {
        execute(createSplitClipCommand(clip.id, view.playheadMs))
      }
    }
    const zoomTrack = timeline.tracks.find((t) => t.kind === "zoom")
    if (!zoomTrack?.locked) {
      const zoomToSplit = getManualZoomSegments(timeline).find(
        (s) =>
          !s.locked &&
          view.playheadMs > s.startMs + 1 &&
          view.playheadMs < s.startMs + s.durationMs - 1,
      )
      if (zoomToSplit) {
        execute(createSplitZoomSegmentCommand(zoomToSplit.id, view.playheadMs))
      }
    }
  }

  function deleteClip(clip: TimelineClip, ripple = false) {
    const selection = view.selection
    if (
      selection?.kind === "clip" &&
      selection.clipIds.length > 1 &&
      selection.clipIds.includes(clip.id)
    ) {
      execute(
        ripple
          ? createRippleDeleteClipsCommand(selection.clipIds)
          : createDeleteClipsCommand(selection.clipIds),
      )
      setSelection(null)
      return
    }
    execute(
      ripple
        ? createRippleDeleteClipCommand(clip.id)
        : createDeleteClipCommand(clip.id),
    )
    if (selection?.kind === "clip" && selection.primaryClipId === clip.id) {
      setSelection(null)
    }
  }

  function onCursorRangeAction(action: CursorRangeAction) {
    const range = findClip(timeline!, action.rangeId)?.clip
    if (!range || range.kind !== "cursor-effect") return
    if (range.locked && action.kind !== "toggle-lock") return

    if (action.kind === "toggle-enabled") {
      execute(createUpdateCursorRangeCommand(range.id, { enabled: !range.enabled }))
      return
    }

    if (action.kind === "toggle-lock") {
      execute(createUpdateCursorRangeCommand(range.id, { locked: !range.locked }))
      return
    }

    if (action.kind === "set-smoothing") {
      const smoothing: CursorSmoothing = action.smoothing ?? "smooth"
      execute(createUpdateCursorRangeCommand(range.id, { smoothing }))
    }
  }

  function findNearestClickTimeMs(timeMs: number): number | null {
    if (!cursorTelemetry || cursorClickSourceTimesMs.length === 0) return null
    let nearest = cursorClickSourceTimesMs[0]
    let nearestDistance = Math.abs(nearest - timeMs)
    for (const clickMs of cursorClickSourceTimesMs) {
      const distance = Math.abs(clickMs - timeMs)
      if (distance < nearestDistance) {
        nearest = clickMs
        nearestDistance = distance
      }
    }
    return nearest
  }

  function regenerateZoomFromClick(segment: ManualZoomSegment) {
    if (!cursorTelemetry || !timeline) return
    const clickTimeMs = findNearestClickTimeMs(segment.startMs + Math.floor(segment.durationMs / 2))
    if (clickTimeMs === null) return
    const lookup = findCursorEventAtTime(cursorTelemetry, clickTimeMs)
    if (!lookup) return
    const point = sourcePointToCanvas(cursorTelemetry, timeline.canvas, {
      x: lookup.event.sourceX,
      y: lookup.event.sourceY,
    })
    const targetScale = timeline.smartZoomSettings?.targetScale ?? 1.5
    const target = zoomTargetForCursorPoint(point, timeline.canvas, targetScale)
    execute(
      createUpdateZoomSegmentCommand(segment.id, {
        target,
        mode: "manual",
        source: "manual",
      }),
    )
  }

  function onZoomSegmentAction(action: ZoomSegmentAction) {
    if (!timeline) return
    const segment = getManualZoomSegments(timeline).find((s) => s.id === action.segmentId)
    if (!segment) return

    switch (action.kind) {
      case "toggle-lock":
        execute(createUpdateZoomSegmentCommand(segment.id, { locked: !segment.locked }))
        return
      case "split":
        if (segment.locked) return
        execute(
          createSplitZoomSegmentCommand(
            segment.id,
            segment.startMs + Math.floor(segment.durationMs / 2),
          ),
        )
        return
      case "delete":
        if (segment.locked) return
        execute(createDeleteZoomSegmentCommand(segment.id))
        if (view.selection?.kind === "zoom" && view.selection.segmentId === segment.id) {
          setSelection(null)
        }
        return
      case "ripple-delete":
        if (segment.locked) return
        execute(createRippleDeleteClipCommand(segment.id))
        if (view.selection?.kind === "zoom" && view.selection.segmentId === segment.id) {
          setSelection(null)
        }
        return
      case "regenerate-from-click":
        if (segment.locked) return
        regenerateZoomFromClick(segment)
        return
    }
  }

  function selectClip(clip: TimelineClip, track: TimelineTrack, event: React.MouseEvent) {
    if (tool === "split" && !track.locked && !(clip.kind === "cursor-effect" && clip.locked)) {
      if (view.playheadMs > clip.startMs && view.playheadMs < clip.startMs + clip.durationMs) {
        execute(
          clip.kind === "cursor-effect"
            ? createSplitCursorRangeCommand(clip.id, view.playheadMs)
            : createSplitClipCommand(clip.id, view.playheadMs),
        )
      }
      return
    }
    if (event.shiftKey && view.selection?.kind === "clip") {
      const current = findClip(timeline!, view.selection.primaryClipId)?.clip
      if (current) {
        setSelection({
          kind: "range",
          startMs: Math.min(current.startMs, clip.startMs),
          endMs: Math.max(current.startMs + current.durationMs, clip.startMs + clip.durationMs),
        })
        return
      }
    }
    if (event.ctrlKey || event.metaKey) {
      const current =
        view.selection?.kind === "clip"
          ? view.selection
          : { kind: "clip" as const, primaryClipId: clip.id, clipIds: [], trackId: track.id }
      const clipIds = current.clipIds.includes(clip.id)
        ? current.clipIds.filter((id) => id !== clip.id)
        : [...current.clipIds, clip.id]
      if (clipIds.length === 0) {
        setSelection(null)
        return
      }
      setSelection({
        kind: "clip",
        primaryClipId: clip.id,
        clipIds,
        trackId: track.id,
      })
      return
    }
    setSelection({ kind: "clip", primaryClipId: clip.id, clipIds: [clip.id], trackId: track.id })
    if (event.button === 0) {
      seek(clip.startMs)
    }
  }

  function selectMultipleClips(clipIds: string[], primaryClipId: string, trackId: string) {
    setSelection({ kind: "clip", primaryClipId, clipIds, trackId })
  }

  function selectRange(startMs: number, endMs: number) {
    if (endMs <= startMs) return
    setSelection({ kind: "range", startMs: Math.round(startMs), endMs: Math.round(endMs) })
  }

  function selectMarker(marker: TimelineMarker) {
    setSelection({ kind: "marker", markerId: marker.id })
    seek(marker.timeMs)
  }

  function deleteMarker(markerId: string) {
    execute(createDeleteMarkerCommand(markerId))
    if (view.selection?.kind === "marker" && view.selection.markerId === markerId) {
      setSelection(null)
    }
  }

  function addAssetAtTime(assetId: string, timeMs: number) {
    if (!timeline || !project) return
    const asset = project.assets.find((candidate) => candidate.id === assetId)
    if (!asset || asset.status === "missing") return

    if (asset.kind === "audio") {
      const durationMs = assetDurationMs(asset, 30_000)
      const audioTrack = timeline.tracks.find(
        (track) => track.kind === "audio" && track.name.toLowerCase().includes("music"),
      )
      execute(
        createAddExternalAudioClipCommand(asset.id, Math.round(timeMs), durationMs, {
          sourceInMs: 0,
          sourceOutMs: durationMs,
          role: asset.role === "music" ? "music" : "other",
          trackId: audioTrack?.id,
          trackName: audioTrack?.name ?? "Audio Track",
        }),
      )
      return
    }

    if (asset.kind === "image") {
      const clip = createImageClipForAsset(asset, timeMs, timeline.canvas)
      const graphicsTrack = timeline.tracks.find((track) => track.kind === "graphics")
      if (execute(createAddImageClipCommand(clip, graphicsTrack?.id))) {
        setSelection({ kind: "clip", clipIds: [clip.id], primaryClipId: clip.id })
      }
    }
  }

  function addMarkerAtTime(timeMs: number) {
    const roundedTimeMs = Math.max(0, Math.round(timeMs))
    execute(createAddMarkerCommand(roundedTimeMs, `Marker ${(timeline?.markers.length ?? 0) + 1}`))
  }

  function cycleTrackHeight(track: TimelineTrack) {
    const currentHeight = view.trackHeights[track.id] ?? 56
    const nextHeight = currentHeight >= 88 ? 56 : currentHeight + 16
    setTrackHeight(track.id, nextHeight)
  }

  function addMarker() {
    addMarkerAtTime(view.playheadMs)
  }

  function addMask(mode: MaskClip["mode"]) {
    if (!timeline) return
    const screenAssetId = timeline.tracks.find((track) => track.kind === "screen")?.clips[0]
      ?.assetId
    if (!screenAssetId) return
    const selectedRange = view.selection?.kind === "range" ? view.selection : null
    const startMs = Math.round(selectedRange?.startMs ?? view.playheadMs)
    const endMs = Math.round(selectedRange?.endMs ?? Math.min(view.durationMs, startMs + 2_000))
    if (endMs <= startMs) return
    execute(
      createAddMaskClipCommand(screenAssetId, startMs, endMs, mode, {
        x: timeline.canvas.width * 0.3,
        y: timeline.canvas.height * 0.3,
        width: timeline.canvas.width * 0.4,
        height: timeline.canvas.height * 0.25,
      }),
    )
  }

  function selectMask(mask: MaskClip) {
    const track = timeline?.tracks.find((candidate) => candidate.kind === "effects")
    if (!track) return
    setSelection({ kind: "clip", primaryClipId: mask.id, clipIds: [mask.id], trackId: track.id })
  }

  function handleAddZoom(
    timeOrOptions?:
      | number
      | {
          timeMs?: number
          endMs?: number
          preset?: ZoomPreset
          scale?: number
          mode?: ManualZoomSegment["mode"]
        },
    maybeOptions?: {
      preset?: ZoomPreset
      scale?: number
      endMs?: number
      mode?: ManualZoomSegment["mode"]
    },
  ) {
    if (!timeline) return

    let timeMs: number | undefined
    let endMs: number | undefined
    let preset: ZoomPreset | undefined
    let scale: number | undefined
    let mode: ManualZoomSegment["mode"] | undefined

    if (typeof timeOrOptions === "number") {
      timeMs = timeOrOptions
      endMs = maybeOptions?.endMs
      preset = maybeOptions?.preset
      scale = maybeOptions?.scale
      mode = maybeOptions?.mode
    } else if (timeOrOptions) {
      timeMs = timeOrOptions.timeMs
      endMs = timeOrOptions.endMs
      preset = timeOrOptions.preset
      scale = timeOrOptions.scale
      mode = timeOrOptions.mode
    }

    const rangeSelection = view.selection?.kind === "range" ? view.selection : null
    const effectiveStartMs =
      timeMs !== undefined ? timeMs : rangeSelection ? rangeSelection.startMs : view.playheadMs
    const effectiveEndMs =
      endMs !== undefined
        ? endMs
        : rangeSelection && timeMs === undefined
          ? rangeSelection.endMs
          : undefined

    const cursorPoint = getCursorPointAtTimelineTime(
      timeline,
      effectiveStartMs,
      cursorTelemetry,
      cursorEngine,
    )

    const segment = buildSmartZoomSegment(timeline, cursorPoint, {
      startMs: effectiveStartMs,
      endMs: effectiveEndMs,
      preset,
      scale,
      mode,
    })

    const success = execute(
      createAddZoomSegmentCommand(
        segment.startMs,
        segment.startMs + segment.durationMs,
        segment.target,
        {
          segmentId: segment.id,
          scale: segment.scale,
          easing: segment.easing,
          transitionInMs: segment.transitionInMs,
          transitionOutMs: segment.transitionOutMs,
          mode: segment.mode,
          source: segment.source,
          preset: segment.preset,
          label: segment.label,
        },
      ),
    )

    if (success) {
      setSelection({ kind: "zoom", segmentId: segment.id })
      const durationSec = (segment.durationMs / 1000).toFixed(1)
      toast({
        title: `Added ${segment.scale.toFixed(1)}× Zoom`,
        description: `${segment.label ?? "Zoom segment"} (${durationSec}s) at ${formatTimelineTime(segment.startMs)}`,
      })
    }
  }

  if (isLoading) return <TimelineLoadingState />
  if (!timeline || !recording) {
    return (
      <EditorErrorState
        recordingId={recordingId}
        message={error ?? "No timeline was returned"}
        onRetry={() => void load(recordingId)}
      />
    )
  }

  const effectiveThumbnailResource = thumbnailSpriteError
    ? {
        status: "error" as const,
        message: "Thumbnail sprite unavailable",
        retry: retryThumbnail,
      }
    : thumbnailResource

  return (
    <div
      className="flex h-full min-h-160 flex-col overflow-hidden bg-background text-foreground select-none"
      onKeyDown={handleTimelineKeyDown}
    >
      {/* Top Section: Monitor Canvas Preview */}
      <div className="flex min-h-0 flex-1 border-b border-border">
        <div className="flex min-w-0 flex-1 flex-col bg-background p-4">
          {error ? (
            <div
              className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-1.5 text-xs text-foreground"
              role="alert"
            >
              <span className="flex min-w-0 items-center gap-2">
                <AlertCircle className="size-4 shrink-0 text-warning" aria-hidden />
                <span className="truncate">{error}</span>
              </span>
              <Button variant="ghost" size="sm" onClick={clearError}>
                Dismiss
              </Button>
            </div>
          ) : null}

          {draftError ? (
            <div
              className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-1.5 text-xs text-foreground"
              role="status"
            >
              <span className="flex min-w-0 items-center gap-2">
                <AlertCircle className="size-4 shrink-0 text-warning" aria-hidden />
                <span className="truncate">{draftError.message}</span>
              </span>
            </div>
          ) : null}

          {isPreparing ? (
            <div
              className="mb-2 space-y-1.5 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-foreground"
              role="status"
            >
              <div className="flex items-center justify-between gap-3">
                <span>Preparing the preview proxy in the background</span>
                <span className="shrink-0 font-mono text-subtle-foreground">
                  {Math.round((activeJob?.progress ?? 0) * 100)}%
                </span>
              </div>
              <Progress value={activeJob?.progress ?? 0} />
            </div>
          ) : null}

          {isPreparationFailed ? (
            <div
              className="mb-2 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-1.5 text-xs text-foreground"
              role="status"
            >
              <AlertCircle className="size-4 shrink-0 text-warning" aria-hidden />
              <span>Preview preparation failed; editing the original source.</span>
            </div>
          ) : null}

          <div
            ref={monitorRef}
            className="@container-size relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl border border-border bg-black p-2 shadow-e2"
          >
            <div
              ref={canvasRef}
              className="relative flex items-center justify-center overflow-visible"
              style={canvasStyle}
            >
              {/* Background Layer */}
              <div className="absolute inset-0 overflow-hidden pointer-events-none rounded-[inherit] z-0">
                {timeline?.canvas.backgroundFit === "contain" && !preRenderedBackground.isPreRendered ? (
                  <>
                    {/* Ambient blurred underlay */}
                    <div
                      className="absolute inset-0 scale-110"
                      style={{
                        background: preRenderedBackground.backgroundStyle,
                        backgroundSize: "cover",
                        backgroundPosition: "center",
                        backgroundRepeat: "no-repeat",
                        filter: "blur(24px) brightness(0.65)",
                      }}
                    />
                    {/* Main uncropped contain image */}
                    <div
                      className="relative size-full"
                      style={{
                        background: preRenderedBackground.backgroundStyle,
                        backgroundSize: "contain",
                        backgroundPosition: "center",
                        backgroundRepeat: "no-repeat",
                        filter: backgroundLayerStyle.filter,
                        transform: backgroundLayerStyle.transform,
                      }}
                    />
                  </>
                ) : (
                  <div
                    className="size-full"
                    style={{
                      background: preRenderedBackground.backgroundStyle,
                      backgroundSize:
                        timeline?.canvas.backgroundFit === "contain" ? "contain" : "cover",
                      backgroundPosition: "center",
                      backgroundRepeat: "no-repeat",
                      filter: backgroundLayerStyle.filter,
                      transform: backgroundLayerStyle.transform,
                    }}
                  />
                )}
                {backgroundLayerStyle.overlayOpacity !== undefined && (
                  <div
                    className="absolute inset-0 bg-black pointer-events-none"
                    style={{ opacity: backgroundLayerStyle.overlayOpacity }}
                  />
                )}
              </div>
              {mediaUrl && !mediaError ? (
                <div style={screenStyle} onClick={togglePlay}>
                  <video
                    key={mediaUrl}
                    ref={videoRef}
                    src={mediaUrl}
                    className="size-full object-contain cursor-pointer"
                    style={
                      zoomTransformStyle
                        ? {
                            transform: zoomTransformStyle,
                            transformOrigin: "0 0",
                          }
                        : undefined
                    }
                    muted={isPreviewMuted}
                    playsInline
                    onError={() => {
                      setVideoBounds(null)
                      if (isUsingProxy && originalPath) {
                        setUseOriginalMedia(true)
                        setMediaError(false)
                        return
                      }
                      setMediaError(true)
                    }}
                    onLoadedMetadata={() => {
                      updateVideoBounds()
                    }}
                    onLoadedData={() => {
                      setMediaError(false)
                      updateVideoBounds()
                    }}
                  />
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3 text-center">
                  <div className="flex size-16 items-center justify-center rounded-2xl bg-surface-dim text-primary/50">
                    <Monitor className="size-8" aria-hidden />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">
                      {mediaError ? "Preview unavailable" : "No preview source"}
                    </p>
                    <p className="mt-1 text-xs text-subtle-foreground">
                      {mediaError
                        ? "The recording source could not be loaded. Timeline edits remain available."
                        : "This recording does not have a playable media source yet."}
                    </p>
                  </div>
                </div>
              )}

              {mediaUrl && cameraClips.length > 0 ? (
                <CameraPreview
                  clips={cameraClips}
                  outputs={cameraVideoOutputs}
                  workDir={recording?.workDir}
                  playheadMs={view.playheadMs}
                  isPlaying={view.isPlaying}
                  playbackRate={view.playbackRate}
                  canvasWidth={timeline.canvas.width}
                  canvasHeight={timeline.canvas.height}
                  onSelectClip={(clipId) =>
                    setSelection({ kind: "clip", primaryClipId: clipId, clipIds: [clipId] })
                  }
                  onUpdateTransform={(clipId, transform, options) =>
                    interaction.updateClipTransform(clipId, transform, options)
                  }
                />
              ) : null}

              {mediaUrl && maskClips.length > 0 ? (
                <MaskPreview
                  clips={maskClips}
                  playheadMs={view.playheadMs}
                  canvasWidth={timeline.canvas.width}
                  canvasHeight={timeline.canvas.height}
                  videoElement={videoRef.current}
                  useShaderOptimization={view.previewQuality !== "quality"}
                  onSelectMask={selectMask}
                  onUpdateMask={(clipId, rect, options) =>
                    interaction.updateMaskRect(clipId, rect, options)
                  }
                />
              ) : null}

              {captionClips.length > 0 ? (
                <CaptionPreview
                  clips={captionClips}
                  playheadMs={view.playheadMs}
                  canvasHeight={timeline.canvas.height}
                />
              ) : null}

              {mediaUrl &&
              !mediaError &&
              videoBounds &&
              composition?.cursor.active &&
              composition.cursor.frame &&
              cursorTelemetry ? (
                <CustomCursorOverlay
                  frame={composition.cursor.frame}
                  cursorSettings={composition.cursor.settings}
                  telemetry={cursorTelemetry}
                  containerWidth={videoBounds.width}
                  containerHeight={videoBounds.height}
                  offsetX={videoBounds.left}
                  offsetY={videoBounds.top}
                  borderRadius={screenStyle.borderRadius as number | string | undefined}
                  zoomTransform={zoomTransformStyle}
                />
              ) : null}

              {mediaUrl && !mediaError && videoBounds && selectedZoomSegment ? (
                <ZoomCanvasOverlay
                  segment={selectedZoomSegment}
                  canvasWidth={timeline.canvas.width}
                  canvasHeight={timeline.canvas.height}
                  containerWidth={videoBounds.width}
                  containerHeight={videoBounds.height}
                  offsetX={videoBounds.left}
                  offsetY={videoBounds.top}
                  cursorPointAtPlayhead={cursorPointAtPlayhead}
                  onUpdateTarget={(target, options) =>
                    interaction.updateZoomTarget(selectedZoomSegment.id, { target }, options)
                  }
                  onUpdateSegment={(update, options) =>
                    interaction.updateZoomTarget(selectedZoomSegment.id, update, options)
                  }
                />
              ) : null}

              {overlayRenderPlan ? (
                <>
                  <OverlayCanvas
                    renderPlan={overlayRenderPlan}
                    canvasWidth={timeline.canvas.width}
                    canvasHeight={timeline.canvas.height}
                    assetUrls={overlayAssetUrls}
                    drawMode={drawMode}
                    drawType={drawType}
                    drawColor={drawColor}
                    onCreateClip={(clip) => {
                      const track = timeline.tracks.find(
                        (candidate) => candidate.kind === "annotations",
                      )
                      const ok = execute(createAddAnnotationClipCommand(clip, track?.id))
                      if (ok) {
                        setSelection({
                          kind: "clip",
                          clipIds: [clip.id],
                          primaryClipId: clip.id,
                        })
                      }
                    }}
                    className="z-35"
                  />
                  <OverlaySelectionLayer
                    clips={[...annotationClips, ...textClips, ...imageClips]}
                    canvasWidth={timeline.canvas.width}
                    canvasHeight={timeline.canvas.height}
                    selectedClipId={
                      view.selection?.kind === "clip" ? view.selection.primaryClipId : null
                    }
                    interaction={overlayInteraction}
                    drawMode={drawMode}
                    onSelectClip={(clip) =>
                      setSelection({
                        kind: "clip",
                        clipIds: [clip.id],
                        primaryClipId: clip.id,
                      })
                    }
                    className="z-40"
                  />
                </>
              ) : null}
            </div>

            <AudioTrackPreview
              tracks={timeline.tracks}
              outputs={audioTrackOutputs}
              playheadMs={view.playheadMs}
              isPlaying={view.isPlaying}
              playbackRate={view.playbackRate}
              assetPaths={assetPaths}
              workDir={recording?.workDir}
            />

            {/* Media status badge */}
            <div className="pointer-events-none absolute left-4 top-4 flex items-center gap-1.5 rounded-full border border-border/80 bg-background/80 px-2.5 py-1 text-[10px] text-muted-foreground backdrop-blur shadow-e1">
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  mediaUrl && !mediaError ? "bg-success" : "bg-warning",
                )}
              />
              <span className="font-medium tracking-wide">
                {mediaUrl && !mediaError
                  ? isUsingProxy
                    ? "PROXY PREVIEW"
                    : "ORIGINAL FALLBACK"
                  : "PREVIEW UNAVAILABLE"}
              </span>
            </div>
          </div>
        </div>
      </div>

      <ResizableHandle
        direction="vertical"
        value={timelineHeight}
        min={180}
        max={560}
        onChange={setTimelineHeight}
        className="bg-surface-dim hover:bg-primary/40 transition-colors"
      />

      {/* Bottom Section: Integrated Toolbar & Timeline Lanes */}
      <div className="flex shrink-0 flex-col bg-surface-dim" style={{ height: timelineHeight }}>
        <TimelineToolbar
          tool={tool}
          onSelectTool={setTool}
          snapEnabled={view.snapEnabled}
          snapThresholdMs={view.snapThresholdMs}
          onToggleSnap={(enabled) => setSnapEnabled(enabled)}
          onChangeSnapThreshold={(threshold) => setSnapThreshold(threshold)}
          playheadMs={view.playheadMs}
          durationMs={view.durationMs}
          isPlaying={view.isPlaying}
          playbackRate={view.playbackRate}
          zoom={view.zoom}
          canRippleDelete={Boolean(view.selection)}
          selectedRange={
            view.selection?.kind === "range"
              ? { startMs: view.selection.startMs, endMs: view.selection.endMs }
              : null
          }
          onTogglePlay={togglePlay}
          onSeek={seek}
          onStepFrame={stepFrame}
          onSetPlaybackRate={setPlaybackRate}
          onSetZoom={setZoom}
          onZoomToFit={zoomToFit}
          onAddMarker={addMarker}
          onAddMask={addMask}
          onAddZoom={handleAddZoom}
          onSplitAtPlayhead={splitSelected}
          onRippleDeleteSelected={() => deleteSelected(true)}
        />

        <TimelineLanes
          timeline={timeline}
          view={view}
          tool={tool}
          cursorClickTimesMs={cursorClickTimesMs}
          thumbnailResource={effectiveThumbnailResource}
          videoThumbnailResources={videoThumbnailResources}
          waveformResources={waveformResources}
          workDir={recording?.workDir}
          onSeek={seek}
          onPause={pause}
          onSetScroll={setScroll}
          onSetZoom={setZoom}
          onSelectClip={selectClip}
          onSelectMultipleClips={selectMultipleClips}
          onSelectRange={selectRange}
          onMoveClip={interaction.moveClip}
          onTrimClip={interaction.trimClip}
          onSelectMarker={selectMarker}
          onDeleteMarker={deleteMarker}
          onAddMarkerAtTime={addMarkerAtTime}
          onSelectZoom={(segmentId) => setSelection({ kind: "zoom", segmentId })}
          onAddZoomAtTime={handleAddZoom}
          onMoveZoomSegment={interaction.moveZoomSegment}
          onResizeZoomSegment={interaction.resizeZoomSegment}
          onDeleteSelection={deleteSelected}
          onDuplicateClip={duplicateClip}
          onSplitClip={splitClip}
          onDeleteClip={deleteClip}
          onAddAssetAtTime={addAssetAtTime}
          onCursorRangeAction={onCursorRangeAction}
          onZoomSegmentAction={onZoomSegmentAction}
          onSplitAllAtPlayhead={splitAllAtPlayhead}
          onDeselectAll={() => setSelection(null)}
          onToggleTrackMuted={(track) =>
            execute(createUpdateTrackCommand(track.id, { muted: !track.muted }))
          }
          onToggleTrackSolo={(track) =>
            execute(createUpdateTrackCommand(track.id, { solo: !track.solo }))
          }
          onToggleTrackLocked={(track) =>
            execute(createUpdateTrackCommand(track.id, { locked: !track.locked }))
          }
          onToggleTrackCollapsed={(track) => toggleTrackCollapsed(track.id)}
          onCycleTrackHeight={cycleTrackHeight}
          onSpriteError={() => setThumbnailSpriteError(true)}
        />
      </div>

      {missingAssets.length > 0 ? (
        <div
          className="absolute bottom-4 left-4 rounded-lg border border-destructive/30 bg-surface px-3 py-2 text-xs text-destructive shadow-e2"
          role="status"
        >
          <span className="font-medium">Export blocked:</span> relink missing assets before
          rendering.
        </div>
      ) : null}
    </div>
  )
}
