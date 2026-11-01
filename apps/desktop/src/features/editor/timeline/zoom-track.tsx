import { memo, useRef, useState } from "react"
import type {
  ManualZoomSegment,
  TimelineState,
  TimelineTrack,
  ZoomPreset,
} from "@recordforge/contracts"
import {
  playheadSnapTarget,
  snapClipStart,
  snapTrimEdge,
  type SnapTarget,
} from "@recordforge/editor-core"
import { getPlayheadSnapshot } from "./use-playback-state"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  cn,
} from "@recordforge/ui"
import { Eye, EyeOff, Lock, Plus, Scissors, Sparkles, Trash2, ZoomIn } from "lucide-react"
import { TimelineEdgeHandle } from "./lanes/timeline-edge-handle"
import type { EdgeAutoScroll } from "./lanes/use-edge-auto-scroll"
import type { TimelineGestureInfo } from "./lanes/timeline-gesture-overlay"

interface ZoomSegmentAction {
  kind:
    | "toggle-enabled"
    | "toggle-lock"
    | "split"
    | "delete"
    | "ripple-delete"
    | "regenerate-from-click"
  segmentId: string
}

export interface ZoomTrackRowProps {
  timeline: TimelineState
  track: TimelineTrack
  top: number
  height: number
  visibleStartMs: number
  visibleEndMs: number
  pixelsPerMs: number
  selectedZoomId: string | null
  snapEnabled: boolean
  snapThresholdMs: number
  // Shared snap targets + guides from the lanes level — the row no longer
  // builds or renders its own.
  snapTargets: SnapTarget[]
  getTimelineTime: (clientX: number) => number
  onSelectZoom: (segmentId: string) => void
  onAddZoomAtTime?: (timeMs: number, options?: { preset?: ZoomPreset; scale?: number }) => void
  onZoomSegmentAction?: (action: ZoomSegmentAction) => void
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
  onSnapGuide: (target: SnapTarget | null) => void
  onGestureHud: (info: TimelineGestureInfo | null) => void
  edgeAutoScroll: EdgeAutoScroll
  tool?: "select" | "split" | "range"
}

interface SegmentGesture {
  pointerId: number
  mode: "move" | "resize-start" | "resize-end"
  initialClientX: number
  initialTimelineMs: number
  initialStartMs: number
  initialEndMs: number
  moved: boolean
  // Captured at gesture start; includes the live playhead which the memoized
  // prop list omits so playback ticks don't rebuild it.
  snapTargets: SnapTarget[]
}

export const ZoomTrackRow = memo(function ZoomTrackRow({
  timeline,
  track,
  top,
  height,
  tool = "select",
  visibleStartMs,
  visibleEndMs,
  pixelsPerMs,
  selectedZoomId,
  snapEnabled,
  snapThresholdMs,
  snapTargets,
  getTimelineTime,
  onSelectZoom,
  onAddZoomAtTime,
  onZoomSegmentAction,
  onMoveZoomSegment,
  onResizeZoomSegment,
  onSnapGuide,
  onGestureHud,
  edgeAutoScroll,
}: ZoomTrackRowProps) {
  const [hoverGhost, setHoverGhost] = useState<{ timeMs: number } | null>(null)

  const visibleSegments = (timeline.zoomSegments ?? []).filter(
    (segment) =>
      segment.startMs <= visibleEndMs + 2_000 &&
      segment.startMs + segment.durationMs >= visibleStartMs - 2_000,
  )

  function handleDoubleClick(event: React.MouseEvent<HTMLDivElement>) {
    if (track.locked || !onAddZoomAtTime) return
    const target = event.target as HTMLElement
    if (target.closest("[data-timeline-zoom]")) return
    const timeMs = Math.max(0, Math.round(getTimelineTime(event.clientX)))
    onAddZoomAtTime(timeMs)
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (track.locked) return
    const target = event.target as HTMLElement
    if (target.closest("[data-timeline-zoom]")) {
      if (hoverGhost !== null) setHoverGhost(null)
      return
    }
    const timeMs = Math.max(0, Math.round(getTimelineTime(event.clientX)))
    setHoverGhost({ timeMs })
  }

  function handlePointerLeave() {
    setHoverGhost(null)
  }

  const ghostWidth = Math.max(40, 2000 * pixelsPerMs)

  return (
    <div
      className={cn(
        "group/zoom-row absolute inset-x-0 border-b border-border/50 transition-colors",
        track.muted && "bg-surface-dim/20 opacity-40",
        !track.locked && "cursor-crosshair",
      )}
      style={{ top, height }}
      onDoubleClick={handleDoubleClick}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    >
      {/* Hover Ghost Indicator for Quick Add — icon only unless there's room
          for the hint text. */}
      {hoverGhost && !track.locked ? (
        <div
          className="pointer-events-none absolute z-0 flex items-center justify-center gap-1 rounded-sm border border-dashed border-lane/50 bg-lane/10 opacity-70 transition-opacity"
          style={{
            left: `${hoverGhost.timeMs * pixelsPerMs}px`,
            width: `${ghostWidth}px`,
            top: "4px",
            height: `${Math.max(8, height - 8)}px`,
          }}
        >
          <Plus className="size-3 text-lane" />
          {ghostWidth >= 120 ? (
            <span className="font-mono text-[9px] font-medium text-lane">
              Double-click to add zoom
            </span>
          ) : null}
        </div>
      ) : null}

      {visibleSegments.map((segment) => (
        <ZoomSegmentItem
          key={segment.id}
          segment={segment}
          track={track}
          height={height}
          pixelsPerMs={pixelsPerMs}
          tool={tool}
          selected={selectedZoomId === segment.id}
          snapTargets={snapTargets}
          snapEnabled={snapEnabled}
          snapThresholdMs={snapThresholdMs}
          getTimelineTime={getTimelineTime}
          onSelectZoom={onSelectZoom}
          onZoomSegmentAction={onZoomSegmentAction}
          onMoveZoomSegment={onMoveZoomSegment}
          onResizeZoomSegment={onResizeZoomSegment}
          onSnapGuide={onSnapGuide}
          onGestureHud={onGestureHud}
          edgeAutoScroll={edgeAutoScroll}
        />
      ))}
    </div>
  )
})

interface ZoomSegmentItemProps {
  segment: ManualZoomSegment
  track: TimelineTrack
  height: number
  pixelsPerMs: number
  tool?: "select" | "split" | "range"
  selected: boolean
  snapTargets: SnapTarget[]
  snapEnabled: boolean
  snapThresholdMs: number
  getTimelineTime: (clientX: number) => number
  onSelectZoom: (segmentId: string) => void
  onZoomSegmentAction?: (action: ZoomSegmentAction) => void
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
  onSnapGuide: (target: SnapTarget | null) => void
  onGestureHud: (info: TimelineGestureInfo | null) => void
  edgeAutoScroll: EdgeAutoScroll
}

const ZoomSegmentItem = memo(function ZoomSegmentItem({
  segment,
  track,
  height,
  pixelsPerMs,
  tool = "select",
  selected,
  snapTargets,
  snapEnabled,
  snapThresholdMs,
  getTimelineTime,
  onSelectZoom,
  onZoomSegmentAction,
  onMoveZoomSegment,
  onResizeZoomSegment,
  onSnapGuide,
  onGestureHud,
  edgeAutoScroll,
}: ZoomSegmentItemProps) {
  const gestureRef = useRef<SegmentGesture | null>(null)
  const lastPointerRef = useRef<{ clientX: number; altKey: boolean } | null>(null)
  const suppressClickRef = useRef(false)
  const [activeGesture, setActiveGesture] = useState<SegmentGesture["mode"] | null>(null)
  const [isHovered, setIsHovered] = useState(false)

  const left = segment.startMs * pixelsPerMs
  const width = Math.max(8, segment.durationMs * pixelsPerMs)
  const barHeight = Math.max(8, height - 8)
  const isLocked = track.locked || segment.locked
  const hitWidth = Math.round(Math.min(10, Math.max(4, width * 0.25)))
  const showHandles = !isLocked && tool !== "split" && (width >= 8 || selected)

  function hudFor(
    mode: TimelineGestureInfo["mode"],
    startMs: number,
    endMs: number,
  ): TimelineGestureInfo {
    const gesture = gestureRef.current
    return {
      clipId: segment.id,
      trackId: track.id,
      mode,
      label: mode === "trim-start" ? "Resize in" : mode === "trim-end" ? "Resize out" : undefined,
      originalStartMs: gesture?.initialStartMs ?? segment.startMs,
      originalEndMs: gesture?.initialEndMs ?? segment.startMs + segment.durationMs,
      startMs,
      endMs,
      limit: null,
      invalid: null,
    }
  }

  function beginGesture(event: React.PointerEvent<HTMLElement>, mode: SegmentGesture["mode"]) {
    if (event.button !== 0 || isLocked) return
    event.stopPropagation()
    event.preventDefault()
    const target = event.currentTarget.closest("[data-timeline-zoom]")
    if (!(target instanceof HTMLElement)) return
    target.setPointerCapture(event.pointerId)
    gestureRef.current = {
      pointerId: event.pointerId,
      mode,
      initialClientX: event.clientX,
      initialTimelineMs: getTimelineTime(event.clientX),
      initialStartMs: segment.startMs,
      initialEndMs: segment.startMs + segment.durationMs,
      moved: false,
      snapTargets: [...snapTargets, playheadSnapTarget(getPlayheadSnapshot())],
    }
    // activeGesture stays unset until the pointer actually drags.
  }

  // Same draft/commit split as clip gestures: draft reports the lanes HUD,
  // commit re-runs the identical snap path.
  function applyGesture(clientX: number, altKey: boolean, phase: "draft" | "commit") {
    const gesture = gestureRef.current
    if (!gesture) return
    const currentMs = getTimelineTime(clientX)
    const deltaMs = currentMs - gesture.initialTimelineMs
    const snap = { enabled: snapEnabled && !altKey, thresholdMs: snapThresholdMs }

    if (gesture.mode === "move") {
      const duration = gesture.initialEndMs - gesture.initialStartMs
      const rawStartMs = Math.max(0, Math.round(gesture.initialStartMs + deltaMs))
      const snapped = snapClipStart(rawStartMs, duration, gesture.snapTargets, snap)
      onSnapGuide(snapped.snapped ? snapped.target : null)
      if (phase === "draft") {
        onGestureHud(hudFor("move", snapped.timeMs, snapped.timeMs + duration))
      }
      onMoveZoomSegment(segment, snapped.timeMs, snapped.timeMs + duration, { phase })
      return
    }

    const edge = gesture.mode === "resize-start" ? "start" : "end"
    const rawEdgeTimeMs =
      edge === "start"
        ? Math.max(0, Math.round(gesture.initialStartMs + deltaMs))
        : Math.max(0, Math.round(gesture.initialEndMs + deltaMs))
    const snapped = snapTrimEdge(edge, rawEdgeTimeMs, gesture.snapTargets, snap)
    onSnapGuide(snapped.snapped ? snapped.target : null)
    const nextStartMs =
      edge === "start" ? Math.min(snapped.timeMs, gesture.initialEndMs - 1) : gesture.initialStartMs
    const nextEndMs =
      edge === "start" ? gesture.initialEndMs : Math.max(snapped.timeMs, gesture.initialStartMs + 1)
    if (phase === "draft") {
      onGestureHud(hudFor(edge === "start" ? "trim-start" : "trim-end", nextStartMs, nextEndMs))
    }
    onResizeZoomSegment(segment, nextStartMs, nextEndMs, { phase })
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    if (Math.abs(event.clientX - gesture.initialClientX) < 3 && !gesture.moved) return
    gesture.moved = true
    setActiveGesture(gesture.mode)
    suppressClickRef.current = true
    event.preventDefault()
    lastPointerRef.current = { clientX: event.clientX, altKey: event.altKey }
    applyGesture(event.clientX, event.altKey, "draft")
    edgeAutoScroll.track(event.clientX, () => {
      const last = lastPointerRef.current
      if (last) applyGesture(last.clientX, last.altKey, "draft")
    })
  }

  function finishGesture(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const wasCancelled = event.type === "pointercancel"
    const didMove = gesture.moved
    gestureRef.current = null
    lastPointerRef.current = null
    edgeAutoScroll.stop()
    setActiveGesture(null)
    onGestureHud(null)
    onSnapGuide(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    if (wasCancelled || !didMove) {
      onMoveZoomSegment(segment, gesture.initialStartMs, gesture.initialEndMs, { phase: "cancel" })
      return
    }

    applyGesture(event.clientX, event.altKey, "commit")
  }

  const transInWidth = Math.min(width / 2, (segment.transitionInMs ?? 400) * pixelsPerMs)
  const transOutWidth = Math.min(width / 2, (segment.transitionOutMs ?? 400) * pixelsPerMs)

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open && !selected) {
          onSelectZoom(segment.id)
        }
      }}
    >
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          data-timeline-zoom
          aria-label={`${segment.enabled ? "Zoom" : "Disabled zoom"} segment ${segment.scale.toFixed(1)}x`}
          aria-pressed={selected}
          className={cn(
            "group/zoom absolute flex items-center select-none overflow-hidden rounded-sm bg-lane/20 outline-none transition-[background-color,box-shadow,opacity] duration-fast ease-forge",
            selected
              ? "z-20 bg-lane/35 ring-2 ring-inset ring-foreground"
              : "z-10 ring-1 ring-inset ring-lane/40 hover:bg-lane/28",
            activeGesture && "z-30 ring-2 ring-foreground shadow-e2",
            activeGesture === "move"
              ? "cursor-grabbing"
              : activeGesture
                ? "cursor-ew-resize"
                : tool === "split"
                  ? "cursor-crosshair"
                  : "cursor-grab",
            "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground",
            !segment.enabled && "opacity-50",
            isLocked && "cursor-not-allowed opacity-60",
          )}
          style={{
            left: `${left}px`,
            width: `${width}px`,
            top: "4px",
            height: `${barHeight}px`,
          }}
          onPointerEnter={() => setIsHovered(true)}
          onPointerLeave={() => setIsHovered(false)}
          onPointerDown={(event) => {
            if (tool === "split") {
              return
            }
            beginGesture(event, "move")
          }}
          onPointerMove={handlePointerMove}
          onPointerUp={finishGesture}
          onPointerCancel={finishGesture}
          onContextMenu={() => {
            if (!selected) {
              onSelectZoom(segment.id)
            }
          }}
          onClick={(event) => {
            if (tool === "split") {
              return
            }
            event.stopPropagation()
            if (suppressClickRef.current) {
              suppressClickRef.current = false
              return
            }
            onSelectZoom(segment.id)
          }}
          title={`${segment.label ? `${segment.label} · ` : ""}${segment.scale.toFixed(1)}× (${formatZoomTime(segment.startMs)} → ${formatZoomTime(segment.startMs + segment.durationMs)})`}
        >
          {/* Top Accent Bar */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-lane/80" />

          {/* Visual Transition In Ramp */}
          <div
            className="pointer-events-none absolute bottom-0 left-0 top-0 bg-linear-to-r from-lane/40 to-transparent"
            style={{ width: `${transInWidth}px` }}
            aria-hidden
          />

          {/* Visual Transition Out Ramp */}
          <div
            className="pointer-events-none absolute bottom-0 right-0 top-0 bg-linear-to-l from-lane/40 to-transparent"
            style={{ width: `${transOutWidth}px` }}
            aria-hidden
          />

          {/* Disabled segments get a dashed overlay like cursor ranges */}
          {!segment.enabled ? (
            <div className="pointer-events-none absolute inset-0 rounded-[inherit] border border-dashed border-foreground/50" />
          ) : null}

          {/* Start Resize Handle */}
          {showHandles ? (
            <TimelineEdgeHandle
              edge="start"
              hitWidth={hitWidth}
              visible={isHovered || selected || activeGesture === "resize-start"}
              active={activeGesture === "resize-start"}
              limited={false}
              onPointerDown={(e) => beginGesture(e, "resize-start")}
            />
          ) : null}

          {/* Segment Details — level of detail follows the bar's width */}
          {width >= 30 ? (
            <div className="relative z-10 flex min-w-0 flex-1 items-center gap-1.5 px-2 pointer-events-none">
              <ZoomIn className="size-3 shrink-0 text-lane" aria-hidden />
              <span className="truncate font-semibold text-[11px] text-foreground">
                {segment.label ? `${segment.label} ` : ""}
                {segment.scale.toFixed(1)}×
              </span>
              {width >= 90 && segment.mode === "follow-cursor" ? (
                <span className="rounded-sm bg-lane/20 px-1 py-0.5 font-mono text-[9px] font-medium text-lane">
                  follow
                </span>
              ) : width >= 90 && segment.mode === "smooth-pan" ? (
                <span className="rounded-sm bg-lane/20 px-1 py-0.5 font-mono text-[9px] font-medium text-lane">
                  pan
                </span>
              ) : width >= 90 && segment.mode === "auto" ? (
                <span className="flex items-center gap-0.5 text-[9px] font-medium text-lane/80">
                  <Sparkles className="size-2.5" /> auto
                </span>
              ) : null}
              {segment.locked ? (
                <Lock className="size-2.5 shrink-0 text-warning opacity-80" aria-hidden />
              ) : null}
            </div>
          ) : null}

          {/* End Resize Handle */}
          {showHandles ? (
            <TimelineEdgeHandle
              edge="end"
              hitWidth={hitWidth}
              visible={isHovered || selected || activeGesture === "resize-end"}
              active={activeGesture === "resize-end"}
              limited={false}
              onPointerDown={(e) => beginGesture(e, "resize-end")}
            />
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() => onZoomSegmentAction?.({ kind: "toggle-enabled", segmentId: segment.id })}
          disabled={segment.locked}
        >
          {segment.enabled ? (
            <EyeOff className="mr-2 size-3.5" aria-hidden />
          ) : (
            <Eye className="mr-2 size-3.5" aria-hidden />
          )}
          {segment.enabled ? "Disable zoom" : "Enable zoom"}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onSelectZoom(segment.id)}>Edit target</ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            onZoomSegmentAction?.({
              kind: "regenerate-from-click",
              segmentId: segment.id,
            })
          }
        >
          Regenerate from click
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            onZoomSegmentAction?.({
              kind: "toggle-lock",
              segmentId: segment.id,
            })
          }
        >
          {segment.locked ? "Unlock" : "Lock"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => onZoomSegmentAction?.({ kind: "split", segmentId: segment.id })}
          disabled={segment.locked}
        >
          <Scissors className="size-3.5 mr-2" /> Split
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className="text-destructive focus:bg-destructive/10 focus:text-destructive"
          onSelect={() => onZoomSegmentAction?.({ kind: "delete", segmentId: segment.id })}
          disabled={segment.locked}
        >
          <Trash2 className="size-3.5 mr-2" /> Delete
        </ContextMenuItem>
        <ContextMenuItem
          className="text-destructive focus:bg-destructive/10 focus:text-destructive"
          onSelect={() => onZoomSegmentAction?.({ kind: "ripple-delete", segmentId: segment.id })}
          disabled={segment.locked}
        >
          <Trash2 className="size-3.5 mr-2" /> Ripple Delete (Shift+Del)
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})

function formatZoomTime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const remainder = Math.floor(ms % 1000)
  return `${seconds}.${remainder.toString().padStart(3, "0")}s`
}
