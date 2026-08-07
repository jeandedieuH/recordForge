import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { convertFileSrc } from "@tauri-apps/api/core"
import type { MediaJob, TimelineClip, TimelineTrack } from "@recordforge/contracts"
import {
  createDeleteClipCommand,
  createRippleDeleteClipCommand,
  createSplitClipCommand,
  createUpdateTrackCommand,
  formatTime,
  getRedoLabel,
  getUndoLabel,
} from "@recordforge/editor-core"
import { isTimelineAudioMuted } from "@recordforge/media-core"
import {
  AlertCircle,
  AudioLines,
  Lock,
  LockOpen,
  Monitor,
  MousePointer2,
  Pause,
  Play,
  Redo2,
  Scissors,
  SkipBack,
  SkipForward,
  Trash2,
  Undo2,
  Video,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import { Button, EmptyState, IconButton, Progress, Skeleton, Slider, cn } from "@recordforge/ui"
import { isTauri } from "../../../lib/settings"
import { useEditorStore, type SaveStatus } from "../../../stores/editor-store"
import { useTimelineStore } from "../../../stores/timeline-store"
import { AudioTrackPreview } from "./audio-track-preview"
import { ClipInspector } from "./clip-inspector"
import { CustomCursorOverlay } from "../cursor"

interface TimelineViewProps {
  recordingId: string
  onClose: () => void
  onOpenExport?: () => void
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

type TimelineTool = "select" | "split"

const TRACK_ROW_CLASS = "h-14 border-b border-border"
const TICK_INTERVALS = [1_000, 5_000, 10_000, 30_000, 60_000]
const TIMELINE_ZOOM_MIN = 10
const TIMELINE_ZOOM_MAX = 200
const TIMELINE_ZOOM_STEP = 10

function toAssetUrl(path: string | null): string | null {
  if (!path) return null
  return isTauri() ? convertFileSrc(path) : path
}

function getTickInterval(pixelsPerMs: number): number {
  const minimumSpacing = 72
  return (
    TICK_INTERVALS.find((interval) => interval * pixelsPerMs >= minimumSpacing) ??
    TICK_INTERVALS[TICK_INTERVALS.length - 1]
  )
}

function getTrackIcon(track: TimelineTrack) {
  if (track.kind === "screen") return Monitor
  if (track.kind === "camera") return Video
  return AudioLines
}

function getTrackAccent(track: TimelineTrack): string {
  if (track.kind === "screen") return "screen"
  if (track.kind === "camera") return "camera"
  if (track.name.toLowerCase().includes("system")) return "system"
  return "mic"
}

function getClipClass(track: TimelineTrack): string {
  const accent = getTrackAccent(track)
  return (
    {
      screen: "border-track-screen/70 bg-track-screen/20 hover:bg-track-screen/30",
      camera: "border-track-webcam/70 bg-track-webcam/20 hover:bg-track-webcam/30",
      mic: "border-track-mic/70 bg-track-mic/20 hover:bg-track-mic/30",
      system: "border-track-system/70 bg-track-system/20 hover:bg-track-system/30",
    }[accent] ?? "border-border bg-surface"
  )
}

function getClipLabel(clip: TimelineClip, track: TimelineTrack): string {
  if (clip.kind === "screen") return "Screen capture"
  if (clip.kind === "camera") return "Camera capture"
  if (clip.kind === "caption") return clip.text
  return track.name
}

function saveStatusText(status: SaveStatus): string {
  switch (status) {
    case "saving":
      return "Saving..."
    case "saved":
      return "Saved"
    case "error":
      return "Save failed"
    case "idle":
    default:
      return "Unsaved changes"
  }
}

function TimelineLoadingState() {
  return (
    <div className="flex h-full min-h-160 flex-col gap-4 bg-background p-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-6 w-52" />
        <Skeleton className="size-9" />
      </div>
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

export function TimelineView({ recordingId, onClose, onOpenExport }: TimelineViewProps) {
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
  const pause = useTimelineStore((state) => state.pause)
  const togglePlay = useTimelineStore((state) => state.togglePlay)
  const seek = useTimelineStore((state) => state.seek)
  const setZoom = useTimelineStore((state) => state.setZoom)
  const clearError = useTimelineStore((state) => state.clearError)
  const activeExportJob = useTimelineStore((state) => state.activeExportJob)
  const saveStatus = useEditorStore((state) => state.saveStatus)
  const saveError = useEditorStore((state) => state.saveError)
  const missingAssets = useEditorStore((state) => state.missingAssets)

  const videoRef = useRef<HTMLVideoElement>(null)
  const monitorRef = useRef<HTMLDivElement>(null)
  const [videoBounds, setVideoBounds] = useState<VideoBounds | null>(null)
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [tool, setTool] = useState<TimelineTool>("select")
  const [useOriginalMedia, setUseOriginalMedia] = useState(false)
  const [mediaError, setMediaError] = useState(false)
  const [waveformImageError, setWaveformImageError] = useState(false)

  // The monitor can letterbox the video, so cursor coordinates must use the
  // video's rendered box rather than the full monitor bounds.
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

  useEffect(() => {
    void load(recordingId)
  }, [load, recordingId])

  const selectedClip = useMemo<SelectedClip | null>(() => {
    if (!timeline || !selectedClipId) return null
    for (const track of timeline.tracks) {
      const clip = track.clips.find((candidate) => candidate.id === selectedClipId)
      if (clip) return { clip, track }
    }
    return null
  }, [selectedClipId, timeline])

  const firstClipId = timeline?.tracks.flatMap((track) => track.clips)[0]?.id ?? null
  useEffect(() => {
    if (!selectedClip || !selectedClipId) setSelectedClipId(firstClipId)
  }, [firstClipId, selectedClip, selectedClipId])

  useEffect(() => {
    setUseOriginalMedia(false)
    setMediaError(false)
  }, [recordingId])

  const proxyPath = activeJob?.outputs?.proxyPath ?? null
  useEffect(() => {
    if (proxyPath) setUseOriginalMedia(false)
    setMediaError(false)
  }, [proxyPath])
  const originalPath = recording?.outputPath ?? null
  const isUsingProxy = Boolean(proxyPath && !useOriginalMedia)
  const isPreparing = isPreparingJob(activeJob)
  const isPreparationFailed = isFailedPreparationJob(activeJob)
  const mediaPath = isUsingProxy ? proxyPath : originalPath
  const mediaUrl = useMemo(() => toAssetUrl(mediaPath), [mediaPath])

  useEffect(() => {
    setVideoBounds(null)
    if (!mediaUrl) return

    const monitor = monitorRef.current
    const video = videoRef.current
    if (!monitor || !video) return

    const observer = new ResizeObserver(updateVideoBounds)
    observer.observe(monitor)
    observer.observe(video)
    updateVideoBounds()
    return () => observer.disconnect()
  }, [mediaUrl, updateVideoBounds])

  const audioTrackOutputs = activeJob?.outputs?.audioTracks ?? []
  const waveformImagePath = activeJob?.outputs?.waveformImagePath ?? null
  const waveformImageUrl = useMemo(() => toAssetUrl(waveformImagePath), [waveformImagePath])
  const waveformUrl = waveformImageUrl && !waveformImageError ? waveformImageUrl : null
  const waveformUrlsByStream = useMemo(
    () =>
      new Map(
        audioTrackOutputs.map((output) => [
          output.streamIndex,
          toAssetUrl(output.waveformImagePath),
        ]),
      ),
    [audioTrackOutputs],
  )
  const waveformDurationMs = Math.max(
    metadata?.durationMs ?? recording?.durationMs ?? view.durationMs,
    1,
  )
  const hasStandaloneAudio = audioTrackOutputs.length > 0
  const isPreviewMuted = hasStandaloneAudio || (timeline ? isTimelineAudioMuted(timeline) : false)

  useEffect(() => {
    setWaveformImageError(false)
  }, [activeJob?.id, waveformImagePath])

  useEffect(() => {
    const element = videoRef.current
    if (!element) return
    if (view.isPlaying) {
      void element.play().catch(() => pause())
      return
    }
    element.pause()
  }, [pause, view.isPlaying])

  useEffect(() => {
    const element = videoRef.current
    if (!element || !Number.isFinite(view.playheadMs)) return
    const nextTime = view.playheadMs / 1000
    if (Math.abs(element.currentTime - nextTime) > 0.08) element.currentTime = nextTime
  }, [view.playheadMs])

  const pixelsPerMs = Math.max(0.0004 * view.zoom, 0.01)
  const timelineWidth = Math.max(720, Math.ceil(view.durationMs * pixelsPerMs))
  const tickInterval = getTickInterval(pixelsPerMs)
  const tickCount = Math.min(600, Math.ceil(view.durationMs / tickInterval) + 1)
  const undoLabel = engine ? getUndoLabel(engine) : null
  const redoLabel = engine ? getRedoLabel(engine) : null

  const splitSelected = useCallback(() => {
    if (!selectedClip || selectedClip.track.locked) return
    execute(createSplitClipCommand(selectedClip.clip.id, view.playheadMs))
  }, [execute, selectedClip, view.playheadMs])

  const deleteSelected = useCallback(
    (ripple: boolean) => {
      if (!selectedClip || selectedClip.track.locked) return
      execute(
        ripple
          ? createRippleDeleteClipCommand(selectedClip.clip.id)
          : createDeleteClipCommand(selectedClip.clip.id),
      )
      setSelectedClipId(null)
    },
    [execute, selectedClip],
  )

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (target?.closest("input, textarea, select, button")) return

      if (event.code === "Space") {
        event.preventDefault()
        togglePlay()
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault()
        redo()
      } else if (event.key.toLowerCase() === "s") {
        event.preventDefault()
        splitSelected()
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault()
        deleteSelected(selectedClip?.track.kind === "screen")
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [deleteSelected, redo, selectedClip, splitSelected, togglePlay, undo])

  function seekFromPointer(event: React.MouseEvent<HTMLElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    const scrollLeft = "scrollLeft" in event.currentTarget ? event.currentTarget.scrollLeft : 0
    const position = Math.max(0, event.clientX - bounds.left + scrollLeft)
    seek(position / pixelsPerMs)
  }

  function toggleTrackMuted(track: TimelineTrack) {
    execute(createUpdateTrackCommand(track.id, { muted: !track.muted }))
  }

  function toggleTrackLocked(track: TimelineTrack) {
    execute(createUpdateTrackCommand(track.id, { locked: !track.locked }))
  }

  function adjustZoom(delta: number) {
    setZoom(Math.max(TIMELINE_ZOOM_MIN, Math.min(TIMELINE_ZOOM_MAX, view.zoom + delta)))
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

  return (
    <div className="flex h-full min-h-160 flex-col overflow-hidden bg-background text-foreground select-none">
      {/* Upper Area: Video Preview Canvas + Inspector */}
      <div className="flex min-h-0 flex-1 border-b border-border">
        {/* Main Video Viewport & Transport */}
        <div className="flex min-w-0 flex-1 flex-col bg-background p-5">
          {/* Project header */}
          <div className="flex items-center justify-between gap-4 pb-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
                <Monitor className="size-4" aria-hidden />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-sm font-semibold text-foreground">{timeline.name}</h1>
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-subtle-foreground">
                  <span className="tnum font-mono">
                    {timeline.canvas.width}×{timeline.canvas.height}
                  </span>
                  <span>·</span>
                  <span className="tnum font-mono">{timeline.canvas.fps} fps</span>
                  <span>·</span>
                  <span className="tnum font-mono">{formatTime(view.durationMs)}</span>
                </div>
              </div>
              <span className="rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">
                {isUsingProxy ? "Proxy ready" : proxyPath ? "Original fallback" : "Original source"}
              </span>
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10px] font-medium",
                  saveStatus === "error"
                    ? "border-destructive/30 bg-destructive/10 text-destructive"
                    : saveStatus === "saved"
                      ? "border-success/30 bg-success/10 text-success"
                      : "border-warning/30 bg-warning/10 text-warning",
                )}
                title={saveError ?? saveStatusText(saveStatus)}
              >
                {saveStatusText(saveStatus)}
              </span>
              {missingAssets.length > 0 ? (
                <span
                  className="flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive"
                  title={`Missing assets: ${missingAssets.join(", ")}`}
                >
                  <AlertCircle className="size-3" />
                  {missingAssets.length} missing
                </span>
              ) : null}
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <IconButton
                label={undoLabel ? `Undo ${undoLabel}` : "Undo"}
                shortcut="Ctrl Z"
                disabled={!undoLabel}
                onClick={undo}
              >
                <Undo2 />
              </IconButton>
              <IconButton
                label={redoLabel ? `Redo ${redoLabel}` : "Redo"}
                shortcut="Ctrl Y"
                disabled={!redoLabel}
                onClick={redo}
              >
                <Redo2 />
              </IconButton>
              <div className="mx-2 h-5 w-px bg-border" />
              <IconButton label="Close editor" tooltipSide="bottom" onClick={onClose}>
                <X />
              </IconButton>
            </div>
          </div>

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
                Editing uses the original source while preparation runs.
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

          {/* Video player monitor */}
          <div
            ref={monitorRef}
            className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl border border-border bg-black p-3 shadow-e2"
          >
            {mediaUrl && !mediaError ? (
              <video
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
                onLoadedMetadata={updateVideoBounds}
                onLoadedData={() => {
                  setMediaError(false)
                  updateVideoBounds()
                }}
                onTimeUpdate={(event) => seek(event.currentTarget.currentTime * 1000)}
                onEnded={() => {
                  pause()
                  seek(0)
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
                cursorSettings={timeline?.canvas.cursorSettings}
                recordingId={recordingId}
                telemetryPath={
                  recording?.workDir ? `${recording.workDir}/cursor_telemetry.json` : null
                }
                containerWidth={videoBounds.width}
                containerHeight={videoBounds.height}
                offsetX={videoBounds.left}
                offsetY={videoBounds.top}
                sourceWidth={recording?.width ?? 1920}
                sourceHeight={recording?.height ?? 1080}
              />
            ) : null}

            <AudioTrackPreview
              tracks={timeline.tracks}
              outputs={audioTrackOutputs}
              playheadMs={view.playheadMs}
              isPlaying={view.isPlaying}
            />

            <div className="pointer-events-none absolute left-5 top-5 flex items-center gap-1.5 rounded-full border border-border bg-background/80 px-2.5 py-1 text-[10px] text-muted-foreground backdrop-blur">
              <span className="size-1.5 rounded-full bg-success" />
              <span>{mediaUrl && !mediaError ? "LIVE PREVIEW" : "PREVIEW UNAVAILABLE"}</span>
            </div>
          </div>

          {/* Floating Playback Controls Bar */}
          <div className="flex items-center justify-center gap-3 pt-4">
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
            <div className="ml-3 min-w-24 text-center font-mono text-xs font-semibold tabular-nums text-muted-foreground">
              {formatTime(view.playheadMs)} / {formatTime(view.durationMs)}
            </div>
            {onOpenExport ? (
              <Button
                variant="secondary"
                className="ml-3"
                disabled={missingAssets.length > 0}
                title={
                  missingAssets.length > 0
                    ? "Export is disabled while assets are missing"
                    : "Open export settings"
                }
                onClick={onOpenExport}
              >
                Export
              </Button>
            ) : null}
          </div>
        </div>

        {/* Right Inspector Sidebar */}
        <ClipInspector
          clip={selectedClip?.clip ?? null}
          track={selectedClip?.track ?? null}
          metadata={metadata}
          onClear={() => setSelectedClipId(null)}
        />
      </div>

      {/* Lower Area: Multi-Track Timeline */}
      <div className="flex h-80 shrink-0 flex-col bg-surface-dim">
        {/* Timeline Toolbar */}
        <div className="flex h-11 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-1">
            <div
              className="flex items-center gap-1 rounded-lg border border-border bg-surface p-1"
              role="toolbar"
              aria-label="Timeline tools"
            >
              <IconButton
                label="Selection tool"
                tooltipSide="top"
                aria-pressed={tool === "select"}
                className={cn(
                  tool === "select" && "bg-overlay text-foreground ring-1 ring-primary/30",
                )}
                onClick={() => setTool("select")}
              >
                <MousePointer2 />
              </IconButton>
              <IconButton
                label="Split tool"
                shortcut="S"
                tooltipSide="top"
                aria-pressed={tool === "split"}
                className={cn(
                  tool === "split" && "bg-primary/20 text-primary ring-1 ring-primary/30",
                )}
                onClick={() => setTool("split")}
              >
                <Scissors />
              </IconButton>
            </div>
            <div className="mx-2 h-5 w-px bg-border" />
            <IconButton
              label="Split selected clip at playhead"
              shortcut="S"
              tooltipSide="top"
              disabled={!selectedClip || selectedClip.track.locked}
              onClick={splitSelected}
            >
              <Scissors />
            </IconButton>
            <IconButton
              label="Delete selected clip"
              shortcut="Delete"
              tooltipSide="top"
              disabled={!selectedClip || selectedClip.track.locked}
              onClick={() => deleteSelected(selectedClip?.track.kind === "screen")}
            >
              <Trash2 />
            </IconButton>
            <IconButton
              label="Ripple delete selected clip"
              tooltipSide="top"
              disabled={!selectedClip || selectedClip.track.locked}
              onClick={() => deleteSelected(true)}
            >
              <Trash2 />
            </IconButton>
          </div>

          <div className="flex items-center gap-2">
            <IconButton
              label="Zoom out timeline"
              tooltipSide="top"
              disabled={view.zoom <= TIMELINE_ZOOM_MIN}
              onClick={() => adjustZoom(-TIMELINE_ZOOM_STEP)}
            >
              <ZoomOut />
            </IconButton>
            <Slider
              value={[Math.min(TIMELINE_ZOOM_MAX, Math.max(TIMELINE_ZOOM_MIN, view.zoom))]}
              min={TIMELINE_ZOOM_MIN}
              max={TIMELINE_ZOOM_MAX}
              step={1}
              aria-label="Timeline zoom"
              onValueChange={(value) => setZoom(value[0] ?? view.zoom)}
              className="w-32"
            />
            <IconButton
              label="Zoom in timeline"
              tooltipSide="top"
              disabled={view.zoom >= TIMELINE_ZOOM_MAX}
              onClick={() => adjustZoom(TIMELINE_ZOOM_STEP)}
            >
              <ZoomIn />
            </IconButton>
            <span className="min-w-9 text-right font-mono text-[10px] tabular-nums text-subtle-foreground">
              {Math.round(view.zoom)}%
            </span>
          </div>
        </div>

        {/* Timeline Ruler & Playhead Lane */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Track Headers (Left Column) */}
          <div className="z-10 w-48 shrink-0 border-r border-border bg-surface-dim">
            <div className="flex h-8 items-center border-b border-border px-4 text-[10px] font-semibold uppercase tracking-wider text-subtle-foreground">
              Tracks
            </div>
            {timeline.tracks.map((track) => {
              const TrackIcon = getTrackIcon(track)
              return (
                <div
                  key={track.id}
                  className={cn("flex items-center justify-between px-3", TRACK_ROW_CLASS)}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <TrackIcon
                      className={cn("size-4 shrink-0", {
                        "text-track-screen": track.kind === "screen",
                        "text-track-webcam": track.kind === "camera",
                        "text-track-mic":
                          track.kind === "audio" && !track.name.toLowerCase().includes("system"),
                        "text-track-system":
                          track.kind === "audio" && track.name.toLowerCase().includes("system"),
                      })}
                      aria-hidden
                    />
                    <span className="truncate text-xs font-medium text-muted-foreground">
                      {track.name}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <IconButton
                      label={track.muted ? `Unmute ${track.name}` : `Mute ${track.name}`}
                      tooltipSide="top"
                      className="size-7"
                      onClick={() => toggleTrackMuted(track)}
                    >
                      {track.muted ? <VolumeX /> : <Volume2 />}
                    </IconButton>
                    <IconButton
                      label={track.locked ? `Unlock ${track.name}` : `Lock ${track.name}`}
                      tooltipSide="top"
                      className="size-7"
                      onClick={() => toggleTrackLocked(track)}
                    >
                      {track.locked ? <Lock /> : <LockOpen />}
                    </IconButton>
                  </div>
                </div>
              )
            })}
          </div>

          {/* Timeline Tracks Lane */}
          <div className="min-w-0 flex-1 overflow-x-auto overflow-y-auto" onClick={seekFromPointer}>
            <div className="relative min-h-full" style={{ width: `${timelineWidth}px` }}>
              <div
                className="relative h-8 border-b border-border bg-surface-dim"
                onClick={seekFromPointer}
              >
                {Array.from({ length: tickCount }, (_, index) => {
                  const timeMs = Math.min(index * tickInterval, view.durationMs)
                  return (
                    <span
                      key={timeMs}
                      className="absolute bottom-1 -translate-x-1/2 font-mono text-[10px] tabular-nums text-subtle-foreground"
                      style={{ left: `${timeMs * pixelsPerMs}px` }}
                    >
                      {formatTime(timeMs)}
                    </span>
                  )
                })}
              </div>

              {/* Playhead vertical line */}
              <div
                className="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-primary shadow-[0_0_8px_var(--color-primary)]"
                style={{ left: `${view.playheadMs * pixelsPerMs}px` }}
              >
                <div className="absolute -left-1.5 top-0 size-3 rotate-45 rounded-xs bg-primary" />
              </div>

              {timeline.tracks.map((track) => {
                return (
                  <div key={track.id} className={cn("relative flex items-center", TRACK_ROW_CLASS)}>
                    {track.clips.map((clip) => {
                      const clipWaveformUrl =
                        clip.kind === "audio"
                          ? (waveformUrlsByStream.get(clip.streamIndex ?? -1) ?? waveformUrl)
                          : null

                      return (
                        <button
                          key={clip.id}
                          type="button"
                          className={cn(
                            "absolute flex h-9 min-w-10 items-center overflow-hidden rounded-md border px-2 text-left text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                            getClipClass(track),
                            selectedClipId === clip.id &&
                              "ring-2 ring-primary ring-offset-1 ring-offset-surface-dim",
                            track.muted && "opacity-45",
                            track.locked && "cursor-not-allowed opacity-60",
                          )}
                          style={{
                            left: `${clip.startMs * pixelsPerMs}px`,
                            width: `${Math.max(clip.durationMs * pixelsPerMs, 40)}px`,
                          }}
                          onClick={(event) => {
                            event.stopPropagation()
                            setSelectedClipId(clip.id)
                            if (tool === "split" && !track.locked) {
                              const bounds = event.currentTarget.getBoundingClientRect()
                              const offsetMs = Math.round(
                                Math.max(
                                  1,
                                  Math.min(
                                    clip.durationMs - 1,
                                    (event.clientX - bounds.left) / pixelsPerMs,
                                  ),
                                ),
                              )
                              const splitTimeMs = clip.startMs + offsetMs
                              seek(splitTimeMs)
                              execute(createSplitClipCommand(clip.id, splitTimeMs))
                            } else {
                              seek(clip.startMs)
                            }
                          }}
                          title={`${getClipLabel(clip, track)} · ${formatTime(clip.durationMs)}`}
                        >
                          {clip.kind === "audio" && clipWaveformUrl ? (
                            <img
                              key={`${activeJob?.id ?? "waveform"}-${clip.id}`}
                              src={clipWaveformUrl}
                              alt=""
                              aria-hidden
                              draggable={false}
                              loading="eager"
                              className="pointer-events-none absolute top-0 max-w-none mix-blend-screen opacity-80"
                              style={{
                                left: `${-(clip.sourceInMs * pixelsPerMs) / Math.max(clip.speed, 0.001)}px`,
                                width: `${(waveformDurationMs * pixelsPerMs) / Math.max(clip.speed, 0.001)}px`,
                                height: "100%",
                              }}
                              onError={() => setWaveformImageError(true)}
                            />
                          ) : null}
                          <span className="relative z-10 truncate font-medium text-foreground">
                            {getClipLabel(clip, track)}
                          </span>
                          {clip.kind === "audio" && !clipWaveformUrl ? (
                            <span
                              className="relative z-10 ml-2 flex shrink-0 items-end gap-px opacity-70"
                              aria-hidden
                            >
                              {Array.from({ length: 8 }, (_, index) => (
                                <span
                                  key={index}
                                  className="w-px bg-current"
                                  style={{ height: `${6 + ((index * 7) % 10)}px` }}
                                />
                              ))}
                            </span>
                          ) : null}
                        </button>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {activeExportJob?.status === "running" ? (
        <div className="absolute bottom-4 right-4 rounded-lg border border-primary/30 bg-surface px-3 py-2 text-xs shadow-e2">
          <span className="font-medium text-foreground">Exporting</span>
          <span className="ml-2 font-mono text-muted-foreground">
            {Math.round(activeExportJob.progress * 100)}%
          </span>
        </div>
      ) : null}
    </div>
  )
}
