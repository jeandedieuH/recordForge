import { memo } from "react"
import type { LucideIcon } from "lucide-react"

export interface TimelineRunLabelProps {
  name: string
  icon: LucideIcon
  startMs: number
  endMs: number
  clipCount: number
  pixelsPerMs: number
  // Horizontal scroll offset — the label sticks to the viewport edge until
  // the run's tail pushes it away.
  scrollLeftPx: number
}

function formatRunDuration(ms: number): string {
  if (ms >= 60_000) {
    const totalSeconds = ms / 1000
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds - minutes * 60
    return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`
  }
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * One sticky label per contiguous run of clips on "run"-labelled lanes
 * (screen/camera/audio/cursor) — replaces the per-clip name that used to
 * repeat on every Smart-Cut slice.
 */
export const TimelineRunLabel = memo(function TimelineRunLabel({
  name,
  icon: Icon,
  startMs,
  endMs,
  clipCount,
  pixelsPerMs,
  scrollLeftPx,
}: TimelineRunLabelProps) {
  const runStartPx = startMs * pixelsPerMs
  const runEndPx = endMs * pixelsPerMs
  const left = Math.max(runStartPx, scrollLeftPx) + 6
  const maxWidth = runEndPx - left - 6
  if (maxWidth < 56) return null

  return (
    <div
      className="pointer-events-none absolute z-25 flex items-center gap-1 rounded-sm bg-background/55 px-1.5 py-px text-[10px] font-medium text-foreground backdrop-blur-sm truncate"
      style={{ left: `${left}px`, top: "7px", maxWidth: `${maxWidth}px` }}
      aria-hidden
    >
      <Icon className="size-3 shrink-0 text-lane" aria-hidden />
      <span className="truncate">{name}</span>
      {clipCount > 1 ? (
        <span className="shrink-0 text-foreground/65 tabular-nums">· {clipCount} clips</span>
      ) : null}
      <span className="shrink-0 text-foreground/65 tabular-nums">
        · {formatRunDuration(endMs - startMs)}
      </span>
    </div>
  )
})
