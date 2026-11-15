import { memo, useRef, useState } from "react"
import type { CameraLayoutSegment, TimelineState, TimelineTrack } from "@recordforge/contracts"
import {
  formatTime,
  nextCameraLayoutKind,
  playheadSnapTarget,
  snapClipStart,
  snapTrimEdge,
  type SnapTarget,
} from "@recordforge/editor-core"
import { cn, IconButton } from "@recordforge/ui"
import {
  Columns2,
  EyeOff,
  Plus,
  PictureInPicture2,
  RectangleHorizontal,
  Trash2,
} from "lucide-react"
import { TimelineEdgeHandle } from "./lanes/timeline-edge-handle"
import type { TimelineGestureInfo } from "./lanes/timeline-gesture-overlay"
import { getPlayheadSnapshot } from "./use-playback-state"

export interface CameraLayoutTrackRowProps {
  timeline: TimelineState
  track: TimelineTrack
  top: number
  height: number
  pixelsPerMs: number
  visibleStartMs: number
  visibleEndMs: number
  snapTargets: SnapTarget[]
  snapEnabled: boolean
  snapThresholdMs: number
  selectedSegmentId?: string | null
  getTimelineTime: (clientX: number) => number
  onSnapGuide: (target: SnapTarget | null) => void
  onSelectCameraLayout?: (segmentId: string) => void
  onGestureHud: (info: TimelineGestureInfo | null) => void
  onAddCameraLayoutAt: (timeMs: number) => void
  onMoveCameraLayout: (
    segment: CameraLayoutSegment,
    startMs: number,
    endMs: number,
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
  onResizeCameraLayout: (
    segment: CameraLayoutSegment,
    startMs: number,
    endMs: number,
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
  onCycleCameraLayout: (segment: CameraLayoutSegment) => void
  onDeleteCameraLayout: (segment: CameraLayoutSegment) => void
}

const LAYOUT_ICONS = {
  pip: PictureInPicture2,
  fullscreen: RectangleHorizontal,
  "side-by-side": Columns2,
  hidden: EyeOff,
} as const

const LAYOUT_LABELS = {
  pip: "Picture in picture",
  fullscreen: "Fullscreen",
  "side-by-side": "Side by side",
  hidden: "Hidden",
} as const

/** Length of a layout added by double-clicking an empty part of the lane. */
const ADD_DURATION_MS = 4_000

interface LayoutGesture {
  pointerId: number
  mode: "move" | "resize-start" | "resize-end"
  initialClientX: number
  initialTimeMs: number
  initialStartMs: number
  initialEndMs: number
  moved: boolean
}

/**
 * Camera layout lane (#5), modeled on the zoom lane. Segments live in
 * `TimelineState.cameraLayouts`; this row edits their timing (drag to move,
 * edges to resize) and cycles the layout kind on click. The Layout panel card
 * keeps the numeric settings (PiP corner/size, easing, transitions).
 */
export const CameraLayoutTrackRow = memo(function CameraLayoutTrackRow({
  timeline,
  track,
  top,
  height,
  pixelsPerMs,
  visibleStartMs,
  visibleEndMs,
  snapTargets,
  snapEnabled,
  snapThresholdMs,
  selectedSegmentId,
  getTimelineTime,
  onSnapGuide,
  onSelectCameraLayout,
  onGestureHud,
  onAddCameraLayoutAt,
  onMoveCameraLayout,
  onResizeCameraLayout,
  onCycleCameraLayout,
  onDeleteCameraLayout,
}: CameraLayoutTrackRowProps) {
  const [hoverTimeMs, setHoverTimeMs] = useState<number | null>(null)

  const segments = (timeline.cameraLayouts ?? []).filter(
    (segment) =>
      segment.startMs <= visibleEndMs + 2_000 &&
      segment.startMs + segment.durationMs >= visibleStartMs - 2_000,
  )

  function handleDoubleClick(event: React.MouseEvent<HTMLDivElement>) {
    if (track.locked) return
    const target = event.target as HTMLElement
    if (target.closest("[data-camera-layout]")) return
    onAddCameraLayoutAt(Math.max(0, Math.round(getTimelineTime(event.clientX))))
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (track.locked) return
    const target = event.target as HTMLElement
    if (target.closest("[data-camera-layout]")) {
      if (hoverTimeMs !== null) setHoverTimeMs(null)
      return
    }
    setHoverTimeMs(Math.max(0, Math.round(getTimelineTime(event.clientX))))
  }

  return (
    <div
      className={cn(
        "group/camera-layout absolute inset-x-0 border-b border-border/50 transition-colors",
        track.muted && "bg-surface-dim/20 opacity-40",
        !track.locked && "cursor-crosshair",
      )}
      style={{ top, height }}
      onDoubleClick={handleDoubleClick}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => setHoverTimeMs(null)}
    >
      {hoverTimeMs !== null ? (
        <div
          aria-hidden
          className="pointer-events-none absolute flex items-center gap-1 overflow-hidden rounded-sm border border-dashed border-lane/50 bg-lane/10 px-1.5 opacity-70"
          style={{
            left: `${hoverTimeMs * pixelsPerMs}px`,
            width: `${Math.max(40, ADD_DURATION_MS * pixelsPerMs)}px`,
            top: "4px",
            height: `${Math.max(8, height - 8)}px`,
          }}
        >
          <Plus className="size-3 shrink-0 text-lane" />
          <span className="truncate font-mono text-[9px] font-medium text-lane">
            Double-click to add a camera layout
          </span>
        </div>
      ) : null}

      {segments.map((segment) => (
        <CameraLayoutSegmentItem
          key={segment.id}
          segment={segment}
          track={track}
          height={height}
          pixelsPerMs={pixelsPerMs}
          snapTargets={snapTargets}
          snapEnabled={snapEnabled}
          snapThresholdMs={snapThresholdMs}
          selected={selectedSegmentId === segment.id}
          getTimelineTime={getTimelineTime}
          onSnapGuide={onSnapGuide}
          onSelectCameraLayout={onSelectCameraLayout}
          onGestureHud={onGestureHud}
          onMoveCameraLayout={onMoveCameraLayout}
          onResizeCameraLayout={onResizeCameraLayout}
          onCycleCameraLayout={onCycleCameraLayout}
          onDeleteCameraLayout={onDeleteCameraLayout}
          nextLayout={nextCameraLayoutKind(segment.layout)}
        />
      ))}
    </div>
  )
})

interface CameraLayoutSegmentItemProps {
  segment: CameraLayoutSegment
  track: TimelineTrack
  height: number
  pixelsPerMs: number
  snapTargets: SnapTarget[]
  snapEnabled: boolean
  snapThresholdMs: number
  selected: boolean
  getTimelineTime: (clientX: number) => number
  onSnapGuide: (target: SnapTarget | null) => void
  onSelectCameraLayout?: (segmentId: string) => void
  onGestureHud: (info: TimelineGestureInfo | null) => void
  onMoveCameraLayout: CameraLayoutTrackRowProps["onMoveCameraLayout"]
  onResizeCameraLayout: CameraLayoutTrackRowProps["onResizeCameraLayout"]
  onCycleCameraLayout: CameraLayoutTrackRowProps["onCycleCameraLayout"]
  onDeleteCameraLayout: CameraLayoutTrackRowProps["onDeleteCameraLayout"]
  nextLayout: CameraLayoutSegment["layout"]
}

function CameraLayoutSegmentItem({
  segment,
  track,
  height,
  pixelsPerMs,
  snapTargets,
  snapEnabled,
  snapThresholdMs,
  selected,
  getTimelineTime,
  onSnapGuide,
  onSelectCameraLayout,
  onGestureHud,
  onMoveCameraLayout,
  onResizeCameraLayout,
  onCycleCameraLayout,
  onDeleteCameraLayout,
  nextLayout,
}: CameraLayoutSegmentItemProps) {
  const gestureRef = useRef<LayoutGesture | null>(null)
  const suppressClickRef = useRef(false)
  const [gestureMode, setGestureMode] = useState<LayoutGesture["mode"] | null>(null)
  const [hovered, setHovered] = useState(false)

  const left = segment.startMs * pixelsPerMs
  const width = Math.max(8, segment.durationMs * pixelsPerMs)
  const barHeight = Math.max(8, height - 8)
  const isLocked = track.locked || segment.locked
  const hitWidth = Math.round(Math.min(10, Math.max(4, width * 0.25)))
  const Icon = LAYOUT_ICONS[segment.layout]

  function beginGesture(event: React.PointerEvent<HTMLElement>, mode: LayoutGesture["mode"]) {
    if (event.button !== 0 || isLocked) return
    event.stopPropagation()
    event.preventDefault()
    const capture = (event.currentTarget as HTMLElement).closest(
      "[data-camera-layout]",
    ) as HTMLElement | null
    capture?.setPointerCapture(event.pointerId)
    gestureRef.current = {
      pointerId: event.pointerId,
      mode,
      initialClientX: event.clientX,
      initialTimeMs: getTimelineTime(event.clientX),
      initialStartMs: segment.startMs,
      initialEndMs: segment.startMs + segment.durationMs,
      moved: false,
    }
  }

  function applyGesture(clientX: number, altKey: boolean, phase: "draft" | "commit") {
    const gesture = gestureRef.current
    if (!gesture) return
    const deltaMs = getTimelineTime(clientX) - gesture.initialTimeMs
    const snap = { enabled: snapEnabled && !altKey, thresholdMs: snapThresholdMs }
    // Ctrl/Alt-free moves snap to clips, markers and the live playhead exactly
    // like the zoom lane.
    const targets = [...snapTargets, playheadSnapTarget(getPlayheadSnapshot())]

    function hudFor(
      mode: TimelineGestureInfo["mode"],
      startMs: number,
      endMs: number,
      label?: string,
    ): TimelineGestureInfo {
      return {
        clipId: segment.id,
        trackId: track.id,
        mode,
        ...(label ? { label } : {}),
        originalStartMs: gesture!.initialStartMs,
        originalEndMs: gesture!.initialEndMs,
        startMs,
        endMs,
        limit: null,
        invalid: null,
      }
    }

    if (gesture.mode === "move") {
      const duration = gesture.initialEndMs - gesture.initialStartMs
      const rawStartMs = Math.max(0, Math.round(gesture.initialStartMs + deltaMs))
      const snapped = snapClipStart(rawStartMs, duration, targets, snap)
      onSnapGuide(snapped.snapped ? snapped.target : null)
      if (phase === "draft") {
        onGestureHud(hudFor("move", snapped.timeMs, snapped.timeMs + duration))
      }
      onMoveCameraLayout(segment, snapped.timeMs, snapped.timeMs + duration, { phase })
      return
    }

    const edge = gesture.mode === "resize-start" ? "start" : "end"
    const rawEdgeMs =
      edge === "start"
        ? Math.max(0, Math.round(gesture.initialStartMs + deltaMs))
        : Math.max(0, Math.round(gesture.initialEndMs + deltaMs))
    const snapped = snapTrimEdge(edge, rawEdgeMs, targets, snap)
    onSnapGuide(snapped.snapped ? snapped.target : null)
    if (edge === "start") {
      const startMs = Math.max(0, Math.min(snapped.timeMs, gesture.initialEndMs - 1))
      if (phase === "draft") {
        onGestureHud(hudFor("trim-start", startMs, gesture.initialEndMs, "Resize in"))
      }
      onResizeCameraLayout(segment, startMs, gesture.initialEndMs, { phase })
      return
    }
    const endMs = Math.max(snapped.timeMs, gesture.initialStartMs + 1)
    if (phase === "draft") {
      onGestureHud(hudFor("trim-end", gesture.initialStartMs, endMs, "Resize out"))
    }
    onResizeCameraLayout(segment, gesture.initialStartMs, endMs, { phase })
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    if (!gesture.moved && Math.abs(event.clientX - gesture.initialClientX) < 3) return
    gesture.moved = true
    suppressClickRef.current = true
    setGestureMode(gesture.mode)
    event.preventDefault()
    applyGesture(event.clientX, event.altKey, "draft")
  }

  function finishGesture(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const moved = gesture.moved
    gestureRef.current = null
    setGestureMode(null)
    onSnapGuide(null)
    onGestureHud(null)
    if (!moved) {
      suppressClickRef.current = false
      return
    }
    applyGesture(event.clientX, event.altKey, "commit")
    onSnapGuide(null)
  }

  return (
    <div
      data-camera-layout
      role="button"
      tabIndex={0}
      aria-label={`${LAYOUT_LABELS[segment.layout]} camera layout at ${formatTime(segment.startMs)}`}
      title={`${LAYOUT_LABELS[segment.layout]} · ${formatTime(segment.startMs)} → ${formatTime(
        segment.startMs + segment.durationMs,
      )} — drag to move, edges to trim, double-click to switch to ${LAYOUT_LABELS[nextLayout]}`}
      className={cn(
        "group/layout absolute top-1 flex select-none items-center gap-1 overflow-hidden rounded-sm border bg-lane/15 px-1 text-lane outline-none transition-[background-color,box-shadow,opacity] duration-fast ease-forge",
        segment.enabled ? "border-lane/50" : "border-dashed border-lane/30 opacity-60",
        selected && "z-20 bg-lane/30 ring-2 ring-foreground",
        gestureMode === "move"
          ? "z-30 cursor-grabbing bg-lane/30 ring-2 ring-foreground"
          : gestureMode
            ? "z-30 cursor-ew-resize ring-2 ring-foreground"
            : isLocked
              ? "cursor-not-allowed opacity-60"
              : "cursor-grab hover:bg-lane/25",
        "focus-visible:ring-2 focus-visible:ring-foreground",
      )}
      style={{ left: `${left}px`, width: `${width}px`, height: `${barHeight}px` }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onPointerDown={(event) => beginGesture(event, "move")}
      onPointerMove={handlePointerMove}
      onPointerUp={finishGesture}
      onPointerCancel={finishGesture}
      onLostPointerCapture={(event) => {
        if (gestureRef.current) finishGesture(event)
      }}
      onClick={(event) => {
        event.stopPropagation()
        if (suppressClickRef.current) {
          suppressClickRef.current = false
          return
        }
        onSelectCameraLayout?.(segment.id)
      }}
      onDoubleClick={(event) => {
        // Double-click cycles the layout; a click selects the segment.
        event.stopPropagation()
        if (!isLocked) onCycleCameraLayout(segment)
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onSelectCameraLayout?.(segment.id)
        }
        if (isLocked) return
        if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault()
          onDeleteCameraLayout(segment)
        }
      }}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      {width > 54 ? (
        <span className="truncate font-mono text-[9px] font-medium">
          {LAYOUT_LABELS[segment.layout]}
        </span>
      ) : null}
      {!isLocked ? (
        <span className="relative z-40 ml-auto shrink-0 opacity-0 transition-opacity group-hover/layout:opacity-100 group-focus-within/layout:opacity-100">
          <IconButton
            label={`Delete the ${LAYOUT_LABELS[segment.layout]} layout at ${formatTime(segment.startMs)}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              onDeleteCameraLayout(segment)
            }}
          >
            <Trash2 className="size-3" aria-hidden />
          </IconButton>
        </span>
      ) : null}
      {!isLocked ? (
        <TimelineEdgeHandle
          edge="start"
          hitWidth={hitWidth}
          visible={hovered || gestureMode === "resize-start"}
          active={gestureMode === "resize-start"}
          limited={false}
          onPointerDown={(event) => beginGesture(event, "resize-start")}
        />
      ) : null}
      {!isLocked ? (
        <TimelineEdgeHandle
          edge="end"
          hitWidth={hitWidth}
          visible={hovered || gestureMode === "resize-end"}
          active={gestureMode === "resize-end"}
          limited={false}
          onPointerDown={(event) => beginGesture(event, "resize-end")}
        />
      ) : null}
    </div>
  )
}
