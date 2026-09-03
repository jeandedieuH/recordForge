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
    (clientX: number): number => {
      const container = containerRef.current
      if (!container) return 0
      const rect = container.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      return ratio * effectiveDuration
    },
    [effectiveDuration],
  )

  // Clicking outside the viewport lens jumps both view scroll and playhead
  function handleContainerClick(e: React.MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement
    if (target.closest("[data-minimap-lens]")) return
    const targetTimeMs = getTimeFromClientX(e.clientX)
    const nextScroll = Math.max(0, targetTimeMs - visibleSpanMs / 2)
    onSetScrollMs(nextScroll)
    onSeek(targetTimeMs)
  }

  // Dragging the lens pans the timeline horizontally
  function handleLensPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setIsDraggingLens(true)
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

        {/* Micro Playhead Needle */}
        <div
          className="absolute inset-y-0 z-20 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_4px_rgba(255,255,255,0.9)] pointer-events-none"
          style={{ left: `${playheadPercent}%` }}
        />

        {/* Interactive Viewport Window (Lens) */}
        <div
          data-minimap-lens
          role="slider"
          aria-label="Draggable timeline viewport lens"
          tabIndex={0}
          className={cn(
            "absolute inset-y-0 z-15 rounded border-2 border-primary bg-primary/25 backdrop-blur-xs transition-shadow cursor-grab active:cursor-grabbing",
            isDraggingLens
              ? "border-primary shadow-[0_0_10px_rgba(9,77,178,0.5)] ring-1 ring-primary"
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
