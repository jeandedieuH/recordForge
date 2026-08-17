import { memo, useCallback, useMemo, useRef, useState } from "react"
import type { ManualZoomSegment, TimelineState, TimelineTrack, ZoomPreset } from "@recordforge/contracts"
import {
  buildSnapTargets,
  snapClipStart,
  snapTrimEdge,
  type SnapTarget,
} from "@recordforge/editor-core"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  cn,
} from "@recordforge/ui"
import { Lock, Plus, Sparkles, ZoomIn } from "lucide-react"

interface ZoomSegmentAction {
  kind: "toggle-lock" | "split" | "delete" | "regenerate-from-click"
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
  playheadMs: number
  cursorClickTimesMs: number[]
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
}

interface SegmentGesture {
  pointerId: number
  mode: "move" | "resize-start" | "resize-end"
  initialClientX: number
  initialTimelineMs: number
  initialStartMs: number
  initialEndMs: number
  moved: boolean
}

export const ZoomTrackRow = memo(function ZoomTrackRow({
  timeline,
  track,
  top,
  height,
  visibleStartMs,
  visibleEndMs,
  pixelsPerMs,
  selectedZoomId,
  snapEnabled,
  snapThresholdMs,
  playheadMs,
  cursorClickTimesMs,
  getTimelineTime,
  onSelectZoom,
  onAddZoomAtTime,
  onZoomSegmentAction,
  onMoveZoomSegment,
  onResizeZoomSegment,
}: ZoomTrackRowProps) {
  const [snapGuide, setSnapGuide] = useState<SnapTarget | null>(null)
  const [hoverGhost, setHoverGhost] = useState<{ timeMs: number } | null>(null)
  const onSnapGuide = useCallback((target: SnapTarget | null) => setSnapGuide(target), [])

  const snapTargets = useMemo(
    () => buildSnapTargets(timeline, { playheadMs, cursorClickTimesMs }),
    [timeline, playheadMs, cursorClickTimesMs],
  )

  const visibleSegments = useMemo(
    () =>
      (timeline.zoomSegments ?? []).filter(
        (segment) =>
          segment.startMs <= visibleEndMs + 2_000 &&
          segment.startMs + segment.durationMs >= visibleStartMs - 2_000,
      ),
    [timeline.zoomSegments, visibleStartMs, visibleEndMs],
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

  return (
    <div
      className={cn(
        "group/zoom-row absolute inset-x-0 flex items-center border-b border-border/80 transition-colors",
        track.muted && "bg-surface-dim/20 opacity-40",
        !track.locked && "cursor-crosshair",
      )}
      style={{ top, height }}
      onDoubleClick={handleDoubleClick}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    >
      {snapGuide ? (
        <div
          className="pointer-events-none absolute inset-y-0 z-20 w-px bg-primary shadow-[0_0_8px_rgba(9,77,178,0.8)]"
          style={{ left: `${snapGuide.timeMs * pixelsPerMs}px` }}
          aria-hidden
        />
      ) : null}

      {/* Hover Ghost Indicator for Quick Add */}
      {hoverGhost && !track.locked ? (
        <div
          className="pointer-events-none absolute z-0 flex items-center justify-center rounded-lg border border-dashed border-primary/50 bg-primary/10 opacity-70 transition-opacity"
          style={{
            left: `${hoverGhost.timeMs * pixelsPerMs}px`,
            width: `${Math.max(40, 2000 * pixelsPerMs)}px`,
            height: `${Math.max(28, Math.min(height - 14, 38))}px`,
          }}
        >
          <div className="flex items-center gap-1 font-mono text-[9px] font-medium text-primary">
            <Plus className="size-2.5" />
            <span>Double-click to add zoom</span>
          </div>
        </div>
      ) : null}

      {visibleSegments.map((segment) => (
        <ZoomSegmentItem
          key={segment.id}
          segment={segment}
          track={track}
          height={height}
          pixelsPerMs={pixelsPerMs}
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
}

function ZoomSegmentItem({
  segment,
  track,
  height,
  pixelsPerMs,
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
}: ZoomSegmentItemProps) {
  const gestureRef = useRef<SegmentGesture | null>(null)
  const suppressClickRef = useRef(false)
  const [gestureDelta, setGestureDelta] = useState<{ mode: string; text: string } | null>(null)

  const left = segment.startMs * pixelsPerMs
  const width = Math.max(8, segment.durationMs * pixelsPerMs)
  const barHeight = Math.max(30, Math.min(height - 14, 40))

  function beginGesture(event: React.PointerEvent<HTMLElement>, mode: SegmentGesture["mode"]) {
    if (event.button !== 0 || track.locked || segment.locked) return
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

    const snap = { enabled: snapEnabled && !event.altKey, thresholdMs: snapThresholdMs }

    if (gesture.mode === "move") {
      const duration = gesture.initialEndMs - gesture.initialStartMs
      const rawStartMs = Math.max(0, Math.round(gesture.initialStartMs + deltaMs))
      const snapped = snapClipStart(rawStartMs, duration, snapTargets, snap)
      onSnapGuide(snapped.snapped ? snapped.target : null)
      setGestureDelta({
        mode: "Move",
        text: `${deltaMs >= 0 ? "+" : ""}${(deltaMs / 1000).toFixed(2)}s`,
      })
      onMoveZoomSegment(segment, snapped.timeMs, snapped.timeMs + duration, { phase: "draft" })
      return
    }

    const edge = gesture.mode === "resize-start" ? "start" : "end"
    const rawEdgeTimeMs =
      edge === "start"
        ? Math.max(0, Math.round(gesture.initialStartMs + deltaMs))
        : Math.max(0, Math.round(gesture.initialEndMs + deltaMs))
    const snapped = snapTrimEdge(edge, rawEdgeTimeMs, snapTargets, snap)
    onSnapGuide(snapped.snapped ? snapped.target : null)
    const nextStartMs =
      edge === "start" ? Math.min(snapped.timeMs, gesture.initialEndMs - 1) : gesture.initialStartMs
    const nextEndMs =
      edge === "start" ? gesture.initialEndMs : Math.max(snapped.timeMs, gesture.initialStartMs + 1)

    setGestureDelta({
      mode: edge === "start" ? "Resize In" : "Resize Out",
      text: `${deltaMs >= 0 ? "+" : ""}${(deltaMs / 1000).toFixed(2)}s`,
    })
    onResizeZoomSegment(segment, nextStartMs, nextEndMs, { phase: "draft" })
  }

  function finishGesture(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const wasCancelled = event.type === "pointercancel"
    const didMove = gesture.moved
    gestureRef.current = null
    setGestureDelta(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    if (wasCancelled || !didMove) {
      onSnapGuide(null)
      onMoveZoomSegment(segment, gesture.initialStartMs, gesture.initialEndMs, { phase: "cancel" })
      return
    }

    const currentMs = getTimelineTime(event.clientX)
    const deltaMs = currentMs - gesture.initialTimelineMs
    const snap = { enabled: snapEnabled && !event.altKey, thresholdMs: snapThresholdMs }

    if (gesture.mode === "move") {
      const duration = gesture.initialEndMs - gesture.initialStartMs
      const rawStartMs = Math.max(0, Math.round(gesture.initialStartMs + deltaMs))
      const snapped = snapClipStart(rawStartMs, duration, snapTargets, snap)
      onSnapGuide(null)
      onMoveZoomSegment(segment, snapped.timeMs, snapped.timeMs + duration, { phase: "commit" })
      return
    }

    const edge = gesture.mode === "resize-start" ? "start" : "end"
    const rawEdgeTimeMs =
      edge === "start"
        ? Math.max(0, Math.round(gesture.initialStartMs + deltaMs))
        : Math.max(0, Math.round(gesture.initialEndMs + deltaMs))
    const snapped = snapTrimEdge(edge, rawEdgeTimeMs, snapTargets, snap)
    onSnapGuide(null)
    const nextStartMs =
      edge === "start" ? Math.min(snapped.timeMs, gesture.initialEndMs - 1) : gesture.initialStartMs
    const nextEndMs =
      edge === "start" ? gesture.initialEndMs : Math.max(snapped.timeMs, gesture.initialStartMs + 1)
    onResizeZoomSegment(segment, nextStartMs, nextEndMs, { phase: "commit" })
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
          aria-label={`Zoom segment ${segment.scale.toFixed(1)}x`}
          aria-pressed={selected}
          className={cn(
            "group/zoom absolute flex items-center overflow-hidden rounded-lg border border-primary/70 bg-linear-to-b from-primary/30 to-primary/15 px-2 text-left text-[11px] transition-all duration-fast select-none cursor-grab active:cursor-grabbing hover:from-primary/40 hover:to-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
            selected
              ? "ring-2 ring-primary ring-offset-1 ring-offset-surface-dim shadow-[0_0_12px_rgba(9,77,178,0.45)] z-20"
              : "z-10",
            (track.locked || segment.locked) && "cursor-not-allowed opacity-60",
          )}
          style={{
            left: `${left}px`,
            width: `${width}px`,
            height: `${barHeight}px`,
          }}
          onPointerDown={(event) => beginGesture(event, "move")}
          onPointerMove={handlePointerMove}
          onPointerUp={finishGesture}
          onPointerCancel={finishGesture}
          onContextMenu={() => {
            if (!selected) {
              onSelectZoom(segment.id)
            }
          }}
          onClick={(event) => {
            event.stopPropagation()
            if (suppressClickRef.current) {
              suppressClickRef.current = false
              return
            }
            onSelectZoom(segment.id)
          }}
          title={`${segment.label ? `${segment.label} · ` : ""}${segment.scale.toFixed(1)}× (${formatZoomTime(segment.startMs)} → ${formatZoomTime(segment.startMs + segment.durationMs)})`}
        >
          {/* Start Resize Handle */}
          {!segment.locked && !track.locked ? (
            <div
              className="absolute left-0 inset-y-0 z-30 flex w-3 cursor-ew-resize items-center justify-center opacity-0 transition-all duration-fast group-hover/zoom:opacity-100 hover:w-3.5 hover:bg-primary/30"
              onPointerDown={(e) => beginGesture(e, "resize-start")}
              onClick={(e) => e.stopPropagation()}
              title="Resize transition in"
            >
              <div className="h-4 w-1 rounded-full bg-primary shadow-xs" />
            </div>
          ) : null}

          {/* Visual Transition In Ramp */}
          <div
            className="pointer-events-none absolute bottom-0 left-0 top-0 bg-linear-to-r from-primary/40 to-transparent"
            style={{ width: `${transInWidth}px` }}
            aria-hidden
          />

          {/* Visual Transition Out Ramp */}
          <div
            className="pointer-events-none absolute bottom-0 right-0 top-0 bg-linear-to-l from-primary/40 to-transparent"
            style={{ width: `${transOutWidth}px` }}
            aria-hidden
          />

          {/* Segment Details */}
          <div className="relative z-10 flex min-w-0 flex-1 items-center gap-1.5 px-1">
            <ZoomIn className="size-3 shrink-0 text-primary" aria-hidden />
            <span className="truncate font-semibold text-[11px] text-foreground">
              {segment.label ? `${segment.label} ` : ""}
              {segment.scale.toFixed(1)}×
            </span>
            {segment.mode === "follow-cursor" ? (
              <span className="rounded bg-primary/20 px-1 py-0.5 font-mono text-[9px] font-medium text-primary">
                follow
              </span>
            ) : segment.mode === "smooth-pan" ? (
              <span className="rounded bg-primary/20 px-1 py-0.5 font-mono text-[9px] font-medium text-primary">
                pan
              </span>
            ) : segment.mode === "auto" ? (
              <span className="flex items-center gap-0.5 text-[9px] font-medium text-primary/80">
                <Sparkles className="size-2.5" /> auto
              </span>
            ) : null}
            {segment.locked ? (
              <Lock className="size-2.5 shrink-0 text-warning opacity-80" aria-hidden />
            ) : null}
          </div>

          {/* End Resize Handle */}
          {!segment.locked && !track.locked ? (
            <div
              className="absolute right-0 inset-y-0 z-30 flex w-3 cursor-ew-resize items-center justify-center opacity-0 transition-all duration-fast group-hover/zoom:opacity-100 hover:w-3.5 hover:bg-primary/30"
              onPointerDown={(e) => beginGesture(e, "resize-end")}
              onClick={(e) => e.stopPropagation()}
              title="Resize transition out"
            >
              <div className="h-4 w-1 rounded-full bg-primary shadow-xs" />
            </div>
          ) : null}

          {/* Live Drag/Trim Feedback Tooltip */}
          {gestureDelta ? (
            <div className="absolute -top-7 left-1/2 -translate-x-1/2 z-50 rounded-md border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] font-semibold text-foreground shadow-e2 whitespace-nowrap">
              <span className="text-primary mr-1">{gestureDelta.mode}:</span>
              {gestureDelta.text}
            </div>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
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
          Split
        </ContextMenuItem>
        <ContextMenuItem
          className="text-destructive focus:bg-destructive/10 focus:text-destructive"
          onSelect={() => onZoomSegmentAction?.({ kind: "delete", segmentId: segment.id })}
          disabled={segment.locked}
        >
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function formatZoomTime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const remainder = Math.floor(ms % 1000)
  return `${seconds}.${remainder.toString().padStart(3, "0")}s`
}
