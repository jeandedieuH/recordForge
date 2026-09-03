import { memo } from "react"
import type { SnapTarget } from "@recordforge/editor-core"
import { Bookmark, Captions, Crosshair, Film, MousePointer2 } from "lucide-react"
import { formatTimelineTime } from "./timeline-ruler"

export interface TimelineSnapBadgeProps {
  target: SnapTarget
  pixelsPerMs: number
}

function getSnapIcon(kind: SnapTarget["kind"]) {
  switch (kind) {
    case "playhead":
      return Crosshair
    case "marker":
      return Bookmark
    case "cursor-click":
      return MousePointer2
    case "caption-boundary":
      return Captions
    case "clip-edge":
    default:
      return Film
  }
}

export const TimelineSnapBadge = memo(function TimelineSnapBadge({
  target,
  pixelsPerMs,
}: TimelineSnapBadgeProps) {
  const left = Math.round(target.timeMs * pixelsPerMs)
  const Icon = getSnapIcon(target.kind)

  return (
    <div
      className="pointer-events-none absolute inset-y-0 z-35 -translate-x-1/2"
      style={{ left: `${left}px` }}
      aria-hidden
    >
      {/* Laser-Illuminated Magnetic Snapping Guide Line */}
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-primary shadow-[0_0_10px_rgba(9,77,178,1),0_0_4px_rgba(56,189,248,0.8)]" />

      {/* Floating Smart Snap Target Chip at the Top */}
      <div className="absolute top-1 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-primary/90 bg-surface/95 px-2 py-0.5 font-mono text-[10px] font-semibold text-foreground shadow-e2 backdrop-blur-md whitespace-nowrap animate-in fade-in zoom-in-95 duration-fast">
        <Icon className="size-3 shrink-0 text-primary" />
        <span className="text-primary font-bold">{target.label}</span>
        <span className="text-subtle-foreground">·</span>
        <span className="tabular-nums text-muted-foreground">
          {formatTimelineTime(target.timeMs)}
        </span>
      </div>
    </div>
  )
})
