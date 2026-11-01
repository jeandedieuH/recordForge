import { memo, useImperativeHandle, useState, type Ref } from "react"
import { Scissors } from "lucide-react"
import { formatTimelineTime } from "../timeline-ruler"

export interface TimelineHoverLineHandle {
  show: (timeMs: number) => void
  hide: () => void
}

export interface TimelineHoverLineProps {
  ref: Ref<TimelineHoverLineHandle>
  pixelsPerMs: number
  variant: "hover" | "razor"
  // Content-space Y where the timecode chip pins — pass the lanes scrollTop + 2
  // so it stays at the visible ruler top while scrolling.
  chipTop: number
}

/**
 * Pointer-follow scrub/razor indicator. It owns its own visibility state and
 * is driven imperatively so mouse-move never re-renders TimelineLanes.
 */
export const TimelineHoverLine = memo(function TimelineHoverLine({
  ref,
  pixelsPerMs,
  variant,
  chipTop,
}: TimelineHoverLineProps) {
  const [timeMs, setTimeMs] = useState<number | null>(null)

  useImperativeHandle(
    ref,
    () => ({
      show(nextMs: number) {
        setTimeMs(nextMs)
      },
      hide() {
        setTimeMs(null)
      },
    }),
    [],
  )

  if (timeMs === null) return null

  return (
    <div
      className="pointer-events-none absolute inset-y-0 z-35 -translate-x-1/2"
      style={{ left: `${timeMs * pixelsPerMs}px` }}
      aria-hidden
    >
      {variant === "razor" ? (
        <>
          <div
            className="absolute flex -translate-x-1/2 items-center gap-1 rounded-md bg-destructive px-1.5 py-0.5 text-foreground shadow-e2"
            style={{ top: `${chipTop}px` }}
          >
            <Scissors className="size-3" />
            <span className="font-mono text-[10px] font-semibold leading-none">
              {formatTimelineTime(timeMs)}
            </span>
          </div>
          <div className="h-full w-px bg-destructive shadow-xs" />
        </>
      ) : (
        <>
          <div
            className="absolute -translate-x-1/2 rounded-sm bg-foreground px-1 font-mono text-[10px] text-background"
            style={{ top: `${chipTop}px` }}
          >
            {formatTimelineTime(timeMs)}
          </div>
          <div className="h-full w-px bg-foreground/25" />
        </>
      )}
    </div>
  )
})
