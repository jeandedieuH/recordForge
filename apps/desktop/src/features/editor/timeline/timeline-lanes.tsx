import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import type {
  AudioClip,
  AudioVolumeKeyframe,
  CursorSmoothing,
  ManualZoomSegment,
  TimelineClip,
  TimelineMarker,
  TimelineState,
  TimelineTrack,
  TimelineViewState,
  ZoomPreset,
} from "@recordforge/contracts"
import {
  buildSnapTargets,
  getClipGroupId,
  snapTime,
  trackAllowsOverlap,
  type SnapTarget,
} from "@recordforge/editor-core"
import { BookmarkPlus, Scissors, Sparkles, Trash2, X, ZoomIn } from "lucide-react"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  cn,
} from "@recordforge/ui"
import type {
  DerivativeResource,
  ThumbnailManifest,
  VideoTrackThumbnailResources,
  WaveformResources,
} from "../media/derivative-resources"
import { toAssetUrl } from "../media/derivative-resources"
import { TimelineMarquee } from "./timeline-marquee"
import { SilencePreviewLayer } from "./silence-preview-layer"
import { TimelineMinimap } from "./timeline-minimap"
import { TimelinePlayhead } from "./timeline-playhead"
import { TimelineRuler, formatTimelineTime, getVisibleTickInterval } from "./timeline-ruler"
import { TimelineSnapBadge } from "./timeline-snap-badge"
import { TimelineTrackHeader } from "./timeline-track-header"
import type { TimelineTool } from "./timeline-toolbar"
import { ZoomTrackRow } from "./zoom-track"
import { useEdgeAutoScroll } from "./lanes/use-edge-auto-scroll"
import { TimelineHoverLine, type TimelineHoverLineHandle } from "./lanes/timeline-hover-line"
import { TimelineGestureOverlay, type TimelineGestureInfo } from "./lanes/timeline-gesture-overlay"
import { TimelineLaneRow } from "./lanes/timeline-lane-row"
import { getClipLaneTheme, getTrackLaneTheme, laneStyle } from "./lanes/lane-theme"
import { computeClipRuns, type ClipRuns } from "./lanes/timeline-clip-runs"
import { getPlayheadSnapshot, subscribeToPlayhead, usePlayheadMs } from "./use-playback-state"
import { useTimelineStore } from "../../../stores/timeline-store"

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
  kind:
    | "select"
    | "toggle-enabled"
    | "toggle-lock"
    | "split"
    | "delete"
    | "ripple-delete"
    | "regenerate-from-click"
  segmentId: string
}

export interface TimelineLanesProps {
  timeline: TimelineState
  // playheadMs is intentionally absent: the parent view no longer subscribes
  // to it, so reading it here would see a stale snapshot. Playhead-driven
  // lanes subscribe via usePlayheadMs or read getPlayheadSnapshot().
  view: Omit<TimelineViewState, "playheadMs">
  tool?: TimelineTool
  timelineWidth?: number
  pixelsPerMs?: number
  tickInterval?: number
  cursorClickTimesMs?: number[]
  thumbnailResource: DerivativeResource<ThumbnailManifest>
  videoThumbnailResources?: VideoTrackThumbnailResources
  waveformResources: WaveformResources
  workDir?: string | null
  onSeek: (ms: number) => void
  onPause?: () => void
  onSetScroll: (ms: number) => void
  onSetZoom?: (zoom: number) => void
  onSelectClip: (clip: TimelineClip, track: TimelineTrack, event: React.MouseEvent) => void
  onSelectMultipleClips?: (
    clipIds: string[],
    primaryClipId: string,
    trackId: string,
    options?: { additive?: boolean; expandGroups?: boolean },
  ) => void
  onSelectRange: (startMs: number, endMs: number) => void
  onSelectTrackClips?: (track: TimelineTrack) => void
  onGroupClips?: () => void
  onUngroupClips?: () => void
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
  onMoveMarker?: (marker: TimelineMarker, timeMs: number) => void
  onRenameMarker?: (marker: TimelineMarker, label: string) => void
  onSelectZoom: (segmentId: string) => void
  onAddZoomAtTime?: (
    timeMs: number,
    options?: { preset?: ZoomPreset; scale?: number; endMs?: number },
  ) => void
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
  onSetTrackHeight?: (track: TimelineTrack, height: number) => void
  // Source media duration — lets trims clamp at the real end of media.
  sourceDurationMs?: number
  onRenameTrack?: (track: TimelineTrack, name: string) => void
  onMoveTrack?: (trackId: string, newIndex: number) => void
  onUpdateClipAudio?: (
    clip: AudioClip,
    update: {
      volume?: number
      fadeInMs?: number
      fadeOutMs?: number
      volumeKeyframes?: AudioVolumeKeyframe[]
    },
  ) => void
  onSpriteError: () => void
  onDuplicateClip: (clip: TimelineClip) => void
  onSplitClip: (clip: TimelineClip, splitTimeMs?: number) => void
  onDeleteClip: (clip: TimelineClip, ripple?: boolean) => void
  onAddAssetAtTime?: (assetId: string, timeMs: number) => void
  onCursorRangeAction?: (action: CursorRangeAction) => void
  onZoomSegmentAction?: (action: ZoomSegmentAction) => void
  showMinimap?: boolean
  onRippleDeleteRange?: (startMs: number, endMs: number) => void
  onSplitAllAtTime?: (timeMs: number) => void
  onSplitAllAtPlayhead?: () => void
  onDeselectAll?: () => void
}

function clipIntersectsWindow(clip: TimelineClip, startMs: number, endMs: number): boolean {
  const clipEndMs = clip.startMs + clip.durationMs
  return clipEndMs >= startMs && clip.startMs <= endMs
}

function getTrackHeight(
  track: TimelineTrack,
  view: Pick<TimelineViewState, "collapsedTrackIds" | "trackHeights">,
): number {
  if (view.collapsedTrackIds.includes(track.id)) return COLLAPSED_TRACK_HEIGHT
  return view.trackHeights[track.id] ?? TRACK_ROW_HEIGHT
}

// Re-exported from the lanes module so existing tests/imports keep working;
// overlap-lane rows consume it via TimelineLaneRow.
export { computeClipSublanes } from "./lanes/timeline-clip-runs"

export function TimelineLanes({
  timeline,
  view,
  tool = "select",
  showMinimap = true,
  timelineWidth: propTimelineWidth,
  pixelsPerMs: propPixelsPerMs,
  tickInterval: propTickInterval,
  cursorClickTimesMs = [],
  thumbnailResource,
  videoThumbnailResources,
  waveformResources,
  workDir,
  onSeek,
  onPause,
  onSetScroll,
  onSetZoom,
  onSelectClip,
  onSelectMultipleClips,
  onSelectRange,
  onSelectTrackClips,
  onGroupClips,
  onUngroupClips,
  onMoveClip,
  onTrimClip,
  onSelectMarker,
  onDeleteMarker,
  onAddMarkerAtTime,
  onMoveMarker,
  onRenameMarker,
  onSelectZoom,
  onAddZoomAtTime,
  onDeleteSelection,
  onToggleTrackMuted,
  onToggleTrackSolo,
  onToggleTrackLocked,
  onToggleTrackCollapsed,
  onCycleTrackHeight,
  onSetTrackHeight,
  sourceDurationMs,
  onRenameTrack,
  onMoveTrack,
  onUpdateClipAudio,
  onSpriteError,
  onDuplicateClip,
  onSplitClip,
  onDeleteClip,
  onAddAssetAtTime,
  onCursorRangeAction,
  onZoomSegmentAction,
  onMoveZoomSegment,
  onResizeZoomSegment,
  onRippleDeleteRange,
  onSplitAllAtTime,
  onSplitAllAtPlayhead,
  onDeselectAll,
}: TimelineLanesProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  const [marquee, setMarquee] = useState<{
    startMs: number
    endMs: number
    topPx: number
    bottomPx: number
  } | null>(null)
  const [snapGuide, setSnapGuide] = useState<SnapTarget | null>(null)
  // Lanes-level gesture HUD — clips report their live move/trim geometry here
  // instead of rendering (and clipping) a per-clip pill.
  const [gestureInfo, setGestureInfo] = useState<TimelineGestureInfo | null>(null)
  const onGestureHud = useCallback((info: TimelineGestureInfo | null) => setGestureInfo(info), [])
  const edgeAutoScroll = useEdgeAutoScroll(scrollRef)
  const hoverLineRef = useRef<TimelineHoverLineHandle>(null)
  const razorLineRef = useRef<TimelineHoverLineHandle>(null)

  const marqueePointerRef = useRef<{
    pointerId: number
    startMs: number
    startContentY: number
    moved: boolean
  } | null>(null)
  const lastMarqueePointerRef = useRef<{ clientX: number; clientY: number } | null>(null)

  const selectedClipIds = new Set(view.selection?.kind === "clip" ? view.selection.clipIds : [])
  const selectedMarkerId = view.selection?.kind === "marker" ? view.selection.markerId : null
  const selectedZoomId = view.selection?.kind === "zoom" ? view.selection.segmentId : null

  const selectionCanGroup = selectedClipIds.size >= 2
  const selectionHasGroup = useMemo(() => {
    if (view.selection?.kind !== "clip") return false
    const ids = new Set(view.selection.clipIds)
    return timeline.tracks.some((track) =>
      track.clips.some((clip) => ids.has(clip.id) && getClipGroupId(clip) !== undefined),
    )
  }, [timeline.tracks, view.selection])

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

  const prevPlayheadMsRef = useRef(getPlayheadSnapshot())

  // Auto-scroll is imperative: subscribing directly to playhead ticks avoids
  // re-rendering the whole lanes tree on every video frame just to update
  // scrollLeft on the DOM element.
  useEffect(() => {
    const element = scrollRef.current
    if (!element || viewportWidth <= 0) return

    return subscribeToPlayhead(() => {
      const state = useTimelineStore.getState().view
      const playheadPx = state.playheadMs * pixelsPerMs
      const currentScrollLeft = element.scrollLeft
      const rightEdge = currentScrollLeft + viewportWidth

      if (state.isPlaying) {
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
        prevPlayheadMsRef.current = state.playheadMs
      } else {
        // While paused: if playhead changed and moved outside the visible viewport (or within edge padding),
        // scroll to keep playhead comfortably visible
        const prevPlayhead = prevPlayheadMsRef.current
        if (prevPlayhead !== state.playheadMs) {
          prevPlayheadMsRef.current = state.playheadMs
          const edgePadding = 24
          if (
            playheadPx < currentScrollLeft + edgePadding ||
            playheadPx > rightEdge - edgePadding
          ) {
            const prevPlayheadPx = prevPlayhead * pixelsPerMs
            const isLargeJump = Math.abs(playheadPx - prevPlayheadPx) > viewportWidth * 0.4
            // Center the playhead for large jumps (cuts, markers, timecodes); otherwise keep in view with padding
            const nextScroll = isLargeJump
              ? Math.max(0, Math.round(playheadPx - viewportWidth / 2))
              : playheadPx > rightEdge - edgePadding
                ? Math.max(0, Math.round(playheadPx - viewportWidth + 80))
                : Math.max(0, Math.round(playheadPx - 80))

            element.scrollLeft = nextScroll
            setScrollLeft(nextScroll)
            onSetScroll(nextScroll / pixelsPerMs)
          }
        }
      }
    })
  }, [pixelsPerMs, viewportWidth, onSetScroll])

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

  // Track row bounds in content coordinates (0 = top of the ruler). The 2D
  // marquee hit-tests these so a horizontal drag only grabs clips on the rows
  // the box actually covers.
  const trackRowBounds = useMemo(() => {
    let top = scrollMargin
    return timeline.tracks.map((track) => {
      const height = getTrackHeight(track, view)
      const row = { trackId: track.id, top, bottom: top + height }
      top += height
      return row
    })
  }, [timeline.tracks, view, scrollMargin])

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

  // Vertical counterpart to timelineTimeFromClientX: client Y mapped into the
  // scroll content's coordinate space (0 = ruler top, tracks start at scrollMargin).
  function timelineContentYFromClientY(clientY: number): number {
    const element = scrollRef.current
    if (!element) return 0
    const bounds = element.getBoundingClientRect()
    return clientY - bounds.top + element.scrollTop
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

  function isMenuTarget(target: EventTarget | null): boolean {
    return (
      target instanceof Element &&
      Boolean(
        target.closest(
          "[role='menu'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [data-radix-menu-content], [data-radix-popper-content-wrapper], [data-radix-collection-item]",
        ),
      )
    )
  }

  function isInteractiveTarget(target: EventTarget | null): boolean {
    return (
      target instanceof Element &&
      Boolean(
        target.closest(
          "[data-timeline-ruler], [data-timeline-playhead], [data-minimap-lens], [role='slider'], [data-timeline-clip], [data-timeline-marker], [data-timeline-zoom], [data-timeline-zoom-pill], [role='menu'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [data-radix-menu-content], [data-radix-popper-content-wrapper], [data-radix-collection-item]",
        ),
      )
    )
  }

  const lastPointerDownRef = useRef<{
    clientX: number
    clientY: number
    timeMs: number
    timestamp: number
  } | null>(null)

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || isMenuTarget(e.target)) return

    if (tool === "split") {
      const rawMs = timelineTimeFromClientX(e.clientX)
      const snap = snapTime(rawMs, snapTargets, {
        enabled: view.snapEnabled && !e.altKey,
        thresholdMs: view.snapThresholdMs,
      })
      let splitTimeMs = snap.snapped ? snap.timeMs : Math.round(rawMs)
      if (snap.snapped) {
        // If snap aligned with an edge/point where no clip can be split,
        // fall back to rawMs so the user can split where they clicked
        const canSplitAtSnap =
          timeline.tracks.some(
            (t) =>
              !t.locked &&
              t.clips.some(
                (c) =>
                  !("locked" in c && Boolean(c.locked)) &&
                  snap.timeMs > c.startMs + 1 &&
                  snap.timeMs < c.startMs + c.durationMs - 1,
              ),
          ) ||
          Boolean(
            timeline.zoomSegments?.some(
              (z) =>
                !z.locked &&
                snap.timeMs > z.startMs + 1 &&
                snap.timeMs < z.startMs + z.durationMs - 1,
            ),
          )
        if (!canSplitAtSnap) {
          splitTimeMs = Math.round(rawMs)
        }
      }
      onSeek(splitTimeMs)
      onSplitAllAtTime?.(splitTimeMs)
      return
    }

    if (isInteractiveTarget(e.target)) return
    const startMs = timelineTimeFromClientX(e.clientX)

    const now = Date.now()
    const last = lastPointerDownRef.current
    if (
      last &&
      now - last.timestamp < 350 &&
      Math.abs(e.clientX - last.clientX) < 15 &&
      Math.abs(e.clientY - last.clientY) < 15
    ) {
      lastPointerDownRef.current = null
      marqueePointerRef.current = null
      onAddZoomAtTime?.(startMs)
      return
    }
    lastPointerDownRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      timeMs: startMs,
      timestamp: now,
    }

    // Immediately seek playhead to clicked timestamp on empty space (with magnetic snap when enabled)
    let targetSeekMs = startMs
    if (view.snapEnabled && !e.altKey) {
      const snap = snapTime(startMs, snapTargets, {
        enabled: true,
        thresholdMs: view.snapThresholdMs,
      })
      if (snap.snapped) {
        targetSeekMs = snap.timeMs
        onSnapGuideCallback(snap.target)
      }
    }
    onSeek(targetSeekMs)
    // Shift-held drags extend the selection instead of replacing it, so the
    // current selection must survive the pointer-down.
    if (!e.shiftKey) onDeselectAll?.()

    // Set up marquee in case user drags
    marqueePointerRef.current = {
      pointerId: e.pointerId,
      startMs,
      startContentY: timelineContentYFromClientY(e.clientY),
      moved: false,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function handleLanesDoubleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (tool === "split" || isInteractiveTarget(e.target)) return
    const startMs = timelineTimeFromClientX(e.clientX)
    onAddZoomAtTime?.(startMs)
  }

  // Marquee geometry from a pointer position — also driven by the edge
  // auto-scroll loop while a marquee drag hugs the viewport edge.
  function updateMarqueeFromPointer(clientX: number, clientY: number) {
    const gesture = marqueePointerRef.current
    if (!gesture) return
    const currentMs = timelineTimeFromClientX(clientX)
    const currentContentY = timelineContentYFromClientY(clientY)
    if (
      Math.abs(currentMs - gesture.startMs) < 40 &&
      Math.abs(currentContentY - gesture.startContentY) < 8 &&
      !gesture.moved
    )
      return
    gesture.moved = true
    // Clamp the box to the track region so it never paints over the ruler.
    const topPx = Math.max(scrollMargin, Math.min(gesture.startContentY, currentContentY))
    const bottomPx = Math.min(contentHeight, Math.max(gesture.startContentY, currentContentY))
    setMarquee({
      startMs: Math.min(gesture.startMs, currentMs),
      endMs: Math.max(gesture.startMs, currentMs),
      topPx,
      bottomPx,
    })
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (tool === "split") {
      const rawMs = timelineTimeFromClientX(e.clientX)
      const snap = snapTime(rawMs, snapTargets, {
        enabled: view.snapEnabled && !e.altKey,
        thresholdMs: view.snapThresholdMs,
      })
      const currentMs = snap.snapped ? snap.timeMs : Math.round(rawMs)
      razorLineRef.current?.show(currentMs)
      hoverLineRef.current?.hide()
      onSnapGuideCallback(snap.snapped ? snap.target : null)
    } else if (e.buttons === 0) {
      // Scrub line follows a hovering pointer; hidden while any button is
      // held so it never fights a drag gesture.
      razorLineRef.current?.hide()
      hoverLineRef.current?.show(timelineTimeFromClientX(e.clientX))
    } else {
      razorLineRef.current?.hide()
      hoverLineRef.current?.hide()
    }

    const gesture = marqueePointerRef.current
    if (!gesture || gesture.pointerId !== e.pointerId) return
    lastMarqueePointerRef.current = { clientX: e.clientX, clientY: e.clientY }
    updateMarqueeFromPointer(e.clientX, e.clientY)
    edgeAutoScroll.track(e.clientX, () => {
      const last = lastMarqueePointerRef.current
      if (last) updateMarqueeFromPointer(last.clientX, last.clientY)
    })
    if (gesture.moved) e.preventDefault()
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
        // 2D marquee: only clips on rows the box vertically covers are hit.
        const topPx = Math.max(
          scrollMargin,
          Math.min(gesture.startContentY, timelineContentYFromClientY(e.clientY)),
        )
        const bottomPx = Math.min(
          contentHeight,
          Math.max(gesture.startContentY, timelineContentYFromClientY(e.clientY)),
        )
        const coveredTrackIds = new Set(
          trackRowBounds
            .filter((row) => row.bottom > topPx && row.top < bottomPx)
            .map((row) => row.trackId),
        )

        const matchingClipIds: string[] = []
        let primaryClip: { id: string; trackId: string } | null = null

        for (const track of timeline.tracks) {
          if (!coveredTrackIds.has(track.id)) continue
          for (const clip of track.clips) {
            if (clip.startMs <= maxMs && clip.startMs + clip.durationMs >= minMs) {
              matchingClipIds.push(clip.id)
              if (!primaryClip) primaryClip = { id: clip.id, trackId: track.id }
            }
          }
        }

        if (matchingClipIds.length > 0 && primaryClip && onSelectMultipleClips) {
          // Shift adds to the current selection; Alt skips group expansion so
          // a marquee can isolate individual clips out of a group.
          onSelectMultipleClips(matchingClipIds, primaryClip.id, primaryClip.trackId, {
            additive: e.shiftKey,
            expandGroups: !e.altKey,
          })
        } else if (matchingClipIds.length === 0 && !e.shiftKey && onDeselectAll) {
          onDeselectAll()
        }
      }
    }

    marqueePointerRef.current = null
    lastMarqueePointerRef.current = null
    edgeAutoScroll.stop()
    setMarquee(null)
    onSnapGuideCallback(null)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  function handleAssetDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("application/x-recordforge-asset")) return
    event.preventDefault()
    event.dataTransfer.dropEffect = "copy"
  }

  function handleAssetDrop(event: React.DragEvent<HTMLDivElement>) {
    const assetId = event.dataTransfer.getData("application/x-recordforge-asset")
    if (!assetId || !onAddAssetAtTime) return
    event.preventDefault()
    onAddAssetAtTime(assetId, timelineTimeFromClientX(event.clientX))
  }

  const thumbnailData = thumbnailResource.status === "content" ? thumbnailResource.data : null
  const spriteUrl = thumbnailData ? toAssetUrl(thumbnailData.spritePath, workDir) : null
  // Snap targets exclude the live playhead so playback ticks don't rebuild
  // the list; gesture consumers append it via playheadSnapTarget at
  // pointer-down.
  const snapTargets = useMemo(
    () => buildSnapTargets(timeline, { cursorClickTimesMs }),
    [timeline, cursorClickTimesMs],
  )

  // Identity-stable guard: pointermove fires per pixel but the snap target
  // rarely changes — skip the state write (and the lanes re-render) when it
  // resolves to the same target.
  const onSnapGuideCallback = useCallback((target: SnapTarget | null) => {
    setSnapGuide((prev) =>
      prev?.id === target?.id && prev?.timeMs === target?.timeMs ? prev : target,
    )
  }, [])

  // Seamless-strip run layout per non-overlap lane; overlap lanes keep
  // sub-lane stacking instead (handled inside the row).
  const laneLayouts = useMemo(() => {
    const map = new Map<string, ClipRuns | null>()
    for (const track of timeline.tracks) {
      map.set(
        track.id,
        trackAllowsOverlap(track) ? null : computeClipRuns(track.clips, pixelsPerMs),
      )
    }
    return map
  }, [timeline.tracks, pixelsPerMs])

  // When any audio lane is soloed, the others visually dim like a mixer.
  const anySoloAudio = useMemo(
    () => timeline.tracks.some((t) => t.kind === "audio" && t.solo),
    [timeline.tracks],
  )

  const [emptyLanesContextMenuTimeMs, setEmptyLanesContextMenuTimeMs] = useState<number | null>(
    null,
  )

  const screenGaps = useMemo(() => {
    const screenTrack = timeline.tracks.find((t) => t.kind === "screen")
    if (!screenTrack || screenTrack.clips.length < 2) return []
    const sortedClips = [...screenTrack.clips].sort((a, b) => a.startMs - b.startMs)
    const gaps: Array<{ startMs: number; endMs: number }> = []
    for (let i = 0; i < sortedClips.length - 1; i++) {
      const currentClip = sortedClips[i]
      const nextClip = sortedClips[i + 1]
      if (!currentClip || !nextClip) continue
      const currentEnd = currentClip.startMs + currentClip.durationMs
      const nextStart = nextClip.startMs
      if (nextStart - currentEnd > 100) {
        gaps.push({ startMs: currentEnd, endMs: nextStart })
      }
    }
    return gaps
  }, [timeline.tracks])

  const trackHeadersContainerRef = useRef<HTMLDivElement>(null)
  const [reorderingTrack, setReorderingTrack] = useState<{
    trackId: string
    startY: number
    currentY: number
    targetIndex: number
  } | null>(null)

  const handleStartReorder = useCallback(
    (track: TimelineTrack, startY: number) => {
      const currentIndex = timeline.tracks.findIndex((t) => t.id === track.id)
      setReorderingTrack({
        trackId: track.id,
        startY,
        currentY: startY,
        targetIndex: currentIndex,
      })
    },
    [timeline.tracks],
  )

  useEffect(() => {
    if (!reorderingTrack) return

    function onPointerMove(e: PointerEvent) {
      if (!reorderingTrack) return
      const headersEl = trackHeadersContainerRef.current
      if (!headersEl) return
      const rect = headersEl.getBoundingClientRect()
      const relY = e.clientY - rect.top + scrollTop
      let closestIndex = 0
      let minDiff = Infinity
      virtualTracks.forEach((vt, idx) => {
        const center = vt.start - scrollMargin + vt.size / 2
        const diff = Math.abs(relY - center)
        if (diff < minDiff) {
          minDiff = diff
          closestIndex = idx
        }
      })
      const clampedIndex = Math.max(0, Math.min(timeline.tracks.length - 1, closestIndex))
      setReorderingTrack((prev) =>
        prev ? { ...prev, currentY: e.clientY, targetIndex: clampedIndex } : null,
      )
    }

    function onPointerUp() {
      if (reorderingTrack && onMoveTrack) {
        const currentIndex = timeline.tracks.findIndex((t) => t.id === reorderingTrack.trackId)
        if (currentIndex !== -1 && currentIndex !== reorderingTrack.targetIndex) {
          onMoveTrack(reorderingTrack.trackId, reorderingTrack.targetIndex)
        }
      }
      setReorderingTrack(null)
    }

    window.addEventListener("pointermove", onPointerMove)
    window.addEventListener("pointerup", onPointerUp)
    window.addEventListener("pointercancel", onPointerUp)

    return () => {
      window.removeEventListener("pointermove", onPointerMove)
      window.removeEventListener("pointerup", onPointerUp)
      window.removeEventListener("pointercancel", onPointerUp)
    }
  }, [reorderingTrack, onMoveTrack, timeline.tracks, scrollTop, scrollMargin, virtualTracks])

  const handleMoveTrackDelta = useCallback(
    (track: TimelineTrack, delta: -1 | 1) => {
      const currentIndex = timeline.tracks.findIndex((t) => t.id === track.id)
      if (currentIndex === -1 || !onMoveTrack) return
      const newIndex = Math.max(0, Math.min(timeline.tracks.length - 1, currentIndex + delta))
      if (newIndex !== currentIndex) {
        onMoveTrack(track.id, newIndex)
      }
    },
    [timeline.tracks, onMoveTrack],
  )

  return (
    <div
      className="flex min-h-0 flex-1 flex-col select-none overflow-hidden"
      aria-label="Timeline editor tracks"
      onWheel={handleWheel}
    >
      {/* Overview Minimap */}
      {showMinimap ? (
        <TimelineMinimap
          timeline={timeline}
          durationMs={view.durationMs}
          visibleStartMs={visibleStartMs}
          visibleEndMs={visibleEndMs}
          onSeek={onSeek}
          onSetScrollMs={(scrollMs) => onSetScroll(scrollMs)}
        />
      ) : null}

      <div className="flex min-h-0 flex-1 select-none overflow-hidden">
        {/* Left Column: Track Headers */}
        <div className="w-48 shrink-0 overflow-hidden border-r border-border bg-surface shadow-e1 z-20">
          {/* Top Header Placeholder corresponding to Ruler Height */}
          <div className="flex h-13 items-center justify-between border-b border-border/80 bg-surface-dim/95 px-3">
            <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              Tracks
            </span>
            <span className="rounded-full bg-surface-container-high px-1.5 py-px font-mono text-[9px] text-subtle-foreground">
              {timeline.tracks.length}
            </span>
          </div>

          {/* Scrollable Track Header Cards */}
          <div
            ref={trackHeadersContainerRef}
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
                const isDraggingThisTrack = reorderingTrack?.trackId === track.id
                const isTargetTrack = Boolean(
                  reorderingTrack &&
                  !isDraggingThisTrack &&
                  virtualTrack.index === reorderingTrack.targetIndex,
                )
                const originalIndex = reorderingTrack
                  ? timeline.tracks.findIndex((t) => t.id === reorderingTrack.trackId)
                  : -1
                const dropIndicator = isTargetTrack
                  ? reorderingTrack && reorderingTrack.targetIndex <= originalIndex
                    ? "above"
                    : "below"
                  : null

                return (
                  <TimelineTrackHeader
                    key={track.id}
                    track={track}
                    trackIndex={virtualTrack.index}
                    totalTracks={timeline.tracks.length}
                    isDragging={isDraggingThisTrack}
                    dropIndicator={dropIndicator}
                    onStartReorder={onMoveTrack ? handleStartReorder : undefined}
                    onMoveTrackDelta={onMoveTrack ? handleMoveTrackDelta : undefined}
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
                    onSetTrackHeight={onSetTrackHeight}
                    onRenameTrack={onRenameTrack}
                    onSelectTrackClips={onSelectTrackClips}
                  />
                )
              })}
            </div>
          </div>
        </div>

        {/* Right Column: Scrollable Ruler & Tracks Area */}
        <div
          ref={scrollRef}
          className={cn(
            "min-w-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
            tool === "split" && "cursor-crosshair",
          )}
          onScroll={handleScroll}
          onPointerDown={handlePointerDown}
          onDoubleClick={handleLanesDoubleClick}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={() => {
            razorLineRef.current?.hide()
            hoverLineRef.current?.hide()
            onSnapGuideCallback(null)
          }}
          onDragOver={handleAssetDragOver}
          onDrop={handleAssetDrop}
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
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                className="relative bg-surface-dim/40"
                style={{
                  width: `${timelineWidth}px`,
                  height: `${Math.max(contentHeight, viewportHeight)}px`,
                }}
                onDoubleClick={handleLanesDoubleClick}
                onContextMenu={(e) => {
                  if (isInteractiveTarget(e.target)) return
                  const timeMs = timelineTimeFromClientX(e.clientX)
                  setEmptyLanesContextMenuTimeMs(Math.round(timeMs))
                }}
              >
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
                  onMoveMarker={onMoveMarker}
                  onRenameMarker={onRenameMarker}
                  snapTargets={snapTargets}
                  snapEnabled={view.snapEnabled}
                  snapThresholdMs={view.snapThresholdMs}
                  onSnapGuide={onSnapGuideCallback}
                  onSelectZoom={onSelectZoom}
                  onDeselectAll={onDeselectAll}
                />

                {/* Range Selection / Marquee Overlay */}
                {(() => {
                  // An in-progress select-tool marquee carries real 2D bounds;
                  // persisted range selections and range-tool drags stay
                  // full-height so they read as a whole-timeline range.
                  if (marquee) {
                    const bounded = tool === "select"
                    return (
                      <TimelineMarquee
                        startMs={marquee.startMs}
                        endMs={marquee.endMs}
                        pixelsPerMs={pixelsPerMs}
                        top={bounded ? marquee.topPx : scrollMargin}
                        height={bounded ? Math.max(4, marquee.bottomPx - marquee.topPx) : undefined}
                      />
                    )
                  }
                  const range = view.selection?.kind === "range" ? view.selection : null
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

                {/* Smart Cut review: detected silences shaded across lanes */}
                <SilencePreviewLayer pixelsPerMs={pixelsPerMs} top={scrollMargin} />

                {/* Magnetic Snapping Guide Line & Smart Badge */}
                {snapGuide ? (
                  <TimelineSnapBadge target={snapGuide} pixelsPerMs={pixelsPerMs} />
                ) : null}

                {/* Hover scrub line + razor indicator — imperative handles keep
                    pointermove off the lanes render path. */}
                <TimelineHoverLine
                  ref={hoverLineRef}
                  variant="hover"
                  pixelsPerMs={pixelsPerMs}
                  chipTop={scrollTop + 2}
                />
                <TimelineHoverLine
                  ref={razorLineRef}
                  variant="razor"
                  pixelsPerMs={pixelsPerMs}
                  chipTop={scrollTop + 2}
                />

                {/* Gesture ghost + HUD chip for the active move/trim */}
                {gestureInfo
                  ? (() => {
                      const bounds = trackRowBounds.find(
                        (row) => row.trackId === gestureInfo.trackId,
                      )
                      const gestureTrack = timeline.tracks.find((t) => t.id === gestureInfo.trackId)
                      if (!bounds || !gestureTrack) return null
                      const gestureClip = gestureTrack.clips.find(
                        (c) => c.id === gestureInfo.clipId,
                      )
                      return (
                        <TimelineGestureOverlay
                          info={gestureInfo}
                          pixelsPerMs={pixelsPerMs}
                          rowBounds={{
                            top: bounds.top,
                            height: bounds.bottom - bounds.top,
                          }}
                          laneColorVar={
                            gestureClip
                              ? getClipLaneTheme(gestureClip, gestureTrack).colorVar
                              : getTrackLaneTheme(gestureTrack).colorVar
                          }
                          minTop={scrollMargin}
                        />
                      )
                    })()
                  : null}

                {/* Playhead Needle */}
                <TimelinePlayhead
                  pixelsPerMs={pixelsPerMs}
                  timelineHeight={contentHeight}
                  durationMs={view.durationMs}
                  isPlaying={view.isPlaying}
                  getTimelineTime={timelineTimeFromClientX}
                  onSeek={onSeek}
                  onPause={onPause}
                  snapTargets={snapTargets}
                  snapEnabled={view.snapEnabled}
                  snapThresholdMs={view.snapThresholdMs}
                  onSnapGuide={onSnapGuideCallback}
                  isSplitTool={tool === "split"}
                />

                {/* Virtualized Track Rows */}
                {visibleTrackRows.map(({ track, virtualTrack }) => {
                  if (!track) return null

                  if (track.kind === "zoom") {
                    return (
                      <div
                        key={track.id}
                        style={laneStyle("--color-track-zoom")}
                        className="contents"
                      >
                        <ZoomTrackRow
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
                          snapTargets={snapTargets}
                          getTimelineTime={timelineTimeFromClientX}
                          tool={tool}
                          onSelectZoom={onSelectZoom}
                          onAddZoomAtTime={onAddZoomAtTime}
                          onZoomSegmentAction={onZoomSegmentAction}
                          onMoveZoomSegment={onMoveZoomSegment}
                          onResizeZoomSegment={onResizeZoomSegment}
                          onSnapGuide={onSnapGuideCallback}
                          onGestureHud={onGestureHud}
                          edgeAutoScroll={edgeAutoScroll}
                        />
                      </div>
                    )
                  }

                  const isScreenTrack = track.kind === "screen"
                  const visibleClips = track.clips.filter((clip) =>
                    clipIntersectsWindow(clip, visibleStartMs, visibleEndMs),
                  )
                  // An invalid move shows the clip at its ORIGINAL position —
                  // keep it mounted even when auto-scroll pushes it outside
                  // the visible window, or the gesture would lose its target.
                  const rowClips =
                    gestureInfo &&
                    gestureInfo.trackId === track.id &&
                    !visibleClips.some((c) => c.id === gestureInfo.clipId)
                      ? [...visibleClips, ...track.clips.filter((c) => c.id === gestureInfo.clipId)]
                      : visibleClips

                  return (
                    <TimelineLaneRow
                      key={track.id}
                      track={track}
                      index={virtualTrack.index}
                      top={virtualTrack.start}
                      height={virtualTrack.size}
                      pixelsPerMs={pixelsPerMs}
                      visibleStartMs={visibleStartMs}
                      visibleEndMs={visibleEndMs}
                      scrollLeftPx={scrollLeft}
                      tool={tool}
                      collapsed={view.collapsedTrackIds.includes(track.id)}
                      frameMs={Math.max(1, Math.round(1000 / Math.max(1, timeline.canvas.fps)))}
                      clips={rowClips}
                      runLayout={laneLayouts.get(track.id) ?? null}
                      laneTheme={getTrackLaneTheme(track)}
                      sourceDurationMs={sourceDurationMs}
                      screenGaps={screenGaps}
                      hasSelectedClip={track.clips.some((clip) => selectedClipIds.has(clip.id))}
                      soloDimmed={anySoloAudio && track.kind === "audio" && !track.solo}
                      selectedClipIds={selectedClipIds}
                      canGroup={selectionCanGroup}
                      canUngroup={selectionHasGroup}
                      thumbnailManifest={isScreenTrack ? thumbnailData : null}
                      spriteUrl={isScreenTrack ? spriteUrl : null}
                      videoThumbnailResources={videoThumbnailResources}
                      workDir={workDir}
                      waveformResources={waveformResources}
                      snapTargets={snapTargets}
                      snapEnabled={view.snapEnabled}
                      snapThresholdMs={view.snapThresholdMs}
                      edgeAutoScroll={edgeAutoScroll}
                      onGestureHud={onGestureHud}
                      onSnapGuide={onSnapGuideCallback}
                      getTimelineTime={timelineTimeFromClientX}
                      onSeek={onSeek}
                      onSelectClip={onSelectClip}
                      onMoveClip={onMoveClip}
                      onTrimClip={onTrimClip}
                      onSpriteError={onSpriteError}
                      onDuplicateClip={onDuplicateClip}
                      onSplitClip={onSplitClip}
                      onDeleteClip={onDeleteClip}
                      onCursorRangeAction={onCursorRangeAction}
                      onUpdateClipAudio={onUpdateClipAudio}
                      onRippleDeleteRange={onRippleDeleteRange}
                      onGroupClips={onGroupClips}
                      onUngroupClips={onUngroupClips}
                    />
                  )
                })}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              {(() => {
                const rangeSelection = view.selection?.kind === "range" ? view.selection : null
                if (!rangeSelection || !onAddZoomAtTime) return null
                return (
                  <>
                    <ContextMenuItem
                      className="font-medium text-primary focus:bg-primary/10 focus:text-primary cursor-pointer"
                      onSelect={() =>
                        onAddZoomAtTime(rangeSelection.startMs, {
                          endMs: rangeSelection.endMs,
                        })
                      }
                    >
                      <Sparkles className="size-3.5 mr-2 text-primary" /> Create Zoom from Range (
                      {formatTimelineTime(rangeSelection.startMs)} →{" "}
                      {formatTimelineTime(rangeSelection.endMs)})
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                  </>
                )
              })()}
              {emptyLanesContextMenuTimeMs !== null && onAddZoomAtTime ? (
                <ContextMenuItem onSelect={() => onAddZoomAtTime(emptyLanesContextMenuTimeMs)}>
                  <ZoomIn className="size-3.5 mr-2 text-primary" /> Add Zoom here (
                  {formatTimelineTime(emptyLanesContextMenuTimeMs)})
                </ContextMenuItem>
              ) : null}
              <LanesPlayheadMenuActions
                emptyLanesContextMenuTimeMs={emptyLanesContextMenuTimeMs}
                onAddZoomAtTime={onAddZoomAtTime}
                onAddMarkerAtTime={onAddMarkerAtTime}
                onSplitAllAtPlayhead={onSplitAllAtPlayhead}
              />
              {view.selection ? (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                    onSelect={() => onDeleteSelection(false)}
                  >
                    <Trash2 className="size-3.5 mr-2" /> Delete selected
                  </ContextMenuItem>
                  {onDeselectAll ? (
                    <ContextMenuItem onSelect={() => onDeselectAll()}>
                      <X className="size-3.5 mr-2" /> Deselect all
                    </ContextMenuItem>
                  ) : null}
                </>
              ) : null}
            </ContextMenuContent>
          </ContextMenu>
        </div>
      </div>
    </div>
  )
}

interface LanesPlayheadMenuActionsProps {
  emptyLanesContextMenuTimeMs: number | null
  onAddZoomAtTime?: (
    timeMs: number,
    options?: { preset?: ZoomPreset; scale?: number; endMs?: number },
  ) => void
  onAddMarkerAtTime?: (timeMs: number) => void
  onSplitAllAtPlayhead?: () => void
}

// These items read the live playhead; mounting them inside ContextMenuContent
// (rendered only while the menu is open) keeps the subscription scoped to the
// menu's lifetime instead of the whole lanes tree.
function LanesPlayheadMenuActions({
  emptyLanesContextMenuTimeMs,
  onAddZoomAtTime,
  onAddMarkerAtTime,
  onSplitAllAtPlayhead,
}: LanesPlayheadMenuActionsProps) {
  const playheadMs = usePlayheadMs()
  return (
    <>
      {onAddZoomAtTime ? (
        <ContextMenuItem onSelect={() => onAddZoomAtTime(playheadMs)}>
          <ZoomIn className="size-3.5 mr-2 text-primary" /> Add Zoom at playhead (
          {formatTimelineTime(playheadMs)})
        </ContextMenuItem>
      ) : null}
      {emptyLanesContextMenuTimeMs !== null && onAddMarkerAtTime ? (
        <ContextMenuItem onSelect={() => onAddMarkerAtTime(emptyLanesContextMenuTimeMs)}>
          <BookmarkPlus className="size-3.5 mr-2" /> Add marker here (
          {formatTimelineTime(emptyLanesContextMenuTimeMs)})
        </ContextMenuItem>
      ) : null}
      {onAddMarkerAtTime ? (
        <ContextMenuItem onSelect={() => onAddMarkerAtTime(playheadMs)}>
          <BookmarkPlus className="size-3.5 mr-2" /> Add marker at playhead (
          {formatTimelineTime(playheadMs)})
        </ContextMenuItem>
      ) : null}
      {onSplitAllAtPlayhead ? (
        <ContextMenuItem onSelect={() => onSplitAllAtPlayhead()}>
          <Scissors className="size-3.5 mr-2" /> Split all at playhead (
          {formatTimelineTime(playheadMs)})
        </ContextMenuItem>
      ) : null}
    </>
  )
}

export { getVisibleTickInterval }
