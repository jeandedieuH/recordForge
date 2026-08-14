import { useCallback, useMemo, useRef, useState } from "react"
import type { ManualZoomSegment, TimelineState, TimelineTrack } from "@recordforge/contracts"
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
import { ZoomIn } from "lucide-react"

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

export function ZoomTrackRow({
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
  onZoomSegmentAction,
  onMoveZoomSegment,
  onResizeZoomSegment,
}: ZoomTrackRowProps) {
  const [snapGuide, setSnapGuide] = useState<SnapTarget | null>(null)
  const onSnapGuide = useCallback((target: SnapTarget | null) => setSnapGuide(target), [])

  const snapTargets = useMemo(
    () => buildSnapTargets(timeline, { playheadMs, cursorClickTimesMs }),
    [timeline, playheadMs, cursorClickTimesMs],
  )

  const visibleSegments = useMemo(
    () =>
      (timeline.zoomSegments ?? []).filter(
        (segment) =>
          segment.startMs <= visibleEndMs && segment.startMs + segment.durationMs >= visibleStartMs,
      ),
    [timeline.zoomSegments, visibleStartMs, visibleEndMs],
  )

  return (
    <div
      className={cn(
        "absolute inset-x-0 flex items-center border-b border-border",
        track.muted && "bg-surface-dim/20",
      )}
      style={{ top, height }}
    >
      {snapGuide ? (
        <div
          className="pointer-events-none absolute inset-y-0 z-10 w-px bg-primary/60"
          style={{ left: `${snapGuide.timeMs * pixelsPerMs}px` }}
          aria-hidden
        />
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
}

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
  const left = segment.startMs * pixelsPerMs
  const width = Math.max(8, segment.durationMs * pixelsPerMs)
  const barHeight = Math.max(28, Math.min(height - 16, 38))

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
    onResizeZoomSegment(segment, nextStartMs, nextEndMs, { phase: "draft" })
  }

  function finishGesture(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const wasCancelled = event.type === "pointercancel"
    const didMove = gesture.moved
    gestureRef.current = null
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

  const handleClass = cn(
    "absolute inset-y-0 z-20 w-2 cursor-ew-resize rounded-sm opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
    "bg-primary/70",
  )

  const transInWidth = Math.min(width / 2, (segment.transitionInMs ?? 400) * pixelsPerMs)
  const transOutWidth = Math.min(width / 2, (segment.transitionOutMs ?? 400) * pixelsPerMs)

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          data-timeline-zoom
          aria-label={`Zoom segment from ${formatZoomTime(segment.startMs)} to ${formatZoomTime(segment.startMs + segment.durationMs)}`}
          aria-pressed={selected}
          className={cn(
            "group absolute flex items-center overflow-hidden rounded-md border border-primary/50 bg-primary/15 px-2 text-left text-[11px] transition-all hover:bg-primary/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
            selected && "ring-2 ring-primary ring-offset-1 ring-offset-surface-dim shadow-md",
            track.locked && "cursor-not-allowed opacity-60",
            segment.locked && "opacity-60",
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
          onClick={(event) => {
            event.stopPropagation()
            if (suppressClickRef.current) {
              suppressClickRef.current = false
              return
            }
            onSelectZoom(segment.id)
          }}
          title={`${segment.label ? `${segment.label} · ` : ""}${segment.scale.toFixed(1)}× · ${formatZoomTime(segment.startMs)} → ${formatZoomTime(segment.startMs + segment.durationMs)}`}
        >
          {/* Visual Transition In Ramp Indicator */}
          <div
            className="pointer-events-none absolute bottom-0 left-0 top-0 bg-linear-to-r from-primary/30 to-transparent"
            style={{ width: `${transInWidth}px` }}
            aria-hidden
          />

          {/* Visual Transition Out Ramp Indicator */}
          <div
            className="pointer-events-none absolute bottom-0 right-0 top-0 bg-linear-to-l from-primary/30 to-transparent"
            style={{ width: `${transOutWidth}px` }}
            aria-hidden
          />

          {/* Trim / Resize Handles */}
          <button
            type="button"
            className={cn(handleClass, "left-0")}
            aria-label={`Resize start of zoom segment`}
            onPointerDown={(event) => beginGesture(event, "resize-start")}
            onClick={(event) => event.stopPropagation()}
          />
          <ZoomIn className="mr-1.5 size-3 shrink-0 text-primary" aria-hidden />
          <span className="relative z-10 truncate font-medium text-foreground">
            {segment.label ? (
              <span className="mr-1 text-primary">{segment.label}</span>
            ) : null}
            {segment.scale.toFixed(1)}×
            {segment.mode === "follow-cursor" ? (
              <span className="ml-1 rounded bg-primary/20 px-1 py-0.5 text-[9px] font-medium text-primary">follow</span>
            ) : segment.mode === "smooth-pan" ? (
              <span className="ml-1 rounded bg-primary/20 px-1 py-0.5 text-[9px] font-medium text-primary">pan</span>
            ) : segment.mode === "auto" ? (
              <span className="ml-1 text-[9px] font-normal text-primary/80">auto</span>
            ) : null}
          </span>
          <button
            type="button"
            className={cn(handleClass, "right-0")}
            aria-label={`Resize end of zoom segment`}
            onPointerDown={(event) => beginGesture(event, "resize-end")}
            onClick={(event) => event.stopPropagation()}
          />
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
