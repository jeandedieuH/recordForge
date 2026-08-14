import { memo } from "react"
import { formatTime } from "@recordforge/editor-core"

interface TimelineMarqueeProps {
  startMs: number
  endMs: number
  pixelsPerMs: number
  top?: number
  height?: number
}

export const TimelineMarquee = memo(function TimelineMarquee({
  startMs,
  endMs,
  pixelsPerMs,
  top = 0,
  height,
}: TimelineMarqueeProps) {
  const left = Math.min(startMs, endMs) * pixelsPerMs
  const width = Math.max(2, Math.abs(endMs - startMs) * pixelsPerMs)
  const durationMs = Math.abs(endMs - startMs)

  return (
    <div
      className="pointer-events-none absolute z-20 rounded-md border border-primary/80 bg-primary/15 shadow-[0_0_12px_rgba(9,77,178,0.25)]"
      style={{
        left: `${left}px`,
        width: `${width}px`,
        top: `${top}px`,
        bottom: height ? undefined : 0,
        height: height ? `${height}px` : undefined,
      }}
      aria-hidden
    >
      {/* Floating selection bounds tag */}
      {durationMs > 100 ? (
        <div className="absolute -top-6 left-1/2 -translate-x-1/2 rounded bg-primary px-1.5 py-0.5 font-mono text-[9px] font-bold text-white shadow-xs whitespace-nowrap">
          {formatTime(durationMs)}
        </div>
      ) : null}
    </div>
  )
})
