import { memo, useState } from "react"
import { formatTimelineTime } from "./timeline-ruler"
import { cn } from "@recordforge/ui"

interface TimelinePlayheadProps {
  playheadMs: number
  pixelsPerMs: number
  timelineHeight: number
  isPlaying?: boolean
  getTimelineTime: (clientX: number) => number
  onSeek: (ms: number) => void
  onPause?: () => void
  onDeselectAll?: () => void
}

export const TimelinePlayhead = memo(function TimelinePlayhead({
  playheadMs,
  pixelsPerMs,
  timelineHeight,
  isPlaying,
  getTimelineTime,
  onSeek,
  onPause,
  onDeselectAll,
}: TimelinePlayheadProps) {
  const [isDragging, setIsDragging] = useState(false)
  const left = Math.round(playheadMs * pixelsPerMs)

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setIsDragging(true)
    if (isPlaying && onPause) {
      onPause()
    }
    const timeMs = getTimelineTime(e.clientX)
    onSeek(timeMs)
    onDeselectAll?.()
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!isDragging) return
    e.stopPropagation()
    e.preventDefault()
    const timeMs = getTimelineTime(e.clientX)
    onSeek(timeMs)
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (isDragging) {
      setIsDragging(false)
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
    }
  }

  return (
    <div
      className="pointer-events-none absolute top-0 bottom-0 left-0 z-40"
      style={{
        transform: `translate3d(${left}px, 0, 0)`,
        willChange: "transform",
      }}
      aria-hidden
    >
      {/* Draggable Playhead Needle Head & Handle */}
      <div
        className="pointer-events-auto absolute top-0 -left-3.5 z-50 flex cursor-grab active:cursor-grabbing flex-col items-center select-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        title="Drag playhead to scrub (Left/Right to step frame)"
      >
        {/* Floating Live Timecode Bubble when Dragging / Scrubbing */}
        {isDragging ? (
          <div className="absolute -top-7 left-1/2 -translate-x-1/2 flex items-center rounded-full border border-primary/90 bg-surface/95 px-2.5 py-0.5 font-mono text-[10px] font-bold text-foreground shadow-e3 backdrop-blur-md whitespace-nowrap animate-in fade-in zoom-in-95">
            <span className="text-primary mr-1">●</span>
            <span>{formatTimelineTime(playheadMs)}</span>
          </div>
        ) : null}

        {/* Sculpted Anodized Teardrop Handle */}
        <div
          className={cn(
            "flex h-5 w-7 items-center justify-center rounded-t-md bg-gradient-to-b from-primary via-primary to-primary-hover text-white shadow-e2 transition-all duration-fast",
            isDragging
              ? "scale-110 shadow-[0_0_14px_rgba(9,77,178,0.6)] ring-1 ring-white/50"
              : "hover:scale-105 hover:shadow-[0_0_10px_rgba(9,77,178,0.4)]",
          )}
          style={{
            clipPath: "polygon(0% 0%, 100% 0%, 100% 68%, 50% 100%, 0% 68%)",
          }}
        >
          {/* Micro Grip / Alignment Center Notch */}
          <div className="flex flex-col items-center gap-0.5 -translate-y-0.5">
            <div className="size-1 rounded-full bg-white shadow-xs" />
          </div>
        </div>
      </div>

      {/* Laser-Illuminated High-Precision Guide Needle */}
      <div
        className="absolute top-4 bottom-0 w-px -translate-x-1/2 bg-primary shadow-[0_0_8px_rgba(9,77,178,0.9),0_0_2px_rgba(56,189,248,0.8)]"
        style={{ height: `${Math.max(timelineHeight, 200)}px` }}
      />
    </div>
  )
})
