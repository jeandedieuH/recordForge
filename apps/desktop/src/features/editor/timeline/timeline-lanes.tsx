import { useEffect, useMemo, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import type {
  TimelineClip,
  TimelineMarker,
  TimelineState,
  TimelineTrack,
  TimelineViewState,
} from "@recordforge/contracts"
import {
  AudioLines,
  ChevronDown,
  ChevronUp,
  Headphones,
  Lock,
  LockOpen,
  Monitor,
  Rows3,
  Video,
  Volume2,
  VolumeX,
  type LucideIcon,
} from "lucide-react"
import { IconButton, cn } from "@recordforge/ui"
import { buildSnapTargets, snapClipStart, snapTrimEdge } from "@recordforge/editor-core"
import {
  toAssetUrl,
  type DerivativeResource,
  type WaveformResources,
  type ThumbnailManifest,
} from "../media/derivative-resources"
import { ThumbnailStrip, WaveformStrip } from "./timeline-derivatives"

const RULER_HEIGHT = 32
const MARKER_LANE_HEIGHT = 28
const TRACK_ROW_HEIGHT = 56
const COLLAPSED_TRACK_HEIGHT = 32
const VIRTUAL_OVERSCAN = 4
const TICK_INTERVALS = [1_000, 5_000, 10_000, 30_000, 60_000]

interface TimelineLanesProps {
  timeline: TimelineState
  view: TimelineViewState
  timelineWidth: number
  pixelsPerMs: number
  tickInterval: number
  cursorClickTimesMs?: number[]
  thumbnailResource: DerivativeResource<ThumbnailManifest>
  waveformResources: WaveformResources
  onSeek: (ms: number) => void
  onSetScroll: (ms: number) => void
  onSelectClip: (clip: TimelineClip, track: TimelineTrack, event: React.MouseEvent) => void
  onSelectRange: (startMs: number, endMs: number) => void
  onMoveClip: (
    clip: TimelineClip,
    track: TimelineTrack,
    newStartMs: number,
    coalesceKey: string,
  ) => void
  onTrimClip: (
    clip: TimelineClip,
    track: TimelineTrack,
    edge: "start" | "end",
    edgeTimeMs: number,
    coalesceKey: string,
  ) => void
  onSelectMarker: (marker: TimelineMarker) => void
  onDeleteSelection: (ripple: boolean) => void
  onToggleTrackMuted: (track: TimelineTrack) => void
  onToggleTrackSolo: (track: TimelineTrack) => void
  onToggleTrackLocked: (track: TimelineTrack) => void
  onToggleTrackCollapsed: (track: TimelineTrack) => void
  onCycleTrackHeight: (track: TimelineTrack) => void
  onSpriteError: () => void
}

function getTrackIcon(track: TimelineTrack): LucideIcon {
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

function getVisibleTickInterval(pixelsPerMs: number): number {
  const minimumSpacing = 72
  return (
    TICK_INTERVALS.find((interval) => interval * pixelsPerMs >= minimumSpacing) ??
    TICK_INTERVALS[TICK_INTERVALS.length - 1]
  )
}

function clipIntersectsWindow(clip: TimelineClip, startMs: number, endMs: number): boolean {
  const clipEndMs = clip.startMs + clip.durationMs
  return clipEndMs >= startMs && clip.startMs <= endMs
}

function getTrackHeight(track: TimelineTrack, view: TimelineViewState): number {
  if (view.collapsedTrackIds.includes(track.id)) return COLLAPSED_TRACK_HEIGHT
  return view.trackHeights[track.id] ?? TRACK_ROW_HEIGHT
}

export function TimelineLanes({
  timeline,
  view,
  timelineWidth,
  pixelsPerMs,
  tickInterval,
  cursorClickTimesMs = [],
  thumbnailResource,
  waveformResources,
  onSeek,
  onSetScroll,
  onSelectClip,
  onSelectRange,
  onMoveClip,
  onTrimClip,
  onSelectMarker,
  onDeleteSelection,
  onToggleTrackMuted,
  onToggleTrackSolo,
  onToggleTrackLocked,
  onToggleTrackCollapsed,
  onCycleTrackHeight,
  onSpriteError,
}: TimelineLanesProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const selectedClipIds = new Set(view.selection?.kind === "clip" ? view.selection.clipIds : [])
  const selectedMarkerId = view.selection?.kind === "marker" ? view.selection.markerId : null
  const scrollMargin = RULER_HEIGHT + MARKER_LANE_HEIGHT
  const [draftRange, setDraftRange] = useState<{ startMs: number; endMs: number } | null>(null)
  const rangePointerRef = useRef<{
    pointerId: number
    startMs: number
    moved: boolean
  } | null>(null)
  const suppressClickRef = useRef(false)

  // The ruler and marker lane occupy the virtualizer's scroll margin, so a
  // 60-minute project only mounts rows and clips in the visible viewport.
  const trackVirtualizer = useVirtualizer({
    count: timeline.tracks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const track = timeline.tracks[index]
      return track ? getTrackHeight(track, view) : TRACK_ROW_HEIGHT
    },
    getItemKey: (index) => timeline.tracks[index]?.id ?? index,
    overscan: VIRTUAL_OVERSCAN,
    scrollMargin,
  })

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      setViewportWidth(element.clientWidth)
      setViewportHeight(element.clientHeight)
    })
    observer.observe(element)
    setViewportWidth(element.clientWidth)
    setViewportHeight(element.clientHeight)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const nextScrollLeft = view.scrollMs * pixelsPerMs
    if (Math.abs(element.scrollLeft - nextScrollLeft) > 1) element.scrollLeft = nextScrollLeft
  }, [pixelsPerMs, view.scrollMs])

  const visibleStartMs = Math.max(0, scrollLeft / pixelsPerMs - 1_000 / Math.max(view.zoom, 1))
  const visibleEndMs = Math.min(
    view.durationMs,
    visibleStartMs + Math.max(viewportWidth / pixelsPerMs, 1_000) + 2_000 / Math.max(view.zoom, 1),
  )
  const visibleTicks = useMemo(() => {
    const firstTick = Math.max(0, Math.floor(visibleStartMs / tickInterval) - 1)
    const lastTick = Math.min(
      Math.ceil(view.durationMs / tickInterval),
      Math.ceil(visibleEndMs / tickInterval) + 1,
    )
    return Array.from({ length: Math.max(0, lastTick - firstTick + 1) }, (_, index) => {
      const timeMs = Math.min((firstTick + index) * tickInterval, view.durationMs)
      return { timeMs, left: timeMs * pixelsPerMs }
    })
  }, [pixelsPerMs, tickInterval, view.durationMs, visibleEndMs, visibleStartMs])

  const estimatedTrackHeight = timeline.tracks.reduce(
    (total, track) => total + getTrackHeight(track, view),
    0,
  )
  const totalTrackHeight = Math.max(estimatedTrackHeight, trackVirtualizer.getTotalSize())
  const contentHeight = scrollMargin + totalTrackHeight
  const virtualTracks = trackVirtualizer.getVirtualItems()
  const visibleTrackRows = virtualTracks.map((virtualTrack) => {
    const track = timeline.tracks[virtualTrack.index]
    return { track, virtualTrack }
  })

  function handleScroll() {
    const element = scrollRef.current
    if (!element) return
    setScrollTop(element.scrollTop)
    setScrollLeft(element.scrollLeft)
    onSetScroll(element.scrollLeft / pixelsPerMs)
  }

  function timelineTimeFromClientX(clientX: number): number {
    const element = scrollRef.current
    if (!element) return 0
    const bounds = element.getBoundingClientRect()
    const position = Math.max(0, clientX - bounds.left + element.scrollLeft)
    return Math.min(view.durationMs, position / pixelsPerMs)
  }

  function seekFromPointer(event: React.MouseEvent<HTMLDivElement>) {
    onSeek(timelineTimeFromClientX(event.clientX))
  }

  function isTimelineInteractiveTarget(target: EventTarget | null): boolean {
    return (
      target instanceof Element &&
      Boolean(target.closest("[data-timeline-clip], [data-timeline-marker]"))
    )
  }

  function handleTimelinePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || isTimelineInteractiveTarget(event.target)) return
    const startMs = timelineTimeFromClientX(event.clientX)
    rangePointerRef.current = { pointerId: event.pointerId, startMs, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handleTimelinePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = rangePointerRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const endMs = timelineTimeFromClientX(event.clientX)
    if (Math.abs(endMs - gesture.startMs) < 1) return
    gesture.moved = true
    setDraftRange({
      startMs: Math.min(gesture.startMs, endMs),
      endMs: Math.max(gesture.startMs, endMs),
    })
    event.preventDefault()
  }

  function finishTimelinePointer(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = rangePointerRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const endMs = timelineTimeFromClientX(event.clientX)
    if (gesture.moved) {
      const startMs = Math.min(gesture.startMs, endMs)
      const rangeEndMs = Math.max(gesture.startMs, endMs)
      if (rangeEndMs - startMs >= 1) onSelectRange(startMs, rangeEndMs)
      suppressClickRef.current = true
    }
    rangePointerRef.current = null
    setDraftRange(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const thumbnailData = thumbnailResource.status === "content" ? thumbnailResource.data : null
  const spriteUrl = thumbnailData ? toAssetUrl(thumbnailData.spritePath) : null

  return (
    <div className="flex min-h-0 flex-1 border-t border-border" aria-label="Timeline editor">
      <div className="w-52 shrink-0 overflow-hidden border-r border-border bg-surface">
        <div className="flex h-8 items-center border-b border-border px-3 text-[10px] font-semibold uppercase tracking-wider text-subtle-foreground">
          Tracks
        </div>
        <div className="flex h-7 items-center border-b border-border px-3 text-[10px] font-semibold uppercase tracking-wider text-subtle-foreground">
          Markers
        </div>
        <div
          className="relative overflow-hidden"
          style={{ height: `${Math.max(0, viewportHeight - scrollMargin)}px` }}
        >
          <div
            className="relative"
            style={{ height: `${totalTrackHeight}px`, transform: `translateY(${-scrollTop}px)` }}
          >
            {visibleTrackRows.map(({ track, virtualTrack }) => {
              if (!track) return null
              return (
                <TrackHeader
                  key={track.id}
                  track={track}
                  selected={track.clips.some((clip) => selectedClipIds.has(clip.id))}
                  collapsed={view.collapsedTrackIds.includes(track.id)}
                  height={virtualTrack.size}
                  top={virtualTrack.start - scrollMargin}
                  onToggleTrackMuted={onToggleTrackMuted}
                  onToggleTrackSolo={onToggleTrackSolo}
                  onToggleTrackLocked={onToggleTrackLocked}
                  onToggleTrackCollapsed={onToggleTrackCollapsed}
                  onCycleTrackHeight={onCycleTrackHeight}
                />
              )
            })}
          </div>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="min-w-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
        onScroll={handleScroll}
        onPointerDown={handleTimelinePointerDown}
        onPointerMove={handleTimelinePointerMove}
        onPointerUp={finishTimelinePointer}
        onPointerCancel={finishTimelinePointer}
        onClick={(event) => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false
            return
          }
          seekFromPointer(event)
        }}
        tabIndex={0}
        role="region"
        aria-label="Timeline tracks and playhead"
        aria-keyshortcuts="Space S M Delete Shift+Delete Home End ArrowLeft ArrowRight J K L"
      >
        <div
          className="relative"
          style={{
            width: `${timelineWidth}px`,
            height: `${Math.max(contentHeight, viewportHeight)}px`,
          }}
        >
          {spriteUrl ? (
            <img
              src={spriteUrl}
              alt=""
              aria-hidden
              className="pointer-events-none absolute size-px opacity-0"
              onError={onSpriteError}
            />
          ) : null}
          <div className="sticky top-0 z-30 h-8 border-b border-border bg-surface-dim/95 backdrop-blur">
            {visibleTicks.map(({ timeMs, left }) => (
              <span
                key={timeMs}
                className="absolute bottom-1 -translate-x-1/2 font-mono text-[10px] tabular-nums text-subtle-foreground"
                style={{ left: `${left}px` }}
              >
                {formatTimelineTime(timeMs)}
              </span>
            ))}
          </div>

          <div className="sticky top-8 z-30 h-7 border-b border-border bg-surface-dim/95 backdrop-blur">
            {timeline.markers
              .filter((marker) => marker.timeMs >= visibleStartMs && marker.timeMs <= visibleEndMs)
              .map((marker) => (
                <button
                  key={marker.id}
                  type="button"
                  data-timeline-marker
                  className={cn(
                    "absolute top-1 flex h-5 max-w-32 -translate-x-1/2 items-center gap-1 truncate rounded px-1.5 text-[10px] font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary",
                    selectedMarkerId === marker.id ? "bg-primary/30" : "bg-overlay/90",
                  )}
                  style={{ left: `${marker.timeMs * pixelsPerMs}px` }}
                  onClick={(event) => {
                    event.stopPropagation()
                    onSelectMarker(marker)
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Delete" && event.key !== "Backspace") return
                    event.preventDefault()
                    event.stopPropagation()
                    onDeleteSelection(event.shiftKey)
                  }}
                  title={`${marker.label} · ${formatTimelineTime(marker.timeMs)}`}
                >
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: marker.color }}
                  />
                  <span className="truncate">{marker.label}</span>
                </button>
              ))}
          </div>

          <div
            className="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-primary shadow-e2"
            style={{ left: `${view.playheadMs * pixelsPerMs}px` }}
          >
            <div className="absolute -left-1.5 top-8 size-3 rotate-45 rounded-xs bg-primary" />
          </div>

          {(() => {
            const range = draftRange ?? (view.selection?.kind === "range" ? view.selection : null)
            if (!range) return null
            return (
              <div
                className="pointer-events-none absolute bottom-0 top-8 z-10 rounded-sm border border-primary/60 bg-primary/15"
                aria-label={`Selected range from ${formatTimelineTime(range.startMs)} to ${formatTimelineTime(range.endMs)}`}
                style={{
                  left: `${range.startMs * pixelsPerMs}px`,
                  width: `${Math.max(1, (range.endMs - range.startMs) * pixelsPerMs)}px`,
                }}
              />
            )
          })()}

          {visibleTrackRows.map(({ track, virtualTrack }) => {
            if (!track) return null
            return (
              <TimelineTrackRow
                key={track.id}
                track={track}
                top={virtualTrack.start}
                height={virtualTrack.size}
                visibleStartMs={visibleStartMs}
                visibleEndMs={visibleEndMs}
                pixelsPerMs={pixelsPerMs}
                selectedClipIds={selectedClipIds}
                frameMs={Math.max(1, Math.round(1000 / Math.max(1, timeline.canvas.fps)))}
                collapsed={view.collapsedTrackIds.includes(track.id)}
                thumbnailManifest={thumbnailData}
                spriteUrl={spriteUrl}
                waveformResources={waveformResources}
                onSelectClip={onSelectClip}
                onMoveClip={onMoveClip}
                onTrimClip={onTrimClip}
                getTimelineTime={timelineTimeFromClientX}
                snapTargets={buildSnapTargets(timeline, {
                  excludeClipId: undefined,
                  playheadMs: view.playheadMs,
                  cursorClickTimesMs,
                })}
                snapEnabled={view.snapEnabled}
                snapThresholdMs={view.snapThresholdMs}
                onSpriteError={onSpriteError}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}

function TrackHeader({
  track,
  selected,
  collapsed,
  height,
  top,
  onToggleTrackMuted,
  onToggleTrackSolo,
  onToggleTrackLocked,
  onToggleTrackCollapsed,
  onCycleTrackHeight,
}: {
  track: TimelineTrack
  selected: boolean
  collapsed: boolean
  height: number
  top: number
  onToggleTrackMuted: (track: TimelineTrack) => void
  onToggleTrackSolo: (track: TimelineTrack) => void
  onToggleTrackLocked: (track: TimelineTrack) => void
  onToggleTrackCollapsed: (track: TimelineTrack) => void
  onCycleTrackHeight: (track: TimelineTrack) => void
}) {
  const TrackIcon = getTrackIcon(track)
  return (
    <div
      className={cn(
        "absolute inset-x-0 flex items-center justify-between border-b border-border px-3",
        selected && "bg-overlay/40",
      )}
      style={{ transform: `translateY(${top}px)`, height }}
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
        <span className="truncate text-xs font-medium text-muted-foreground">{track.name}</span>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton
          label={track.muted ? `Unmute ${track.name}` : `Mute ${track.name}`}
          tooltipSide="top"
          className="size-7"
          onClick={() => onToggleTrackMuted(track)}
        >
          {track.muted ? <VolumeX /> : <Volume2 />}
        </IconButton>
        <IconButton
          label={track.solo ? `Unsolo ${track.name}` : `Solo ${track.name}`}
          tooltipSide="top"
          className={cn("size-7", track.solo && "bg-primary/20 text-primary")}
          onClick={() => onToggleTrackSolo(track)}
        >
          <Headphones />
        </IconButton>
        <IconButton
          label={track.locked ? `Unlock ${track.name}` : `Lock ${track.name}`}
          tooltipSide="top"
          className="size-7"
          onClick={() => onToggleTrackLocked(track)}
        >
          {track.locked ? <Lock /> : <LockOpen />}
        </IconButton>
        <IconButton
          label={collapsed ? `Expand ${track.name}` : `Collapse ${track.name}`}
          tooltipSide="top"
          className="size-7"
          onClick={() => onToggleTrackCollapsed(track)}
        >
          {collapsed ? <ChevronDown /> : <ChevronUp />}
        </IconButton>
        <IconButton
          label={`Change ${track.name} height`}
          tooltipSide="top"
          className="size-7"
          onClick={() => onCycleTrackHeight(track)}
        >
          <Rows3 />
        </IconButton>
      </div>
    </div>
  )
}

function TimelineTrackRow({
  track,
  top,
  height,
  visibleStartMs,
  visibleEndMs,
  pixelsPerMs,
  selectedClipIds,
  frameMs,
  collapsed,
  thumbnailManifest,
  spriteUrl,
  waveformResources,
  onSelectClip,
  onMoveClip,
  onTrimClip,
  getTimelineTime,
  snapTargets,
  snapEnabled,
  snapThresholdMs,
  onSpriteError,
}: {
  track: TimelineTrack
  top: number
  height: number
  visibleStartMs: number
  visibleEndMs: number
  pixelsPerMs: number
  selectedClipIds: Set<string>
  frameMs: number
  collapsed: boolean
  thumbnailManifest: ThumbnailManifest | null
  spriteUrl: string | null
  waveformResources: WaveformResources
  onSelectClip: (clip: TimelineClip, track: TimelineTrack, event: React.MouseEvent) => void
  onMoveClip: (
    clip: TimelineClip,
    track: TimelineTrack,
    newStartMs: number,
    coalesceKey: string,
  ) => void
  onTrimClip: (
    clip: TimelineClip,
    track: TimelineTrack,
    edge: "start" | "end",
    edgeTimeMs: number,
    coalesceKey: string,
  ) => void
  getTimelineTime: (clientX: number) => number
  snapTargets: ReturnType<typeof buildSnapTargets>
  snapEnabled: boolean
  snapThresholdMs: number
  onSpriteError: () => void
}) {
  const visibleClips = track.clips.filter((clip) =>
    clipIntersectsWindow(clip, visibleStartMs, visibleEndMs),
  )

  return (
    <div
      className={cn(
        "absolute inset-x-0 flex items-center border-b border-border",
        track.muted && "bg-surface-dim/20",
      )}
      style={{ top, height }}
    >
      {visibleClips.map((clip) => (
        <TimelineClipItem
          key={clip.id}
          clip={clip}
          track={track}
          height={height}
          pixelsPerMs={pixelsPerMs}
          selected={selectedClipIds.has(clip.id)}
          frameMs={frameMs}
          collapsed={collapsed}
          thumbnailManifest={thumbnailManifest}
          spriteUrl={spriteUrl}
          visibleStartMs={visibleStartMs}
          visibleEndMs={visibleEndMs}
          waveformResources={waveformResources}
          onSelectClip={onSelectClip}
          onMoveClip={onMoveClip}
          onTrimClip={onTrimClip}
          getTimelineTime={getTimelineTime}
          snapTargets={snapTargets}
          snapEnabled={snapEnabled}
          snapThresholdMs={snapThresholdMs}
          onSpriteError={onSpriteError}
        />
      ))}
    </div>
  )
}

interface ClipGesture {
  pointerId: number
  mode: "move" | "trim-start" | "trim-end"
  initialClientX: number
  initialTimelineMs: number
  moved: boolean
  coalesceKey: string
}

function TimelineClipItem({
  clip,
  track,
  height,
  pixelsPerMs,
  selected,
  frameMs,
  collapsed,
  thumbnailManifest,
  spriteUrl,
  visibleStartMs,
  visibleEndMs,
  waveformResources,
  onSelectClip,
  onMoveClip,
  onTrimClip,
  getTimelineTime,
  snapTargets,
  snapEnabled,
  snapThresholdMs,
  onSpriteError,
}: {
  clip: TimelineClip
  track: TimelineTrack
  height: number
  pixelsPerMs: number
  selected: boolean
  frameMs: number
  collapsed: boolean
  thumbnailManifest: ThumbnailManifest | null
  spriteUrl: string | null
  visibleStartMs: number
  visibleEndMs: number
  waveformResources: WaveformResources
  onSelectClip: (clip: TimelineClip, track: TimelineTrack, event: React.MouseEvent) => void
  onMoveClip: (
    clip: TimelineClip,
    track: TimelineTrack,
    newStartMs: number,
    coalesceKey: string,
  ) => void
  onTrimClip: (
    clip: TimelineClip,
    track: TimelineTrack,
    edge: "start" | "end",
    edgeTimeMs: number,
    coalesceKey: string,
  ) => void
  getTimelineTime: (clientX: number) => number
  snapTargets: ReturnType<typeof buildSnapTargets>
  snapEnabled: boolean
  snapThresholdMs: number
  onSpriteError: () => void
}) {
  const gestureRef = useRef<ClipGesture | null>(null)
  const suppressClickRef = useRef(false)
  const waveformResource =
    clip.kind === "audio" ? waveformResources.byStream.get(clip.streamIndex ?? -1) : undefined
  const waveformData = waveformResource?.status === "content" ? waveformResource.data : null
  const clipTargets = snapTargets.filter((target) => !target.id.startsWith(`${clip.id}:`))
  const clipHeight = collapsed ? 24 : Math.max(32, Math.min(height - 16, 40))

  function beginGesture(
    event: React.PointerEvent<HTMLDivElement | HTMLButtonElement>,
    mode: ClipGesture["mode"],
  ) {
    if (event.button !== 0 || track.locked) return
    event.stopPropagation()
    event.preventDefault()
    const target = event.currentTarget.closest("[data-timeline-clip]")
    if (!(target instanceof HTMLElement)) return
    target.setPointerCapture(event.pointerId)
    gestureRef.current = {
      pointerId: event.pointerId,
      mode,
      initialClientX: event.clientX,
      initialTimelineMs: getTimelineTime(event.clientX),
      moved: false,
      coalesceKey: `${mode}:${clip.id}:${crypto.randomUUID()}`,
    }
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const currentMs = getTimelineTime(event.clientX)
    const deltaMs = currentMs - gesture.initialTimelineMs
    if (Math.abs(event.clientX - gesture.initialClientX) < 3 && !gesture.moved) return
    gesture.moved = true
    suppressClickRef.current = true
    event.preventDefault()

    if (gesture.mode === "move") {
      const rawStartMs = Math.max(0, Math.round(clip.startMs + deltaMs))
      const snapped = snapClipStart(rawStartMs, clip.durationMs, clipTargets, {
        enabled: snapEnabled,
        thresholdMs: snapThresholdMs,
      })
      onMoveClip(clip, track, snapped.timeMs, gesture.coalesceKey)
      return
    }

    const edge = gesture.mode === "trim-start" ? "start" : "end"
    const rawEdgeTimeMs = Math.max(0, Math.round(clip.startMs + deltaMs))
    const snapped = snapTrimEdge(edge, rawEdgeTimeMs, clipTargets, {
      enabled: snapEnabled,
      thresholdMs: snapThresholdMs,
    })
    onTrimClip(clip, track, edge, snapped.timeMs, gesture.coalesceKey)
  }

  function finishGesture(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    gestureRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handleClass = cn(
    "absolute inset-y-0 z-20 w-2 cursor-ew-resize rounded-sm opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
    "bg-primary/70",
  )

  return (
    <div
      role="button"
      tabIndex={0}
      data-timeline-clip
      aria-label={`${getClipLabel(clip, track)} from ${formatTimelineTime(clip.startMs)} to ${formatTimelineTime(clip.startMs + clip.durationMs)}`}
      aria-pressed={selected}
      aria-keyshortcuts="Enter Space ArrowLeft ArrowRight"
      className={cn(
        "absolute flex min-w-10 items-center overflow-hidden rounded-md border px-2 text-left text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        getClipClass(track),
        selected && "ring-2 ring-primary ring-offset-1 ring-offset-surface-dim",
        track.muted && "opacity-45",
        track.locked && "cursor-not-allowed opacity-60",
        collapsed ? "h-6" : "h-9",
      )}
      style={{
        left: `${clip.startMs * pixelsPerMs}px`,
        width: `${Math.max(clip.durationMs * pixelsPerMs, 40)}px`,
        height: `${clipHeight}px`,
      }}
      onPointerDown={(event) => beginGesture(event, "move")}
      onPointerMove={handlePointerMove}
      onPointerUp={finishGesture}
      onPointerCancel={finishGesture}
      onClick={(event) => {
        event.stopPropagation()
        if (suppressClickRef.current) {
          suppressClickRef.current = false
          return
        }
        onSelectClip(clip, track, event)
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault()
          event.stopPropagation()
          event.currentTarget.click()
          return
        }
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
        const direction = event.key === "ArrowLeft" ? -1 : 1
        if (event.altKey) {
          event.preventDefault()
          event.stopPropagation()
          const edge = event.shiftKey
            ? direction === -1
              ? "end"
              : "start"
            : direction === -1
              ? "start"
              : "end"
          const edgeTimeMs =
            edge === "start"
              ? clip.startMs + direction * frameMs
              : clip.startMs + clip.durationMs + direction * frameMs
          onTrimClip(clip, track, edge, edgeTimeMs, `keyboard-trim:${clip.id}`)
          return
        }
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault()
          event.stopPropagation()
          const nextStartMs = Math.max(
            0,
            clip.startMs + direction * (event.shiftKey ? 1_000 : frameMs),
          )
          onMoveClip(clip, track, nextStartMs, `keyboard-move:${clip.id}`)
        }
      }}
      title={`${getClipLabel(clip, track)} · ${formatTimelineTime(clip.durationMs)}`}
    >
      <button
        type="button"
        className={cn(handleClass, "left-0")}
        aria-label={`Trim start of ${getClipLabel(clip, track)}`}
        onPointerDown={(event) => beginGesture(event, "trim-start")}
        onClick={(event) => event.stopPropagation()}
      />
      {thumbnailManifest && spriteUrl ? (
        <ThumbnailStrip
          clip={clip}
          manifest={thumbnailManifest}
          spriteUrl={spriteUrl}
          pixelsPerMs={pixelsPerMs}
          visibleStartMs={visibleStartMs}
          visibleEndMs={visibleEndMs}
          onSpriteError={onSpriteError}
        />
      ) : null}
      {waveformData ? (
        <WaveformStrip
          clip={clip}
          data={waveformData}
          pixelsPerMs={pixelsPerMs}
          visibleStartMs={visibleStartMs}
          visibleEndMs={visibleEndMs}
        />
      ) : null}
      <span className="relative z-10 truncate font-medium text-foreground">
        {getClipLabel(clip, track)}
      </span>
      {clip.kind === "audio" && !waveformData ? (
        <span className="relative z-10 ml-2 flex shrink-0 items-end gap-px opacity-70" aria-hidden>
          {Array.from({ length: 8 }, (_, index) => (
            <span
              key={index}
              className="w-px bg-current"
              style={{ height: `${6 + ((index * 7) % 10)}px` }}
            />
          ))}
        </span>
      ) : null}
      <button
        type="button"
        className={cn(handleClass, "right-0")}
        aria-label={`Trim end of ${getClipLabel(clip, track)}`}
        onPointerDown={(event) => beginGesture(event, "trim-end")}
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  )
}

function formatTimelineTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  const millis = Math.floor((ms % 1000) / 10)
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${millis.toString().padStart(2, "0")}`
}

export { getVisibleTickInterval }
