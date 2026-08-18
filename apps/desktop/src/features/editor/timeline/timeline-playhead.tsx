import { memo, useState } from "react"

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
  const left = playheadMs * pixelsPerMs

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
      className="pointer-events-none absolute bottom-0 top-0 z-40"
      style={{ left: `${left}px` }}
      aria-hidden
    >
      {/* Draggable Playhead Needle Head */}
      <div
        className="pointer-events-auto absolute top-0 -left-2.5 z-50 flex cursor-ew-resize flex-col items-center select-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        title="Drag playhead to scrub"
      >
        {/* Playhead Teardrop Badge */}
        <div
          className={`flex h-4.5 w-5 items-center justify-center rounded-t-sm bg-primary text-white shadow-e2 transition-transform duration-fast ${
            isDragging ? "scale-110 shadow-primary/40" : "hover:scale-105"
          }`}
          style={{
            clipPath: "polygon(0% 0%, 100% 0%, 100% 70%, 50% 100%, 0% 70%)",
          }}
        >
          <div className="size-1 rounded-full bg-white/90" />
        </div>
      </div>

      {/* Laser-Thin Illuminated Guide Line */}
      <div
        className="absolute top-4 bottom-0 w-px -translate-x-1/2 bg-primary shadow-[0_0_6px_rgba(9,77,178,0.7)]"
        style={{ height: `${Math.max(timelineHeight, 200)}px` }}
      />
    </div>
  )
})
