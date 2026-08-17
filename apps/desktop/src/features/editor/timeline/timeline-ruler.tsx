import { memo, useMemo, useRef, useState } from "react"
import type { ManualZoomSegment, TimelineMarker } from "@recordforge/contracts"
import { BookmarkPlus, Crosshair } from "lucide-react"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  cn,
} from "@recordforge/ui"

interface TimelineRulerProps {
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

export const TimelineRuler = memo(function TimelineRuler({
  timelineWidth,
  pixelsPerMs,
  visibleStartMs,
  visibleEndMs,
  durationMs,
  tickInterval,
  markers,
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
  const [isScrubbing, setIsScrubbing] = useState(false)
  const [rulerContextMenuTimeMs, setRulerContextMenuTimeMs] = useState<number | null>(null)

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
      if (minorInterval * pixelsPerMs >= 10) {
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

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    const target = e.target as HTMLElement | null
    if (
      target?.closest(
        "[data-timeline-marker], [data-timeline-zoom-pill], [role='menu'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [data-radix-menu-content], [data-radix-popper-content-wrapper]",
      )
    )
      return

    e.currentTarget.setPointerCapture(e.pointerId)
    setIsScrubbing(true)
    if (isPlaying && onPause) {
      onPause()
    }
    const timeMs = getTimelineTime(e.clientX)
    onSeek(timeMs)
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (isScrubbing) {
      const timeMs = getTimelineTime(e.clientX)
      onSeek(timeMs)
    }
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (isScrubbing) {
      setIsScrubbing(false)
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
    }
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
      className="sticky top-0 z-30 select-none border-b border-border/80 bg-surface-dim/95 backdrop-blur-md cursor-pointer"
      style={{ width: `${timelineWidth}px` }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={handleDoubleClick}
      role="presentation"
    >
      {/* Top Section: Ruler with subpixel tick marks and ContextMenu */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="relative h-7 border-b border-border/40"
            onContextMenu={(e) => {
              const target = e.target as HTMLElement | null
              if (target?.closest("[data-timeline-marker], [data-timeline-zoom-pill]")) return
              const timeMs = getTimelineTime(e.clientX)
              setRulerContextMenuTimeMs(Math.round(timeMs))
            }}
          >
            {visibleTicks.map(({ timeMs, left, isMajor }) =>
              isMajor ? (
                <div
                  key={`major-${timeMs}`}
                  className="absolute bottom-0 flex flex-col items-center -translate-x-1/2"
                  style={{ left: `${left}px` }}
                >
                  <span className="font-mono text-[9px] font-medium tabular-nums text-subtle-foreground">
                    {formatTimelineTime(timeMs)}
                  </span>
                  <div className="h-2 w-px bg-border-strong" />
                </div>
              ) : (
                <div
                  key={`minor-${timeMs}`}
                  className="absolute bottom-0 h-1 w-px -translate-x-1/2 bg-border"
                  style={{ left: `${left}px` }}
                />
              ),
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onSelect={() => {
              if (rulerContextMenuTimeMs !== null) {
                onAddMarkerAtTime(rulerContextMenuTimeMs)
              }
            }}
          >
            <BookmarkPlus className="size-3.5 mr-2" /> Add marker here (
            {formatTimelineTime(rulerContextMenuTimeMs ?? 0)})
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => {
              if (rulerContextMenuTimeMs !== null) {
                onSeek(rulerContextMenuTimeMs)
              }
            }}
          >
            <Crosshair className="size-3.5 mr-2" /> Move playhead here
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Bottom Section: Markers and Zoom Segment Overview Lane */}
      <div className="relative h-6 overflow-hidden bg-surface-container-low/50">
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
                    "group absolute top-0.5 flex h-5 max-w-36 -translate-x-1/2 items-center gap-1.5 rounded-full border px-2 text-[10px] font-medium transition-all duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                    selectedMarkerId === marker.id
                      ? "border-primary bg-primary/20 text-foreground shadow-xs ring-1 ring-primary"
                      : "border-border/60 bg-surface/90 text-muted-foreground hover:border-border hover:bg-surface hover:text-foreground",
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
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => onSeek(marker.timeMs)}>
                  Go to marker ({formatTimelineTime(marker.timeMs)})
                </ContextMenuItem>
                <ContextMenuSeparator />
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
                "absolute bottom-0.5 h-1.5 rounded-full transition-all duration-fast",
                selectedZoomId === segment.id
                  ? "bg-primary shadow-xs ring-1 ring-primary"
                  : "bg-primary/50 hover:bg-primary/80",
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
