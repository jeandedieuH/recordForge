import { memo, useMemo, useRef, useState } from "react"
import type { ManualZoomSegment, TimelineMarker } from "@recordforge/contracts"
import { BookmarkPlus, Crosshair } from "lucide-react"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  cn,
} from "@recordforge/ui"

export interface TimelineRulerProps {
  timelineWidth: number
  pixelsPerMs: number
  visibleStartMs: number
  visibleEndMs: number
  durationMs: number
  tickInterval: number
  markers: TimelineMarker[]
  selectedMarkerId: string | null
  zoomSegments?: ManualZoomSegment[]
  selectedZoomId: string | null
  isPlaying?: boolean
  getTimelineTime: (clientX: number) => number
  onSeek: (ms: number) => void
  onPause?: () => void
  onSelectMarker: (marker: TimelineMarker) => void
  onDeleteMarker: (markerId: string) => void
  onAddMarkerAtTime: (timeMs: number) => void
  onSelectZoom: (segmentId: string) => void
  onDeselectAll?: () => void
}

export function formatTimelineTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  const millis = Math.floor((ms % 1000) / 10)
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${millis.toString().padStart(2, "0")}`
}

export function getVisibleTickInterval(pixelsPerMs: number): number {
  const TICK_INTERVALS = [
    100, 250, 500, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000,
  ]
  const minimumSpacing = 80
  return (
    TICK_INTERVALS.find((interval) => interval * pixelsPerMs >= minimumSpacing) ??
    TICK_INTERVALS[TICK_INTERVALS.length - 1]
  )
}

/**
 * Production-ready timeline ruler.
 * Note: Playhead scrubbing from the ruler is intentionally removed to avoid accidental
 * jumps and distracting hover needles. Playhead scrubbing is performed directly via
 * the Playhead handle, keyboard navigation, minimap, or transport controls.
 */
export const TimelineRuler = memo(function TimelineRuler({
  timelineWidth,
  pixelsPerMs,
  visibleStartMs,
  visibleEndMs,
  durationMs,
  tickInterval,
  markers = [],
  selectedMarkerId,
  zoomSegments = [],
  selectedZoomId,
  isPlaying,
  getTimelineTime,
  onSeek,
  onPause,
  onSelectMarker,
  onDeleteMarker,
  onAddMarkerAtTime,
  onSelectZoom,
}: TimelineRulerProps) {
  const rulerRef = useRef<HTMLDivElement>(null)
  const [contextMenuTimeMs, setContextMenuTimeMs] = useState<number | null>(null)

  // Sub-tick subdivisions: 5 minor divisions per major tick
  const minorInterval = tickInterval / 5

  const visibleTicks = useMemo(() => {
    const firstTick = Math.max(0, Math.floor(visibleStartMs / tickInterval) - 1)
    const lastTick = Math.min(
      Math.ceil(durationMs / tickInterval),
      Math.ceil(visibleEndMs / tickInterval) + 1,
    )
    const ticks: Array<{ timeMs: number; left: number; isMajor: boolean }> = []

    for (let i = firstTick; i <= lastTick; i++) {
      const majorTime = i * tickInterval
      if (majorTime <= durationMs) {
        ticks.push({
          timeMs: majorTime,
          left: majorTime * pixelsPerMs,
          isMajor: true,
        })
      }

      // Add minor sub-ticks if spacing permits
      if (minorInterval * pixelsPerMs >= 12) {
        for (let j = 1; j < 5; j++) {
          const minorTime = majorTime + j * minorInterval
          if (minorTime < durationMs && minorTime >= visibleStartMs && minorTime <= visibleEndMs) {
            ticks.push({
              timeMs: minorTime,
              left: minorTime * pixelsPerMs,
              isMajor: false,
            })
          }
        }
      }
    }
    return ticks
  }, [durationMs, minorInterval, pixelsPerMs, tickInterval, visibleEndMs, visibleStartMs])

  function handleRulerPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    const target = e.target as HTMLElement | null
    if (
      target?.closest(
        "[data-timeline-marker], [data-timeline-zoom-pill], button, [role='menuitem']",
      )
    ) {
      return
    }
    e.stopPropagation()

    if (isPlaying && onPause) {
      onPause()
    }

    const timeMs = Math.max(0, Math.min(durationMs, Math.round(getTimelineTime(e.clientX))))
    onSeek(timeMs)

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (isPlaying && onPause) {
        onPause()
      }
      const currentTimeMs = Math.max(
        0,
        Math.min(durationMs, Math.round(getTimelineTime(moveEvent.clientX))),
      )
      onSeek(currentTimeMs)
    }

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", handlePointerUp)
      window.removeEventListener("pointercancel", handlePointerUp)
    }

    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", handlePointerUp)
    window.addEventListener("pointercancel", handlePointerUp)
  }

  function handleDoubleClick(e: React.MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement | null
    if (target?.closest("[data-timeline-marker], [data-timeline-zoom-pill]")) return
    const timeMs = getTimelineTime(e.clientX)
    onAddMarkerAtTime(Math.round(timeMs))
  }

  return (
    <div
      ref={rulerRef}
      data-timeline-ruler
      className="sticky top-0 z-30 select-none border-b border-border/80 bg-surface-dim/95 backdrop-blur-md cursor-pointer transition-colors duration-fast"
      style={{ width: `${timelineWidth}px` }}
      onPointerDown={handleRulerPointerDown}
      onDoubleClick={handleDoubleClick}
      role="region"
      aria-label="Timeline timecode ruler and markers"
    >
      {/* Top Section: High-Precision Time Ticks & Context Menu */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="relative h-7 border-b border-border/40 overflow-hidden"
            onContextMenu={(e) => {
              const target = e.target as HTMLElement | null
              if (target?.closest("[data-timeline-marker], [data-timeline-zoom-pill]")) return
              const timeMs = getTimelineTime(e.clientX)
              setContextMenuTimeMs(Math.round(timeMs))
            }}
          >
            {visibleTicks.map(({ timeMs, left, isMajor }) =>
              isMajor ? (
                <div
                  key={`major-${timeMs}`}
                  className="pointer-events-none absolute bottom-0 flex flex-col items-center -translate-x-1/2"
                  style={{ left: `${left}px` }}
                >
                  <span className="font-mono text-[9px] font-medium tabular-nums text-subtle-foreground/90 tracking-tight select-none">
                    {formatTimelineTime(timeMs)}
                  </span>
                  <div className="h-2 w-px bg-border-strong" />
                </div>
              ) : (
                <div
                  key={`minor-${timeMs}`}
                  className="pointer-events-none absolute bottom-0 h-1 w-px -translate-x-1/2 bg-border/60"
                  style={{ left: `${left}px` }}
                />
              ),
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="bg-surface border-border shadow-e2">
          <ContextMenuItem
            onSelect={() => {
              if (contextMenuTimeMs !== null) {
                onAddMarkerAtTime(contextMenuTimeMs)
              }
            }}
          >
            <BookmarkPlus className="size-3.5 mr-2 text-primary" /> Add marker here (
            {formatTimelineTime(contextMenuTimeMs ?? 0)})
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => {
              if (contextMenuTimeMs !== null) {
                onSeek(contextMenuTimeMs)
              }
            }}
          >
            <Crosshair className="size-3.5 mr-2" /> Move playhead here
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Bottom Section: Markers and Zoom Segment Overview Lane */}
      <div className="relative h-6 overflow-hidden bg-surface-container-low/40">
        {/* Render Markers */}
        {markers
          .filter(
            (marker) =>
              marker.timeMs >= visibleStartMs - 5_000 && marker.timeMs <= visibleEndMs + 5_000,
          )
          .map((marker) => (
            <ContextMenu
              key={marker.id}
              onOpenChange={(open) => {
                if (open && selectedMarkerId !== marker.id) {
                  onSelectMarker(marker)
                }
              }}
            >
              <ContextMenuTrigger asChild>
                <button
                  type="button"
                  data-timeline-marker
                  className={cn(
                    "group absolute top-0.5 flex h-5 max-w-36 -translate-x-1/2 items-center gap-1.5 rounded-full border px-2 text-[10px] font-medium transition-all duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary shadow-xs cursor-pointer",
                    selectedMarkerId === marker.id
                      ? "border-primary bg-primary/25 text-foreground shadow-xs ring-1 ring-primary"
                      : "border-border/80 bg-surface/95 text-muted-foreground hover:border-primary/60 hover:bg-surface hover:text-foreground",
                  )}
                  style={{ left: `${marker.timeMs * pixelsPerMs}px` }}
                  onContextMenu={() => {
                    if (selectedMarkerId !== marker.id) {
                      onSelectMarker(marker)
                    }
                  }}
                  onClick={(e) => {
                    e.stopPropagation()
                    onSeek(marker.timeMs)
                    onSelectMarker(marker)
                  }}
                  title={`${marker.label} (${formatTimelineTime(marker.timeMs)})`}
                >
                  <span
                    className="size-2 shrink-0 rounded-full shadow-xs transition-transform group-hover:scale-125"
                    style={{ backgroundColor: marker.color }}
                  />
                  <span className="truncate">{marker.label}</span>
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent className="bg-surface border-border shadow-e2">
                <ContextMenuItem onSelect={() => onSeek(marker.timeMs)}>
                  <Crosshair className="size-3.5 mr-2" />
                  Go to marker ({formatTimelineTime(marker.timeMs)})
                </ContextMenuItem>
                <ContextMenuItem
                  className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                  onSelect={() => onDeleteMarker(marker.id)}
                >
                  Delete marker
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}

        {/* Render Zoom Segment Mini Pills on Ruler */}
        {zoomSegments
          .filter(
            (segment) =>
              segment.startMs <= visibleEndMs + 5_000 &&
              segment.startMs + segment.durationMs >= visibleStartMs - 5_000,
          )
          .map((segment) => (
            <button
              key={`zoom-mini-${segment.id}`}
              type="button"
              data-timeline-zoom-pill
              aria-label={`Zoom segment ${segment.scale}x`}
              className={cn(
                "absolute bottom-0.5 h-1.5 rounded-full transition-all duration-fast shadow-xs cursor-pointer",
                selectedZoomId === segment.id
                  ? "bg-primary shadow-xs ring-1 ring-primary"
                  : "bg-primary/60 hover:bg-primary",
              )}
              style={{
                left: `${segment.startMs * pixelsPerMs}px`,
                width: `${Math.max(6, segment.durationMs * pixelsPerMs)}px`,
              }}
              onClick={(e) => {
                e.stopPropagation()
                onSeek(segment.startMs)
                onSelectZoom(segment.id)
              }}
              title={`Zoom ${segment.scale}x (${formatTimelineTime(segment.startMs)} - ${formatTimelineTime(segment.startMs + segment.durationMs)})`}
            />
          ))}
      </div>
    </div>
  )
})
