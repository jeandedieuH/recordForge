import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { convertFileSrc } from "@tauri-apps/api/core"
import {
  type CursorSmoothing,
  type ManualZoomSegment,
  type MaskClip,
  type MediaJob,
  type MediaVideoTrackOutput,
  type TimelineClip,
  type TimelineMarker,
  type TimelineTrack,
} from "@recordforge/contracts"
import {
  createAddMaskClipCommand,
  createAddMarkerCommand,
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
  formatTime,
} from "@recordforge/editor-core"
import {
  findCursorEventAtTime,
  isCursorClickEdge,
  sourcePointToCanvas,
  zoomTargetForCursorPoint,
} from "@recordforge/cursor-core"
import { isTimelineAudioMuted } from "@recordforge/media-core"
import {
  AlertCircle,
  CheckCircle2,
  Flag,
  Monitor,
  MousePointer2,
  Pause,
  Play,
  Scissors,
  ShieldAlert,
  SkipBack,
  SkipForward,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import {
  Button,
  EmptyState,
  IconButton,
  NativeSelect,
  Progress,
  Skeleton,
  Slider,
  cn,
} from "@recordforge/ui"
import { isTauri } from "../../../lib/settings"
import { useEditorStore } from "../../../stores/editor-store"
import { useTimelineStore } from "../../../stores/timeline-store"
import type {
  DerivativeResource,
  WaveformResources,
  ThumbnailManifest,
} from "../media/derivative-resources"
import { AudioTrackPreview } from "./audio-track-preview"
import { CaptionPreview } from "./caption-preview"
import { CameraPreview } from "./camera-preview"
import { MaskPreview } from "./mask-preview"
import {
  TimelineLanes,
  getVisibleTickInterval,
  type CursorRangeAction,
  type ZoomSegmentAction,
} from "./timeline-lanes"
import { useTimelineInteraction } from "./use-timeline-interaction"
import { usePlaybackClock } from "./use-playback-clock"
import { CustomCursorOverlay } from "../cursor"
import { ResizableHandle } from "../shell/resizable-handle"
import { useResizableDimension } from "../shell/use-resizable-dimension"

interface TimelineViewProps {
  recordingId: string
  thumbnailResource: DerivativeResource<ThumbnailManifest> & { retry: () => void }
  waveformResources: WaveformResources
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

function isPreparingJob(job: MediaJob | null): boolean {
  return job?.kind === "prepare" && (job.status === "pending" || job.status === "running")
}

function isFailedPreparationJob(job: MediaJob | null): boolean {
  return job?.kind === "prepare" && job.status === "failed"
}

function toAssetUrl(path: string | null): string | null {
  if (!path) return null
  return isTauri() ? convertFileSrc(path) : path
}

function TimelineLoadingState() {
  return (
    <div className="flex h-full min-h-160 flex-col gap-4 bg-background p-6">
      <div className="flex min-h-0 flex-1 gap-4">
        <div className="flex min-w-0 flex-1 flex-col items-center justify-center rounded-xl border border-border bg-surface-dim p-6">
          <Skeleton className="aspect-video w-full max-w-4xl rounded-xl" />
          <Skeleton className="mt-5 h-10 w-72 rounded-xl" />
        </div>
        <Skeleton className="hidden w-80 shrink-0 rounded-xl lg:block" />
      </div>
      <Skeleton className="h-72 rounded-xl" />
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
  waveformResources,
}: TimelineViewProps) {
  const engine = useTimelineStore((state) => state.engine)
  const draftTimeline = useTimelineStore((state) => state.draftTimeline)
  const timeline = draftTimeline ?? engine?.history.present ?? null
  const view = useTimelineStore((state) => state.view)
  const recording = useTimelineStore((state) => state.recording)
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
  const setPreviewQuality = useTimelineStore((state) => state.setPreviewQuality)
  const setSelection = useTimelineStore((state) => state.setSelection)
  const clearError = useTimelineStore((state) => state.clearError)
  const missingAssets = useEditorStore((state) => state.missingAssets)

  const videoRef = useRef<HTMLVideoElement>(null)
  const monitorRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const [videoBounds, setVideoBounds] = useState<VideoBounds | null>(null)
  const [tool, setTool] = useState<"select" | "split">("select")
  const [useOriginalMedia, setUseOriginalMedia] = useState(false)
  const [mediaError, setMediaError] = useState(false)
  const [thumbnailSpriteError, setThumbnailSpriteError] = useState(false)

  const [timelineHeight, setTimelineHeight] = useResizableDimension({
    defaultValue: 320,
    min: 160,
    max: 520,
    storageKey: "recordforge:editor:timelineHeight",
  })

  // Phase 2: pointer/keyboard editing gestures use draft/commit/cancel semantics.
  const interaction = useTimelineInteraction()

  // Phase 1: project loading is owned by EditorSession, not by the timeline view.
  // The view uses the already-loaded session state.

  const selectedClip = useMemo<SelectedClip | null>(() => {
    const selection = view.selection
    if (!timeline || !selection || selection.kind !== "clip") return null
    for (const track of timeline.tracks) {
      const clip = track.clips.find((candidate) => candidate.id === selection.primaryClipId)
      if (clip) return { clip, track }
    }
    return null
  }, [timeline, view.selection])

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
  const mediaUrl = useMemo(() => toAssetUrl(mediaPath), [mediaPath])
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
  const isPreviewMuted =
    audioTrackOutputs.length > 0 || (timeline ? isTimelineAudioMuted(timeline) : false)
  const retryThumbnail = useCallback(() => {
    setThumbnailSpriteError(false)
    thumbnailResource.retry()
  }, [thumbnailResource.retry])
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

    // The canvas wrapper is the produced background screen. Padding insets the
    // recorded video screen from that background. Scale using the full canvas
    // so the padding stays proportional as the preview is resized.
    const canvasScale = canvasWidth / width

    // The recorded video screen is the largest video-aspect rectangle that still
    // fits inside the padded area. This avoids double-letterboxing (green bars
    // inside the video screen) and keeps the green background only around it.
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
  }, [timeline?.canvas.width, timeline?.canvas.height, timeline?.canvas.padding])

  const canvasStyle = useMemo<React.CSSProperties>(() => {
    if (!timeline) return {}
    const width = Math.max(1, timeline.canvas.width)
    const height = Math.max(1, timeline.canvas.height)
    return {
      // Fit the background screen inside the monitor while preserving its aspect ratio.
      width: `min(100cqw, calc(100cqh * ${width / height}))`,
      aspectRatio: `${width} / ${height}`,
      backgroundColor: timeline.canvas.background,
    }
  }, [timeline?.canvas.width, timeline?.canvas.height, timeline?.canvas.background])

  const screenStyle = useMemo<React.CSSProperties>(() => {
    if (!timeline || !videoBounds) {
      return { position: "absolute", inset: 0, overflow: "hidden" }
    }

    return {
      position: "absolute",
      left: videoBounds.left,
      top: videoBounds.top,
      width: videoBounds.width,
      height: videoBounds.height,
      // Corners and shadow belong to the recorded video screen, not the background.
      borderRadius: timeline.canvas.borderRadius * videoBounds.scale,
      boxShadow: canvasShadowStyle(timeline.canvas, videoBounds.scale),
      overflow: "hidden",
    }
  }, [videoBounds, timeline?.canvas])

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
    playheadMs: view.playheadMs,
    isPlaying: view.isPlaying,
    playbackRate: view.playbackRate,
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

  const handleTimelineKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null
      if (target?.closest("input, textarea, select, button")) return
      const key = event.key.toLowerCase()
      const frameMs = Math.max(1, Math.round(1000 / Math.max(1, timeline?.canvas.fps ?? 30)))
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
      } else if (key === "s") {
        event.preventDefault()
        splitSelected()
      } else if (key === "m") {
        event.preventDefault()
        addMarker()
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
        if (event.altKey && selectedClip) {
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
      nudgeSelected,
      pause,
      play,
      redo,
      save,
      seek,
      selectedClip,
      setPlaybackRate,
      splitSelected,
      timeline?.canvas.fps,
      togglePlay,
      trimSelected,
      undo,
      view.durationMs,
      view.playheadMs,
    ],
  )

  function splitSelected() {
    if (!selectedClip || selectedClip.track.locked) return
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

  function splitClip(clip: TimelineClip) {
    if (clip.kind === "cursor-effect") {
      execute(createSplitCursorRangeCommand(clip.id, view.playheadMs))
      return
    }
    execute(createSplitClipCommand(clip.id, view.playheadMs))
  }

  function deleteClip(clip: TimelineClip) {
    const selection = view.selection
    if (
      selection?.kind === "clip" &&
      selection.clipIds.length > 1 &&
      selection.clipIds.includes(clip.id)
    ) {
      execute(createDeleteClipsCommand(selection.clipIds))
      return
    }
    execute(createDeleteClipCommand(clip.id))
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
    seek(clip.startMs)
  }

  function selectRange(startMs: number, endMs: number) {
    if (endMs <= startMs) return
    setSelection({ kind: "range", startMs: Math.round(startMs), endMs: Math.round(endMs) })
  }

  function selectMarker(marker: TimelineMarker) {
    setSelection({ kind: "marker", markerId: marker.id })
    seek(marker.timeMs)
  }

  function cycleTrackHeight(track: TimelineTrack) {
    const currentHeight = view.trackHeights[track.id] ?? 56
    const nextHeight = currentHeight >= 88 ? 56 : currentHeight + 16
    setTrackHeight(track.id, nextHeight)
  }

  function addMarker() {
    execute(
      createAddMarkerCommand(view.playheadMs, `Marker ${(timeline?.markers.length ?? 0) + 1}`),
    )
  }

  function addMask(mode: MaskClip["mode"]) {
    if (!timeline) return
    const screenAssetId = timeline.tracks.find((track) => track.kind === "screen")?.clips[0]
      ?.assetId
    if (!screenAssetId) return
    const selectedRange = view.selection?.kind === "range" ? view.selection : null
    // playheadMs and selection bounds can be fractional (video currentTime / mouse input).
    // The project schema requires integer millisecond fields, so round before creating the clip.
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

  function adjustZoom(delta: number) {
    setZoom(Math.max(10, Math.min(200, view.zoom + delta)))
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

  const pixelsPerMs = Math.max(0.0004 * view.zoom, 0.01)
  const timelineWidth = Math.max(720, Math.ceil(view.durationMs * pixelsPerMs))
  const tickInterval = getVisibleTickInterval(pixelsPerMs)
  const isThumbnailError = thumbnailResource.status === "error" || thumbnailSpriteError
  const thumbnailStatus = isThumbnailError ? "error" : thumbnailResource.status
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
      <div className="flex min-h-0 flex-1 border-b border-border">
        <div className="flex min-w-0 flex-1 flex-col bg-background p-5">
          {error ? (
            <div
              className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground"
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
              className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground"
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
              className="mb-3 space-y-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-foreground"
              role="status"
            >
              <div className="flex items-center justify-between gap-3">
                <span>Preparing the preview proxy in the background</span>
                <span className="tnum shrink-0 font-mono text-subtle-foreground">
                  {Math.round((activeJob?.progress ?? 0) * 100)}%
                </span>
              </div>
              <Progress value={activeJob?.progress ?? 0} />
              <p className="text-subtle-foreground">
                The original source remains available while preparation runs.
              </p>
            </div>
          ) : null}

          {isPreparationFailed ? (
            <div
              className="mb-3 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground"
              role="status"
            >
              <AlertCircle className="size-4 shrink-0 text-warning" aria-hidden />
              <span>Preview preparation failed; editing the original source.</span>
            </div>
          ) : null}

          <div
            ref={monitorRef}
            className="@container-size relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl border border-border bg-black p-3 shadow-e2"
          >
            <div
              ref={canvasRef}
              className="relative flex items-center justify-center overflow-hidden"
              // Use the monitor as a size container so the canvas can be the
              // largest 16:9 box that still fits entirely inside the monitor,
              // avoiding the previous `w-full` + `max-h-full` issue that made
              // the preview stretch too wide when the monitor was wide and short.
              style={canvasStyle}
            >
              {mediaUrl && !mediaError ? (
                // The recorded video screen sits on top of the background and is
                // inset by the canvas padding. Its border radius, shadow, and
                // overflow are applied here so the video and cursor are clipped together.
                <div style={screenStyle} onClick={togglePlay}>
                  <video
                    key={mediaUrl}
                    ref={videoRef}
                    src={mediaUrl}
                    className="size-full object-contain"
                    style={
                      zoomTransformStyle
                        ? {
                            transform: zoomTransformStyle,
                            transformOrigin: "center",
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
                  playheadMs={view.playheadMs}
                  isPlaying={view.isPlaying}
                  playbackRate={view.playbackRate}
                  canvasWidth={timeline.canvas.width}
                  canvasHeight={timeline.canvas.height}
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
            </div>

            <AudioTrackPreview
              tracks={timeline.tracks}
              outputs={audioTrackOutputs}
              playheadMs={view.playheadMs}
              isPlaying={view.isPlaying}
              playbackRate={view.playbackRate}
            />

            <div className="pointer-events-none absolute left-5 top-5 flex items-center gap-1.5 rounded-full border border-border bg-background/80 px-2.5 py-1 text-[10px] text-muted-foreground backdrop-blur">
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  mediaUrl && !mediaError ? "bg-success" : "bg-warning",
                )}
              />
              <span>
                {mediaUrl && !mediaError
                  ? isUsingProxy
                    ? "PROXY PREVIEW"
                    : "ORIGINAL FALLBACK"
                  : "PREVIEW UNAVAILABLE"}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-3 pt-4">
            <IconButton label="Go to start" shortcut="Home" onClick={() => seek(0)}>
              <SkipBack />
            </IconButton>
            <Button
              size="icon"
              className="size-10 rounded-full shadow-e2"
              onClick={togglePlay}
              aria-label={view.isPlaying ? "Pause preview" : "Play preview"}
            >
              {view.isPlaying ? (
                <Pause data-icon="inline-start" />
              ) : (
                <Play data-icon="inline-start" />
              )}
            </Button>
            <IconButton label="Go to end" shortcut="End" onClick={() => seek(view.durationMs)}>
              <SkipForward />
            </IconButton>
            <div className="min-w-28 text-center font-mono text-xs font-semibold tabular-nums text-muted-foreground">
              {formatTime(view.playheadMs)} / {formatTime(view.durationMs)}
            </div>
            <NativeSelect
              aria-label="Playback speed"
              value={String(view.playbackRate)}
              onChange={(event) => setPlaybackRate(Number(event.target.value))}
              className="w-20"
            >
              {[0.25, 0.5, 1, 1.5, 2, 4].map((rate) => (
                <option key={rate} value={rate}>
                  {rate}×
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label="Preview quality"
              value={view.previewQuality}
              onChange={(event) =>
                setPreviewQuality(event.target.value as "quality" | "performance" | "power")
              }
              className="w-28"
            >
              <option value="quality">Quality</option>
              <option value="performance">Performance</option>
              <option value="power">Power saving</option>
            </NativeSelect>
          </div>
        </div>
      </div>

      <ResizableHandle
        direction="vertical"
        value={timelineHeight}
        min={160}
        max={520}
        onChange={setTimelineHeight}
        className="bg-surface-dim"
      />

      <div className="flex shrink-0 flex-col bg-surface-dim" style={{ height: timelineHeight }}>
        <div className="flex min-h-11 items-center justify-between gap-3 border-b border-border px-4 py-1.5">
          <div className="flex items-center gap-1">
            <div
              className="flex items-center gap-1 rounded-lg border border-border bg-surface p-1"
              role="toolbar"
              aria-label="Timeline tools"
            >
              <IconButton
                label="Selection tool"
                tooltipSide="top"
                className={cn("size-7", tool === "select" && "bg-overlay text-foreground")}
                onClick={() => setTool("select")}
              >
                <MousePointer2 />
              </IconButton>
              <IconButton
                label="Split tool"
                shortcut="S"
                tooltipSide="top"
                className={cn("size-7", tool === "split" && "bg-overlay text-foreground")}
                onClick={() => setTool("split")}
              >
                <Scissors />
              </IconButton>
            </div>
            <Button
              variant={view.snapEnabled ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={view.snapEnabled}
              onClick={() => setSnapEnabled(!view.snapEnabled)}
              title={view.snapEnabled ? "Disable timeline snapping" : "Enable timeline snapping"}
            >
              Snap {view.snapEnabled ? "on" : "off"}
            </Button>
            <NativeSelect
              aria-label="Snap threshold"
              value={String(view.snapThresholdMs)}
              onChange={(event) => setSnapThreshold(Number(event.target.value))}
              className="hidden w-24 md:block"
            >
              {[60, 120, 240, 480].map((thresholdMs) => (
                <option key={thresholdMs} value={thresholdMs}>
                  Snap {thresholdMs}ms
                </option>
              ))}
            </NativeSelect>
            <Button
              variant="ghost"
              size="sm"
              onClick={addMarker}
              title="Add a marker at the playhead"
            >
              <Flag data-icon="inline-start" />
              <span className="hidden md:inline">Add marker</span>
            </Button>
            <div
              className="hidden items-center gap-1 border-l border-border pl-2 md:flex"
              aria-label="Privacy masks"
            >
              <ShieldAlert className="size-3.5 text-warning" aria-hidden />
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => addMask("blur")}
              >
                Blur
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => addMask("pixelate")}
              >
                Pixelate
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => addMask("redact")}
              >
                Redact
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <DerivativeState label="Thumbnails" status={thumbnailStatus} onRetry={retryThumbnail} />
            <DerivativeState
              label="Waveform"
              status={waveformResources.status}
              onRetry={waveformResources.retry}
            />
            <div className="hidden items-center gap-1 border-l border-border pl-2 sm:flex">
              <IconButton
                label="Zoom out"
                tooltipSide="top"
                className="size-7"
                onClick={() => adjustZoom(-10)}
              >
                <ZoomOut />
              </IconButton>
              <Slider
                value={[view.zoom]}
                min={10}
                max={200}
                step={10}
                aria-label="Timeline zoom"
                className="w-24"
                onValueChange={(value) => setZoom(value[0] ?? view.zoom)}
              />
              <IconButton
                label="Zoom in"
                tooltipSide="top"
                className="size-7"
                onClick={() => adjustZoom(10)}
              >
                <ZoomIn />
              </IconButton>
              <span className="w-9 text-right font-mono text-[10px] tabular-nums text-subtle-foreground">
                {view.zoom}%
              </span>
            </div>
          </div>
        </div>

        <TimelineLanes
          timeline={timeline}
          view={view}
          timelineWidth={timelineWidth}
          pixelsPerMs={pixelsPerMs}
          tickInterval={tickInterval}
          cursorClickTimesMs={cursorClickTimesMs}
          thumbnailResource={effectiveThumbnailResource}
          waveformResources={waveformResources}
          onSeek={seek}
          onSetScroll={setScroll}
          onSelectClip={selectClip}
          onSelectRange={selectRange}
          onMoveClip={interaction.moveClip}
          onTrimClip={interaction.trimClip}
          onSelectMarker={selectMarker}
          onSelectZoom={(segmentId) => setSelection({ kind: "zoom", segmentId })}
          onMoveZoomSegment={interaction.moveZoomSegment}
          onResizeZoomSegment={interaction.resizeZoomSegment}
          onDeleteSelection={deleteSelected}
          onDuplicateClip={duplicateClip}
          onSplitClip={splitClip}
          onDeleteClip={deleteClip}
          onCursorRangeAction={onCursorRangeAction}
          onZoomSegmentAction={onZoomSegmentAction}
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

function DerivativeState({
  label,
  status,
  onRetry,
}: {
  label: string
  status: "loading" | "missing" | "content" | "error"
  onRetry: () => void
}) {
  if (status === "loading") {
    return (
      <Skeleton className="h-6 w-24 rounded-full" aria-label={`Loading ${label.toLowerCase()}`} />
    )
  }
  if (status === "error") {
    return (
      <Button variant="ghost" size="sm" className="h-6 text-[10px] text-warning" onClick={onRetry}>
        <AlertCircle data-icon="inline-start" />
        Retry {label.toLowerCase()}
      </Button>
    )
  }
  if (status === "missing") {
    return (
      <span className="text-[10px] text-subtle-foreground">
        No {label.toLowerCase()} derivative
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-1 text-[10px] text-success">
      <CheckCircle2 className="size-3" aria-hidden />
      {label} ready
    </span>
  )
}
