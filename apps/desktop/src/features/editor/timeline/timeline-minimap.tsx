import { memo, useCallback, useMemo, useRef, useState } from "react"
import type { TimelineState } from "@recordforge/contracts"
import { cn } from "@recordforge/ui"
import { formatTimelineTime } from "./timeline-ruler"

export interface TimelineMinimapProps {
  timeline: TimelineState
  durationMs: number
  visibleStartMs: number
  visibleEndMs: number
  playheadMs: number
  onSeek: (ms: number) => void
  onSetScrollMs: (ms: number) => void
  className?: string
}

export const TimelineMinimap = memo(function TimelineMinimap({
  timeline,
  durationMs,
  visibleStartMs,
  visibleEndMs,
  playheadMs,
  onSeek,
  onSetScrollMs,
  className,
}: TimelineMinimapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [isDraggingLens, setIsDraggingLens] = useState(false)
  const [hoverTimeMs, setHoverTimeMs] = useState<number | null>(null)
  const [hoverLeftPercent, setHoverLeftPercent] = useState<number | null>(null)
  const dragStartRef = useRef<{ clientX: number; initialScrollMs: number } | null>(null)

  const effectiveDuration = Math.max(1, durationMs)

  // Clamp visible window percentages between 0% and 100%
  const lensLeftPercent = Math.max(0, Math.min(100, (visibleStartMs / effectiveDuration) * 100))
  const visibleSpanMs = Math.max(1, visibleEndMs - visibleStartMs)
  const lensWidthPercent = Math.max(
    2,
    Math.min(100 - lensLeftPercent, (visibleSpanMs / effectiveDuration) * 100),
  )

  const playheadPercent = Math.max(0, Math.min(100, (playheadMs / effectiveDuration) * 100))

  // Flatten all track clips into color-coded mini blocks
  const miniClips = useMemo(() => {
    return timeline.tracks.flatMap((track) => {
      let colorClass = "bg-muted-foreground/40"
      if (track.kind === "screen") colorClass = "bg-track-screen/70"
      else if (track.kind === "camera") colorClass = "bg-track-webcam/70"
      else if (track.kind === "cursor") colorClass = "bg-primary/70"
      else if (track.kind === "audio") colorClass = "bg-track-mic/70"
      else if (track.kind === "captions") colorClass = "bg-track-captions/70"
      else if (track.kind === "effects") colorClass = "bg-warning/70"
      else if (track.kind === "annotations") colorClass = "bg-track-annotation/70"
      else if (track.kind === "titles") colorClass = "bg-track-title/70"
      else if (track.kind === "graphics") colorClass = "bg-track-graphic/70"
      else if (track.kind === "overlay") colorClass = "bg-secondary/70"

      return track.clips.map((clip) => {
        const left = (clip.startMs / effectiveDuration) * 100
        const width = (clip.durationMs / effectiveDuration) * 100
        return {
          id: clip.id,
          left,
          width: Math.max(0.2, width),
          colorClass,
        }
      })
    })
  }, [timeline.tracks, effectiveDuration])

  // Mini zoom segments
  const miniZoomSegments = useMemo(() => {
    return (timeline.zoomSegments ?? []).map((seg) => ({
      id: seg.id,
      left: (seg.startMs / effectiveDuration) * 100,
      width: Math.max(0.4, (seg.durationMs / effectiveDuration) * 100),
    }))
  }, [timeline.zoomSegments, effectiveDuration])

  const getTimeFromClientX = useCallback(
    (clientX: number): { timeMs: number; percent: number } => {
      const container = containerRef.current
      if (!container) return { timeMs: 0, percent: 0 }
      const rect = container.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      return { timeMs: ratio * effectiveDuration, percent: ratio * 100 }
    },
    [effectiveDuration],
  )

  // Clicking outside the viewport lens jumps both view scroll and playhead
  function handleContainerClick(e: React.MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement
    if (target.closest("[data-minimap-lens]")) return
    const { timeMs } = getTimeFromClientX(e.clientX)
    const nextScroll = Math.max(0, timeMs - visibleSpanMs / 2)
    onSetScrollMs(nextScroll)
    onSeek(timeMs)
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (isDraggingLens) return
    const { timeMs, percent } = getTimeFromClientX(e.clientX)
    setHoverTimeMs(timeMs)
    setHoverLeftPercent(percent)
  }

  function handlePointerLeave() {
    setHoverTimeMs(null)
    setHoverLeftPercent(null)
  }

  // Dragging the lens pans the timeline horizontally
  function handleLensPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setIsDraggingLens(true)
    setHoverTimeMs(null)
    setHoverLeftPercent(null)
    dragStartRef.current = {
      clientX: e.clientX,
      initialScrollMs: visibleStartMs,
    }
  }

  function handleLensPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const gesture = dragStartRef.current
    if (!gesture || !isDraggingLens || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const deltaPixels = e.clientX - gesture.clientX
    const deltaMs = (deltaPixels / rect.width) * effectiveDuration
    const nextScroll = Math.max(
      0,
      Math.min(effectiveDuration - visibleSpanMs, gesture.initialScrollMs + deltaMs),
    )
    onSetScrollMs(nextScroll)
  }

  function handleLensPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (isDraggingLens) {
      setIsDraggingLens(false)
      dragStartRef.current = null
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
    }
  }

  function handleLensKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const stepMs = e.shiftKey ? visibleSpanMs : Math.max(500, visibleSpanMs * 0.25)
    if (e.key === "ArrowLeft" || e.key === "PageUp") {
      e.preventDefault()
      e.stopPropagation()
      onSetScrollMs(Math.max(0, visibleStartMs - stepMs))
    } else if (e.key === "ArrowRight" || e.key === "PageDown") {
      e.preventDefault()
      e.stopPropagation()
      onSetScrollMs(Math.min(effectiveDuration - visibleSpanMs, visibleStartMs + stepMs))
    } else if (e.key === "Home") {
      e.preventDefault()
      e.stopPropagation()
      onSetScrollMs(0)
    } else if (e.key === "End") {
      e.preventDefault()
      e.stopPropagation()
      onSetScrollMs(Math.max(0, effectiveDuration - visibleSpanMs))
    }
  }

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label="Timeline macroscopic overview minimap"
      className={cn(
        "group/minimap relative flex h-6 w-full select-none items-center overflow-hidden border-b border-border/80 bg-surface-dim/95 px-1 backdrop-blur cursor-pointer transition-colors duration-fast hover:bg-surface-dim",
        className,
      )}
      onClick={handleContainerClick}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    >
      {/* Inner Track Lanes Micro-Canvas */}
      <div className="relative h-3.5 w-full rounded bg-surface/80 overflow-hidden border border-border/40">
        {/* Render Mini Clips */}
        {miniClips.map((clip) => (
          <div
            key={clip.id}
            className={cn("absolute inset-y-0 rounded-xs", clip.colorClass)}
            style={{ left: `${clip.left}%`, width: `${clip.width}%` }}
          />
        ))}

        {/* Render Mini Zoom Segments */}
        {miniZoomSegments.map((zoom) => (
          <div
            key={zoom.id}
            className="absolute top-0 h-1 rounded-xs bg-primary shadow-xs"
            style={{ left: `${zoom.left}%`, width: `${zoom.width}%` }}
          />
        ))}

        {/* Render Mini Markers */}
        {timeline.markers.map((marker) => {
          const markerPercent = (marker.timeMs / effectiveDuration) * 100
          return (
            <div
              key={marker.id}
              className="absolute top-0 bottom-0 z-10 w-0.5 -translate-x-1/2"
              style={{
                left: `${markerPercent}%`,
                backgroundColor: marker.color || "var(--color-primary)",
              }}
              title={`${marker.label} (${formatTimelineTime(marker.timeMs)})`}
            />
          )
        })}

        {/* Hover Needle & Floating Timecode Badge */}
        {hoverLeftPercent !== null && hoverTimeMs !== null && !isDraggingLens ? (
          <div
            className="pointer-events-none absolute inset-y-0 z-15 w-px -translate-x-1/2 bg-foreground/50 border-l border-dashed border-foreground/70"
            style={{ left: `${hoverLeftPercent}%` }}
          >
            <div className="absolute -top-5 left-1/2 -translate-x-1/2 rounded bg-surface border border-border/80 px-1 py-0.2 font-mono text-[8px] font-semibold text-foreground shadow-e1 whitespace-nowrap">
              {formatTimelineTime(hoverTimeMs)}
            </div>
          </div>
        ) : null}

        {/* Micro Playhead Needle */}
        <div
          className="absolute inset-y-0 z-20 w-0.5 -translate-x-1/2 bg-foreground shadow-xs pointer-events-none"
          style={{ left: `${playheadPercent}%` }}
        />

        {/* Interactive Viewport Window (Lens) */}
        <div
          data-minimap-lens
          role="slider"
          aria-label="Timeline viewport position"
          aria-valuenow={Math.round(visibleStartMs)}
          aria-valuemin={0}
          aria-valuemax={Math.round(effectiveDuration)}
          aria-valuetext={`${formatTimelineTime(visibleStartMs)} to ${formatTimelineTime(visibleEndMs)}`}
          tabIndex={0}
          onKeyDown={handleLensKeyDown}
          className={cn(
            "absolute inset-y-0 z-18 rounded border-2 border-primary bg-primary/25 backdrop-blur-xs transition-shadow cursor-grab active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
            isDraggingLens
              ? "border-primary shadow-e2 ring-1 ring-primary"
              : "hover:border-primary/90",
          )}
          style={{ left: `${lensLeftPercent}%`, width: `${lensWidthPercent}%` }}
          onPointerDown={handleLensPointerDown}
          onPointerMove={handleLensPointerMove}
          onPointerUp={handleLensPointerUp}
          onPointerCancel={handleLensPointerUp}
        >
          {/* Subtle Left Grip Accent */}
          <div className="absolute left-0.5 inset-y-0.5 w-0.5 rounded bg-primary/80 opacity-60" />
          {/* Subtle Right Grip Accent */}
          <div className="absolute right-0.5 inset-y-0.5 w-0.5 rounded bg-primary/80 opacity-60" />
        </div>
      </div>
    </div>
  )
})
