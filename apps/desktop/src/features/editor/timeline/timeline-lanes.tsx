import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import type {
  CursorSmoothing,
  ManualZoomSegment,
  TimelineClip,
  TimelineMarker,
  TimelineState,
  TimelineTrack,
  TimelineViewState,
} from "@recordforge/contracts"
import { buildSnapTargets, type SnapTarget } from "@recordforge/editor-core"
import { Scissors } from "lucide-react"
import type {
  DerivativeResource,
  ThumbnailManifest,
  VideoTrackThumbnailResources,
  WaveformResources,
} from "../media/derivative-resources"
import { toAssetUrl } from "../media/derivative-resources"
import { TimelineClipItem } from "./timeline-clip-item"
import { TimelineMarquee } from "./timeline-marquee"
import { TimelinePlayhead } from "./timeline-playhead"
import { TimelineRuler, getVisibleTickInterval } from "./timeline-ruler"
import { TimelineTrackHeader } from "./timeline-track-header"
import type { TimelineTool } from "./timeline-toolbar"
import { ZoomTrackRow } from "./zoom-track"

const RULER_TOTAL_HEIGHT = 52
const TRACK_ROW_HEIGHT = 56
const COLLAPSED_TRACK_HEIGHT = 32
const VIRTUAL_OVERSCAN = 4

export interface CursorRangeAction {
  kind: "toggle-enabled" | "set-smoothing" | "toggle-lock"
  rangeId: string
  smoothing?: CursorSmoothing
}

export interface ZoomSegmentAction {
  kind: "select" | "toggle-lock" | "split" | "delete" | "regenerate-from-click"
  segmentId: string
}

export interface TimelineLanesProps {
  timeline: TimelineState
  view: TimelineViewState
  tool?: TimelineTool
  timelineWidth?: number
  pixelsPerMs?: number
  tickInterval?: number
  cursorClickTimesMs?: number[]
  thumbnailResource: DerivativeResource<ThumbnailManifest>
  videoThumbnailResources?: VideoTrackThumbnailResources
  waveformResources: WaveformResources
  onSeek: (ms: number) => void
  onPause?: () => void
  onSetScroll: (ms: number) => void
  onSetZoom?: (zoom: number) => void
  onSelectClip: (clip: TimelineClip, track: TimelineTrack, event: React.MouseEvent) => void
  onSelectMultipleClips?: (clipIds: string[], primaryClipId: string, trackId: string) => void
  onSelectRange: (startMs: number, endMs: number) => void
  onMoveClip: (
    clip: TimelineClip,
    track: TimelineTrack,
    newStartMs: number,
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
  onTrimClip: (
    clip: TimelineClip,
    track: TimelineTrack,
    edge: "start" | "end",
    edgeTimeMs: number,
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
  onSelectMarker: (marker: TimelineMarker) => void
  onDeleteMarker?: (markerId: string) => void
  onAddMarkerAtTime?: (timeMs: number) => void
  onSelectZoom: (segmentId: string) => void
  onMoveZoomSegment: (
    segment: ManualZoomSegment,
    startMs: number,
    endMs: number,
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
  onResizeZoomSegment: (
    segment: ManualZoomSegment,
    startMs: number,
    endMs: number,
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
  onDeleteSelection: (ripple: boolean) => void
  onToggleTrackMuted: (track: TimelineTrack) => void
  onToggleTrackSolo: (track: TimelineTrack) => void
  onToggleTrackLocked: (track: TimelineTrack) => void
  onToggleTrackCollapsed: (track: TimelineTrack) => void
  onCycleTrackHeight: (track: TimelineTrack) => void
  onSpriteError: () => void
  onDuplicateClip: (clip: TimelineClip) => void
  onSplitClip: (clip: TimelineClip) => void
  onDeleteClip: (clip: TimelineClip) => void
  onCursorRangeAction?: (action: CursorRangeAction) => void
  onZoomSegmentAction?: (action: ZoomSegmentAction) => void
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
  tool = "select",
  timelineWidth: propTimelineWidth,
  pixelsPerMs: propPixelsPerMs,
  tickInterval: propTickInterval,
  cursorClickTimesMs = [],
  thumbnailResource,
  videoThumbnailResources,
  waveformResources,
  onSeek,
  onPause,
  onSetScroll,
  onSetZoom,
  onSelectClip,
  onSelectMultipleClips,
  onSelectRange,
  onMoveClip,
  onTrimClip,
  onSelectMarker,
  onDeleteMarker,
  onAddMarkerAtTime,
  onSelectZoom,
  onDeleteSelection,
  onToggleTrackMuted,
  onToggleTrackSolo,
  onToggleTrackLocked,
  onToggleTrackCollapsed,
  onCycleTrackHeight,
  onSpriteError,
  onDuplicateClip,
  onSplitClip,
  onDeleteClip,
  onCursorRangeAction,
  onZoomSegmentAction,
  onMoveZoomSegment,
  onResizeZoomSegment,
}: TimelineLanesProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  const [marquee, setMarquee] = useState<{ startMs: number; endMs: number } | null>(null)
  const [razorHoverMs, setRazorHoverMs] = useState<number | null>(null)
  const [snapGuide, setSnapGuide] = useState<SnapTarget | null>(null)

  const marqueePointerRef = useRef<{
    pointerId: number
    startMs: number
    moved: boolean
  } | null>(null)

  const selectedClipIds = new Set(view.selection?.kind === "clip" ? view.selection.clipIds : [])
  const selectedMarkerId = view.selection?.kind === "marker" ? view.selection.markerId : null
  const selectedZoomId = view.selection?.kind === "zoom" ? view.selection.segmentId : null

  const scrollMargin = RULER_TOTAL_HEIGHT

  // ResizeObserver for viewport dimensions
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const updateDimensions = () => {
      setViewportWidth(element.clientWidth)
      setViewportHeight(element.clientHeight)
    }
    updateDimensions()
    const observer = new ResizeObserver(updateDimensions)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Base scale: fits full duration into available viewport width (or fallback 800px)
  const basePixelsPerMs = useMemo(() => {
    const effectiveWidth = Math.max(200, viewportWidth || 800)
    return view.durationMs > 0 ? effectiveWidth / view.durationMs : 0.05
  }, [viewportWidth, view.durationMs])

  // Zoom scale: 0% = fit available viewport width, 100% = max frame-level zoom
  const computedPixelsPerMs = useMemo(() => {
    const zoomPercent = Math.max(0, Math.min(100, view.zoom))
    if (zoomPercent === 0) return basePixelsPerMs
    const maxMultiplier = Math.max(25, 0.5 / Math.max(0.0001, basePixelsPerMs))
    const multiplier = Math.pow(maxMultiplier, zoomPercent / 100)
    return basePixelsPerMs * multiplier
  }, [basePixelsPerMs, view.zoom])

  const pixelsPerMs = propPixelsPerMs ?? computedPixelsPerMs

  const computedTimelineWidth = useMemo(() => {
    const effectiveWidth = Math.max(200, viewportWidth)
    if (view.zoom === 0) return effectiveWidth
    return Math.max(effectiveWidth, Math.ceil(view.durationMs * pixelsPerMs))
  }, [viewportWidth, view.durationMs, pixelsPerMs, view.zoom])

  const timelineWidth = propTimelineWidth ?? computedTimelineWidth

  const tickInterval = propTickInterval ?? getVisibleTickInterval(pixelsPerMs)

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

  // Synchronize horizontal scroll position from store
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const nextScrollLeft = view.scrollMs * pixelsPerMs
    if (Math.abs(element.scrollLeft - nextScrollLeft) > 2) {
      element.scrollLeft = nextScrollLeft
      setScrollLeft(nextScrollLeft)
    }
  }, [pixelsPerMs, view.scrollMs])

  // Auto-scroll timeline during playback when playhead moves past visible boundary
  useEffect(() => {
    if (!view.isPlaying) return
    const element = scrollRef.current
    if (!element || viewportWidth <= 0) return

    const playheadPx = view.playheadMs * pixelsPerMs
    const currentScrollLeft = element.scrollLeft
    const rightEdge = currentScrollLeft + viewportWidth

    // If playhead moves past the right viewport boundary, page forward cleanly
    if (playheadPx >= rightEdge - 30) {
      const nextScroll = Math.max(0, playheadPx - 60)
      element.scrollLeft = nextScroll
      setScrollLeft(nextScroll)
      onSetScroll(nextScroll / pixelsPerMs)
    } else if (playheadPx < currentScrollLeft) {
      // If playhead has looped or jumped before current view, reset view to playhead
      const nextScroll = Math.max(0, playheadPx - 60)
      element.scrollLeft = nextScroll
      setScrollLeft(nextScroll)
      onSetScroll(nextScroll / pixelsPerMs)
    }
  }, [view.isPlaying, view.playheadMs, pixelsPerMs, viewportWidth, onSetScroll])

  const visibleStartMs = Math.max(0, scrollLeft / pixelsPerMs - 2_000)
  const visibleEndMs = Math.min(
    view.durationMs,
    visibleStartMs + Math.max(viewportWidth / pixelsPerMs, 1_000) + 4_000,
  )

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
    return Math.min(view.durationMs, Math.max(0, position / pixelsPerMs))
  }

  // Wheel handling: Ctrl+Wheel for zoom centered on cursor; Shift+Wheel for pan
  function handleWheel(e: React.WheelEvent<HTMLDivElement>) {
    if (e.ctrlKey || e.metaKey) {
      // Zoom centered on cursor position
      e.preventDefault()
      e.stopPropagation()
      if (!onSetZoom) return

      const delta = -e.deltaY * 0.05
      const newZoom = Math.max(0, Math.min(100, Math.round(view.zoom + delta)))
      if (newZoom === view.zoom) return

      const cursorTimeMs = timelineTimeFromClientX(e.clientX)
      onSetZoom(newZoom)

      // Keep cursor position stable after zoom
      requestAnimationFrame(() => {
        const element = scrollRef.current
        if (!element) return
        const bounds = element.getBoundingClientRect()
        const mouseX = e.clientX - bounds.left

        const effectiveWidth = Math.max(200, element.clientWidth)
        const base = view.durationMs > 0 ? effectiveWidth / view.durationMs : 0.05
        const maxMult = Math.max(25, 0.5 / Math.max(0.0001, base))
        const mult = newZoom === 0 ? 1 : Math.pow(maxMult, newZoom / 100)
        const nextPixelsPerMs = base * mult

        const targetScrollLeft = Math.max(0, cursorTimeMs * nextPixelsPerMs - mouseX)
        element.scrollLeft = targetScrollLeft
      })
      return
    }

    if (e.shiftKey) {
      // Horizontal pan
      e.preventDefault()
      const element = scrollRef.current
      if (element) {
        element.scrollLeft += e.deltaY || e.deltaX
      }
    }
  }

  function isInteractiveTarget(target: EventTarget | null): boolean {
    return (
      target instanceof Element &&
      Boolean(
        target.closest(
          "[data-timeline-clip], [data-timeline-marker], [data-timeline-zoom], [data-timeline-zoom-pill]",
        ),
      )
    )
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || isInteractiveTarget(e.target)) return
    const startMs = timelineTimeFromClientX(e.clientX)

    // Immediately seek playhead to clicked timestamp on empty space
    onSeek(startMs)

    if (tool === "split") {
      return
    }

    // Set up marquee in case user drags
    marqueePointerRef.current = { pointerId: e.pointerId, startMs, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (tool === "split") {
      const currentMs = timelineTimeFromClientX(e.clientX)
      setRazorHoverMs(currentMs)
    }

    const gesture = marqueePointerRef.current
    if (!gesture || gesture.pointerId !== e.pointerId) return

    const currentMs = timelineTimeFromClientX(e.clientX)
    if (Math.abs(currentMs - gesture.startMs) < 40 && !gesture.moved) return
    gesture.moved = true
    setMarquee({
      startMs: Math.min(gesture.startMs, currentMs),
      endMs: Math.max(gesture.startMs, currentMs),
    })
    e.preventDefault()
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const gesture = marqueePointerRef.current
    if (!gesture || gesture.pointerId !== e.pointerId) return

    if (gesture.moved) {
      const endMs = timelineTimeFromClientX(e.clientX)
      const minMs = Math.min(gesture.startMs, endMs)
      const maxMs = Math.max(gesture.startMs, endMs)

      if (tool === "range") {
        onSelectRange(minMs, maxMs)
      } else {
        // Select all clips intersecting the marquee
        const matchingClipIds: string[] = []
        let primaryClip: { id: string; trackId: string } | null = null

        for (const track of timeline.tracks) {
          for (const clip of track.clips) {
            if (clip.startMs <= maxMs && clip.startMs + clip.durationMs >= minMs) {
              matchingClipIds.push(clip.id)
              if (!primaryClip) primaryClip = { id: clip.id, trackId: track.id }
            }
          }
        }

        if (matchingClipIds.length > 0 && primaryClip && onSelectMultipleClips) {
          onSelectMultipleClips(matchingClipIds, primaryClip.id, primaryClip.trackId)
        }
      }
    }

    marqueePointerRef.current = null
    setMarquee(null)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  const thumbnailData = thumbnailResource.status === "content" ? thumbnailResource.data : null
  const spriteUrl = thumbnailData ? toAssetUrl(thumbnailData.spritePath) : null
  const snapTargets = useMemo(
    () => buildSnapTargets(timeline, { playheadMs: view.playheadMs, cursorClickTimesMs }),
    [timeline, view.playheadMs, cursorClickTimesMs],
  )

  const onSnapGuideCallback = useCallback((target: SnapTarget | null) => setSnapGuide(target), [])

  return (
    <div
      className="flex min-h-0 flex-1 select-none overflow-hidden"
      aria-label="Timeline editor tracks"
      onWheel={handleWheel}
    >
      {/* Left Column: Track Headers */}
      <div className="w-56 shrink-0 overflow-hidden border-r border-border bg-surface shadow-e1 z-20">
        {/* Top Header Placeholder corresponding to Ruler Height */}
        <div className="flex h-13 flex-col justify-center border-b border-border/80 bg-surface-dim/95 px-3">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            Tracks & Layers
          </span>
          <span className="text-[9px] text-subtle-foreground font-mono">
            {timeline.tracks.length} active tracks
          </span>
        </div>

        {/* Scrollable Track Header Cards */}
        <div
          className="relative overflow-hidden"
          style={{ height: `${Math.max(0, viewportHeight - scrollMargin)}px` }}
        >
          <div
            className="relative"
            style={{
              height: `${totalTrackHeight}px`,
              transform: `translateY(${-scrollTop}px)`,
            }}
          >
            {visibleTrackRows.map(({ track, virtualTrack }) => {
              if (!track) return null
              return (
                <TimelineTrackHeader
                  key={track.id}
                  track={track}
                  selected={
                    track.clips.some((clip) => selectedClipIds.has(clip.id)) ||
                    (track.kind === "zoom" && selectedZoomId !== null)
                  }
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

      {/* Right Column: Scrollable Ruler & Tracks Area */}
      <div
        ref={scrollRef}
        className="min-w-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
        onScroll={handleScroll}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={() => setRazorHoverMs(null)}
        onKeyDown={(e) => {
          if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault()
            onDeleteSelection(e.shiftKey)
          }
        }}
        tabIndex={0}
        role="region"
        aria-label="Timeline lanes and playhead"
      >
        <div
          className="relative bg-surface-dim/40"
          style={{
            width: `${timelineWidth}px`,
            height: `${Math.max(contentHeight, viewportHeight)}px`,
          }}
        >
          {/* Preload sprite image */}
          {spriteUrl ? (
            <img
              src={spriteUrl}
              alt=""
              aria-hidden
              className="pointer-events-none absolute size-px opacity-0"
              onError={onSpriteError}
            />
          ) : null}

          {/* Sticky Time Ruler & Markers Lane */}
          <TimelineRuler
            timelineWidth={timelineWidth}
            pixelsPerMs={pixelsPerMs}
            visibleStartMs={visibleStartMs}
            visibleEndMs={visibleEndMs}
            durationMs={view.durationMs}
            tickInterval={tickInterval}
            markers={timeline.markers}
            selectedMarkerId={selectedMarkerId}
            zoomSegments={timeline.zoomSegments}
            selectedZoomId={selectedZoomId}
            isPlaying={view.isPlaying}
            getTimelineTime={timelineTimeFromClientX}
            onSeek={onSeek}
            onPause={onPause}
            onSelectMarker={onSelectMarker}
            onDeleteMarker={onDeleteMarker ?? (() => {})}
            onAddMarkerAtTime={onAddMarkerAtTime ?? (() => {})}
            onSelectZoom={onSelectZoom}
          />

          {/* Range Selection / Marquee Overlay */}
          {(() => {
            const range = marquee ?? (view.selection?.kind === "range" ? view.selection : null)
            if (!range) return null
            return (
              <TimelineMarquee
                startMs={range.startMs}
                endMs={range.endMs}
                pixelsPerMs={pixelsPerMs}
                top={scrollMargin}
              />
            )
          })()}

          {/* Magnetic Snapping Guide Line */}
          {snapGuide ? (
            <div
              className="pointer-events-none absolute inset-y-0 z-30 w-px bg-primary shadow-[0_0_8px_rgba(9,77,178,0.9)]"
              style={{ left: `${snapGuide.timeMs * pixelsPerMs}px` }}
              aria-hidden
            />
          ) : null}

          {/* Razor Tool Hover Indicator */}
          {tool === "split" && razorHoverMs !== null ? (
            <div
              className="pointer-events-none absolute inset-y-0 z-30 flex flex-col items-center -translate-x-1/2"
              style={{ left: `${razorHoverMs * pixelsPerMs}px` }}
            >
              <div className="rounded bg-destructive p-1 text-white shadow-e2">
                <Scissors className="size-3" />
              </div>
              <div className="h-full w-px bg-destructive shadow-[0_0_6px_rgba(239,68,68,0.8)]" />
            </div>
          ) : null}

          {/* Playhead Needle */}
          <TimelinePlayhead
            playheadMs={view.playheadMs}
            pixelsPerMs={pixelsPerMs}
            timelineHeight={contentHeight}
            isPlaying={view.isPlaying}
            getTimelineTime={timelineTimeFromClientX}
            onSeek={onSeek}
            onPause={onPause}
          />

          {/* Virtualized Track Rows */}
          {visibleTrackRows.map(({ track, virtualTrack }) => {
            if (!track) return null

            if (track.kind === "zoom") {
              return (
                <ZoomTrackRow
                  key={track.id}
                  timeline={timeline}
                  track={track}
                  top={virtualTrack.start}
                  height={virtualTrack.size}
                  visibleStartMs={visibleStartMs}
                  visibleEndMs={visibleEndMs}
                  pixelsPerMs={pixelsPerMs}
                  selectedZoomId={selectedZoomId}
                  snapEnabled={view.snapEnabled}
                  snapThresholdMs={view.snapThresholdMs}
                  playheadMs={view.playheadMs}
                  cursorClickTimesMs={cursorClickTimesMs}
                  getTimelineTime={timelineTimeFromClientX}
                  onSelectZoom={onSelectZoom}
                  onZoomSegmentAction={onZoomSegmentAction}
                  onMoveZoomSegment={onMoveZoomSegment}
                  onResizeZoomSegment={onResizeZoomSegment}
                />
              )
            }

            const visibleClips = track.clips.filter((clip) =>
              clipIntersectsWindow(clip, visibleStartMs, visibleEndMs),
            )

            const isCameraTrack = track.kind === "camera"
            const isScreenTrack = track.kind === "screen"

            let trackThumbnailData: ThumbnailManifest | null = null
            let trackSpriteUrl: string | null = null

            if (isScreenTrack) {
              trackThumbnailData = thumbnailData
              trackSpriteUrl = spriteUrl
            } else if (isCameraTrack && videoThumbnailResources) {
              const cameraStreamThumb = Array.from(videoThumbnailResources.byStream.values()).find(
                (r) => r.status === "content",
              )
              if (cameraStreamThumb && cameraStreamThumb.status === "content") {
                trackThumbnailData = cameraStreamThumb.data
                trackSpriteUrl = toAssetUrl(cameraStreamThumb.data.spritePath)
              }
            }

            return (
              <div
                key={track.id}
                className="absolute inset-x-0 flex items-center border-b border-border/70"
                style={{ top: virtualTrack.start, height: virtualTrack.size }}
              >
                {visibleClips.map((clip) => (
                  <TimelineClipItem
                    key={clip.id}
                    clip={clip}
                    track={track}
                    height={virtualTrack.size}
                    pixelsPerMs={pixelsPerMs}
                    selected={selectedClipIds.has(clip.id)}
                    frameMs={Math.max(1, Math.round(1000 / Math.max(1, timeline.canvas.fps)))}
                    collapsed={view.collapsedTrackIds.includes(track.id)}
                    thumbnailManifest={trackThumbnailData}
                    spriteUrl={trackSpriteUrl}
                    visibleStartMs={visibleStartMs}
                    visibleEndMs={visibleEndMs}
                    waveformResources={waveformResources}
                    snapTargets={snapTargets}
                    snapEnabled={view.snapEnabled}
                    snapThresholdMs={view.snapThresholdMs}
                    onSelectClip={onSelectClip}
                    onMoveClip={onMoveClip}
                    onTrimClip={onTrimClip}
                    getTimelineTime={timelineTimeFromClientX}
                    onSnapGuide={onSnapGuideCallback}
                    onSpriteError={onSpriteError}
                    onDuplicateClip={onDuplicateClip}
                    onSplitClip={onSplitClip}
                    onDeleteClip={onDeleteClip}
                    onCursorRangeAction={onCursorRangeAction}
                  />
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export { getVisibleTickInterval }
