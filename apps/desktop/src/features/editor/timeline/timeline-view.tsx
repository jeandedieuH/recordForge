import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { convertFileSrc, invoke } from "@tauri-apps/api/core"
import {
  cursorTelemetryFileSchema,
  type MediaJob,
  type TimelineClip,
  type TimelineMarker,
  type TimelineTrack,
} from "@recordforge/contracts"
import {
  createAddMarkerCommand,
  createDeleteClipCommand,
  createDeleteClipsCommand,
  createDeleteMarkerCommand,
  createDeleteRangeCommand,
  createMoveClipCommand,
  createMoveClipsCommand,
  createRippleDeleteClipCommand,
  createRippleDeleteClipsCommand,
  createRippleDeleteRangeCommand,
  createSplitClipCommand,
  createTrimClipCommand,
  createUpdateTrackCommand,
  findClip,
  findNextTimelineClip,
  formatTime,
  sourceToTimelineForTrack,
  timelineToSourceForTrack,
} from "@recordforge/editor-core"
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
import { ClipInspector } from "./clip-inspector"
import { TimelineLanes, getVisibleTickInterval } from "./timeline-lanes"
import { CustomCursorOverlay } from "../cursor"

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
  const timeline = engine?.history.present ?? null
  const view = useTimelineStore((state) => state.view)
  const recording = useTimelineStore((state) => state.recording)
  const metadata = useTimelineStore((state) => state.metadata)
  const activeJob = useTimelineStore((state) => state.activeJob)
  const isLoading = useTimelineStore((state) => state.isLoading)
  const error = useTimelineStore((state) => state.error)
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

  const videoRef = useRef<HTMLVideoElement>(null)
  const monitorRef = useRef<HTMLDivElement>(null)
  const playbackClipIdRef = useRef<string | null>(null)
  const suppressPlayheadSyncRef = useRef(false)
  const [videoBounds, setVideoBounds] = useState<VideoBounds | null>(null)
  const [tool, setTool] = useState<"select" | "split">("select")
  const [cursorClickTimesMs, setCursorClickTimesMs] = useState<number[]>([])
  const [useOriginalMedia, setUseOriginalMedia] = useState(false)
  const [mediaError, setMediaError] = useState(false)
  const [thumbnailSpriteError, setThumbnailSpriteError] = useState(false)

  useEffect(() => {
    void load(recordingId)
  }, [load, recordingId])

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
  const selectedClipCount = view.selection?.kind === "clip" ? view.selection.clipIds.length : 0

  useEffect(() => {
    if (view.selection?.kind === "clip" && !selectedClip) setSelection(null)
    if (view.selection?.kind === "marker" && !selectedMarker) setSelection(null)
  }, [selectedClip, selectedMarker, setSelection, view.selection])

  useEffect(() => {
    setUseOriginalMedia(false)
    setMediaError(false)
    setThumbnailSpriteError(false)
    playbackClipIdRef.current = null
  }, [recordingId])

  useEffect(() => {
    let cancelled = false
    setCursorClickTimesMs([])

    async function loadCursorClickTimes() {
      try {
        const raw = isTauri()
          ? await invoke<unknown>("get_cursor_telemetry", { recordingId })
          : null
        const parsed = cursorTelemetryFileSchema.safeParse(raw)
        if (cancelled || !parsed.success) return
        setCursorClickTimesMs(
          parsed.data.events.filter((event) => event.clicked).map((event) => event.tMs),
        )
      } catch {
        if (!cancelled) setCursorClickTimesMs([])
      }
    }

    void loadCursorClickTimes()
    return () => {
      cancelled = true
    }
  }, [recording?.id, recordingId])

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
  const audioTrackOutputs = activeJob?.outputs?.audioTracks ?? []
  const isPreviewMuted =
    audioTrackOutputs.length > 0 || (timeline ? isTimelineAudioMuted(timeline) : false)
  const retryThumbnail = useCallback(() => {
    setThumbnailSpriteError(false)
    thumbnailResource.retry()
  }, [thumbnailResource.retry])
  const updateVideoBounds = useCallback(() => {
    const monitor = monitorRef.current
    const video = videoRef.current
    if (!monitor || !video) {
      setVideoBounds(null)
      return
    }

    const monitorRect = monitor.getBoundingClientRect()
    const videoRect = video.getBoundingClientRect()
    if (videoRect.width <= 0 || videoRect.height <= 0) {
      setVideoBounds(null)
      return
    }

    const nextBounds = {
      left: videoRect.left - monitorRect.left,
      top: videoRect.top - monitorRect.top,
      width: videoRect.width,
      height: videoRect.height,
    }
    setVideoBounds((previous) => {
      if (
        previous &&
        previous.left === nextBounds.left &&
        previous.top === nextBounds.top &&
        previous.width === nextBounds.width &&
        previous.height === nextBounds.height
      ) {
        return previous
      }
      return nextBounds
    })
  }, [])

  // The playhead is always timeline time. The media element is only a source
  // clock, so every seek and timeupdate crosses this shared mapping seam.
  const getPlaybackPosition = useCallback(
    (timelineMs: number) =>
      timeline ? timelineToSourceForTrack(timeline, "screen", timelineMs) : null,
    [timeline],
  )

  const syncVideoToTimeline = useCallback(
    (timelineMs: number): boolean => {
      const element = videoRef.current
      const position = getPlaybackPosition(timelineMs)
      if (!element || !position) {
        if (element) element.pause()
        playbackClipIdRef.current = null
        return false
      }

      playbackClipIdRef.current = position.clipId
      element.playbackRate = Math.max(0.25, Math.min(4, view.playbackRate * position.clip.speed))
      const sourceSeconds = position.sourceMs / 1000
      if (Math.abs(element.currentTime - sourceSeconds) > 0.08) {
        element.currentTime = sourceSeconds
      }
      return true
    },
    [getPlaybackPosition, view.playbackRate],
  )

  const startPlayback = useCallback(
    async (timelineMs: number) => {
      const element = videoRef.current
      if (!element) return

      let startMs = timelineMs
      if (!getPlaybackPosition(startMs)) {
        const next = timeline ? findNextTimelineClip(timeline, "screen", startMs) : null
        if (!next) {
          pause()
          return
        }
        startMs = next.startMs
        seek(startMs)
      }

      if (!syncVideoToTimeline(startMs)) {
        pause()
        return
      }
      try {
        await element.play()
      } catch {
        pause()
      }
    },
    [getPlaybackPosition, pause, seek, syncVideoToTimeline, timeline],
  )

  useEffect(() => {
    const element = videoRef.current
    if (!element) return
    if (view.isPlaying) {
      void startPlayback(view.playheadMs)
      return
    }
    element.pause()
  }, [startPlayback, view.isPlaying])

  useEffect(() => {
    if (suppressPlayheadSyncRef.current) {
      suppressPlayheadSyncRef.current = false
      return
    }
    syncVideoToTimeline(view.playheadMs)
  }, [syncVideoToTimeline, view.playheadMs])

  useEffect(() => {
    if (!view.isPlaying || getPlaybackPosition(view.playheadMs)) return
    void startPlayback(view.playheadMs)
  }, [getPlaybackPosition, startPlayback, view.isPlaying, view.playheadMs])

  useEffect(() => {
    setVideoBounds(null)
    playbackClipIdRef.current = null
  }, [mediaUrl])

  useEffect(() => {
    const monitor = monitorRef.current
    const video = videoRef.current
    if (!monitor || !video || !mediaUrl) return
    const observer = new ResizeObserver(updateVideoBounds)
    observer.observe(monitor)
    observer.observe(video)
    updateVideoBounds()
    return () => observer.disconnect()
  }, [mediaUrl, updateVideoBounds])

  const handleVideoTimeUpdate = useCallback(
    (sourceMs: number) => {
      if (!timeline) return
      const currentClip = playbackClipIdRef.current
        ? (findClip(timeline, playbackClipIdRef.current)?.clip ?? null)
        : null
      const screenAssetId =
        currentClip?.assetId ??
        timeline.tracks.find((track) => track.kind === "screen")?.clips[0]?.assetId ??
        recordingId
      if (currentClip && sourceMs >= currentClip.sourceOutMs - 40) {
        const next = findNextTimelineClip(
          timeline,
          "screen",
          currentClip.startMs + currentClip.durationMs + 1,
        )
        if (next) {
          playbackClipIdRef.current = next.id
          suppressPlayheadSyncRef.current = true
          seek(next.startMs)
          window.requestAnimationFrame(() => {
            syncVideoToTimeline(next.startMs)
            void startPlayback(next.startMs)
          })
        } else {
          pause()
          suppressPlayheadSyncRef.current = true
          seek(view.durationMs)
        }
        return
      }

      const preferred = playbackClipIdRef.current
      const mapped =
        sourceToTimelineForTrack(timeline, "screen", screenAssetId, sourceMs, {
          preferClipId: preferred ?? undefined,
        }) ?? sourceToTimelineForTrack(timeline, "screen", screenAssetId, sourceMs)
      if (!mapped) {
        pause()
        return
      }
      suppressPlayheadSyncRef.current = true
      seek(mapped.timelineMs)
    },
    [
      pause,
      recordingId,
      seek,
      startPlayback,
      syncVideoToTimeline,
      timeline,
      view.durationMs,
      view.playheadMs,
    ],
  )

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
    if (selection.clipIds.length > 1) {
      execute(
        ripple
          ? createRippleDeleteClipsCommand(selection.clipIds)
          : createDeleteClipsCommand(selection.clipIds),
      )
      setSelection(null)
      return
    }
    if (!selectedClip || selectedClip.track.locked) return
    execute(
      ripple
        ? createRippleDeleteClipCommand(selectedClip.clip.id)
        : createDeleteClipCommand(selectedClip.clip.id),
    )
    setSelection(null)
  }

  function nudgeSelected(deltaMs: number) {
    if (!selectedClip || selectedClip.track.locked) return
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
    if (!selectedClip || selectedClip.track.locked) return
    const { clip } = selectedClip
    const clipEndMs = clip.startMs + clip.durationMs
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

  function selectClip(clip: TimelineClip, track: TimelineTrack, event: React.MouseEvent) {
    if (tool === "split" && !track.locked) {
      if (view.playheadMs > clip.startMs && view.playheadMs < clip.startMs + clip.durationMs) {
        execute(createSplitClipCommand(clip.id, view.playheadMs))
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

  function moveClip(
    clip: TimelineClip,
    track: TimelineTrack,
    newStartMs: number,
    coalesceKey: string,
  ) {
    if (track.locked) return
    const selection = view.selection
    if (
      selection?.kind === "clip" &&
      selection.clipIds.length > 1 &&
      selection.clipIds.includes(clip.id)
    ) {
      execute(
        createMoveClipsCommand(selection.clipIds, Math.round(newStartMs - clip.startMs), {
          coalesceKey,
        }),
        { coalesceWindowMs: 60_000 },
      )
      return
    }
    execute(
      createMoveClipCommand(clip.id, Math.max(0, Math.round(newStartMs)), undefined, {
        coalesceKey,
      }),
      { coalesceWindowMs: 60_000 },
    )
  }

  function trimClip(
    clip: TimelineClip,
    track: TimelineTrack,
    edge: "start" | "end",
    edgeTimeMs: number,
    coalesceKey: string,
  ) {
    if (track.locked) return
    const clipEndMs = clip.startMs + clip.durationMs
    const nextEdgeMs = Math.round(edgeTimeMs)
    if (edge === "start") {
      const nextStartMs = Math.max(0, Math.min(clipEndMs - 1, nextEdgeMs))
      const sourceInMs = Math.max(
        0,
        clip.sourceInMs + Math.round((nextStartMs - clip.startMs) * clip.speed),
      )
      if (sourceInMs >= clip.sourceOutMs) return
      execute(
        createTrimClipCommand(clip.id, sourceInMs, clip.sourceOutMs, {
          startMs: nextStartMs,
          coalesceKey,
        }),
        { coalesceWindowMs: 60_000 },
      )
      return
    }
    const nextEndMs = Math.max(clip.startMs + 1, nextEdgeMs)
    const sourceDurationMs = Math.max(metadata?.durationMs ?? 0, clip.sourceOutMs)
    const sourceOutMs = Math.min(
      sourceDurationMs,
      clip.sourceInMs + Math.round((nextEndMs - clip.startMs) * clip.speed),
    )
    if (sourceOutMs <= clip.sourceInMs) return
    execute(createTrimClipCommand(clip.id, clip.sourceInMs, sourceOutMs, { coalesceKey }), {
      coalesceWindowMs: 60_000,
    })
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
            className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl border border-border bg-black p-3 shadow-e2"
          >
            {mediaUrl && !mediaError ? (
              <video
                key={mediaUrl}
                ref={videoRef}
                src={mediaUrl}
                className="max-h-full max-w-full rounded-lg object-contain"
                muted={isPreviewMuted}
                playsInline
                onClick={togglePlay}
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
                  syncVideoToTimeline(view.playheadMs)
                  if (view.isPlaying) void startPlayback(view.playheadMs)
                }}
                onLoadedData={() => {
                  setMediaError(false)
                  updateVideoBounds()
                }}
                onTimeUpdate={(event) =>
                  handleVideoTimeUpdate(event.currentTarget.currentTime * 1000)
                }
                onEnded={() => {
                  if (timeline && playbackClipIdRef.current) {
                    const clip = playbackClipIdRef.current
                      ? findClip(timeline, playbackClipIdRef.current)?.clip
                      : null
                    const next = clip
                      ? findNextTimelineClip(timeline, "screen", clip.startMs + clip.durationMs + 1)
                      : null
                    if (next) {
                      seek(next.startMs)
                      void startPlayback(next.startMs)
                      return
                    }
                  }
                  pause()
                  seek(view.durationMs)
                }}
              />
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

            {mediaUrl && !mediaError && videoBounds ? (
              <CustomCursorOverlay
                playheadMs={view.playheadMs}
                cursorSettings={timeline.canvas.cursorSettings}
                recordingId={recordingId}
                telemetryPath={
                  recording.workDir ? `${recording.workDir}/cursor_telemetry.json` : null
                }
                containerWidth={videoBounds.width}
                containerHeight={videoBounds.height}
                offsetX={videoBounds.left}
                offsetY={videoBounds.top}
                sourceWidth={recording.width ?? 1920}
                sourceHeight={recording.height ?? 1080}
              />
            ) : null}

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
          </div>
        </div>

        <ClipInspector
          clip={selectedClip?.clip ?? null}
          track={selectedClip?.track ?? null}
          marker={selectedMarker}
          metadata={metadata}
          selectedClipCount={selectedClipCount}
          onClear={() => setSelection(null)}
        />
      </div>

      <div className="flex h-80 shrink-0 flex-col bg-surface-dim">
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
          onMoveClip={moveClip}
          onTrimClip={trimClip}
          onSelectMarker={selectMarker}
          onDeleteSelection={deleteSelected}
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
