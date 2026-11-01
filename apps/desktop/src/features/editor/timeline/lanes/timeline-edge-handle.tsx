import { memo } from "react"
import { cn } from "@recordforge/ui"

export interface TimelineEdgeHandleProps {
  edge: "start" | "end"
  // Hit-zone width in px — much wider than the visible pill so trims stay
  // grabbable on narrow clips.
  hitWidth: number
  visible: boolean
  // True while this edge is mid-gesture.
  active: boolean
  // True when the current gesture is pinned against a trim limit.
  limited: boolean
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void
}

export const TimelineEdgeHandle = memo(function TimelineEdgeHandle({
  edge,
  hitWidth,
  visible,
  active,
  limited,
  onPointerDown,
}: TimelineEdgeHandleProps) {
  return (
    <div
      aria-hidden
      data-edge-handle={edge}
      className={cn(
        "group/edge absolute inset-y-0 z-30 cursor-ew-resize",
        edge === "start" ? "left-0" : "right-0",
      )}
      style={{ width: `${hitWidth}px` }}
      onPointerDown={onPointerDown}
      onClick={(event) => event.stopPropagation()}
    >
      <div
        className={cn(
          "absolute inset-y-1 flex w-1 items-center justify-center rounded-full ring-1 ring-background/70 transition-[transform,opacity,background-color] duration-fast ease-forge",
          edge === "start" ? "left-0.5" : "right-0.5",
          visible ? "opacity-100" : "opacity-0",
          limited
            ? "bg-warning"
            : active
              ? "bg-foreground"
              : "bg-lane group-hover/edge:bg-foreground group-hover/edge:scale-x-150",
        )}
      >
        <div className="h-3 w-px bg-background/60" />
      </div>
    </div>
  )
})
