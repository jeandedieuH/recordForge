import { formatTime } from "@recordforge/editor-core"
import { useTimelineStore } from "../../../stores/timeline-store"

interface TimelineRulerProps {
  width: number
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void
}

// Returns a reasonable major tick interval in ms for the current zoom.
function pickTickInterval(zoom: number): number {
  const intervals = [100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000, 120000, 300000, 600000]
  for (const interval of intervals) {
    const pixels = interval / zoom
    if (pixels >= 60) return interval
  }
  return intervals[intervals.length - 1]
}

// Horizontal time ruler that grows with the timeline.
export function TimelineRuler({ width, onClick }: TimelineRulerProps) {
  const view = useTimelineStore((state) => state.view)
  const tickMs = pickTickInterval(view.zoom)
  const ticks: number[] = []

  for (let ms = 0; ms <= view.durationMs; ms += tickMs) {
    ticks.push(ms)
  }

  return (
    <div
      className="relative h-6 border-b border-border text-xs text-foreground/60"
      style={{ width: `${width}px` }}
      onClick={onClick}
    >
      {ticks.map((ms) => (
        <div
          key={ms}
          className="absolute top-0 h-full border-l border-border pl-1"
          style={{ left: `${ms / view.zoom}px` }}
        >
          <span className="tabular-nums">{formatTime(ms)}</span>
        </div>
      ))}
    </div>
  )
}
