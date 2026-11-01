import { memo } from "react"
import { formatTimelineTime } from "../timeline-ruler"
import { laneStyle } from "./lane-theme"
import type { TrimLimit } from "./timeline-gesture-math"

export interface TimelineGestureInfo {
  clipId: string
  trackId: string
  mode: "move" | "trim-start" | "trim-end"
  // Overrides MODE_LABELS — e.g. zoom segments "resize" rather than "trim".
  label?: string
  originalStartMs: number
  originalEndMs: number
  startMs: number
  endMs: number
  limit: TrimLimit | null
  invalid: "overlap" | null
}

export interface TimelineGestureOverlayProps {
  info: TimelineGestureInfo
  pixelsPerMs: number
  // Row bounds for info.trackId in content coordinates.
  rowBounds: { top: number; height: number }
  laneColorVar: string
  // Sticky-ruler height — chips may not paint above it.
  minTop: number
}

const MODE_LABELS: Record<TimelineGestureInfo["mode"], string> = {
  move: "Move",
  "trim-start": "Trim in",
  "trim-end": "Trim out",
}

function limitLabel(info: TimelineGestureInfo): string | null {
  switch (info.limit) {
    case "source-start":
      return "Source start"
    case "source-end":
      return "Source end"
    case "neighbor":
      return info.mode === "trim-start" ? "Previous clip" : "Next clip"
    case "min-duration":
      return "Min length"
    default:
      return null
  }
}

/**
 * Single lanes-level HUD for move/trim gestures — replaces the per-clip pill
 * that was clipped by the card's overflow-hidden. Also draws a dashed ghost
 * of the original range and, for rejected moves, a destructive box at the
 * attempted range (the store shows the original while a draft is invalid, so
 * this is the only feedback of where the drop would land).
 */
export const TimelineGestureOverlay = memo(function TimelineGestureOverlay({
  info,
  pixelsPerMs,
  rowBounds,
  laneColorVar,
  minTop,
}: TimelineGestureOverlayProps) {
  const { top, height } = rowBounds
  const rangeChanged = info.startMs !== info.originalStartMs || info.endMs !== info.originalEndMs

  const chipTop = top - 24 < minTop + 2 ? top + height + 4 : top - 24
  const anchorMs =
    info.mode === "trim-start"
      ? info.startMs
      : info.mode === "trim-end"
        ? info.endMs
        : (info.startMs + info.endMs) / 2
  const deltaMs =
    info.mode === "trim-end" ? info.endMs - info.originalEndMs : info.startMs - info.originalStartMs
  const limit = limitLabel(info)

  return (
    <div className="pointer-events-none absolute inset-0 z-50" style={laneStyle(laneColorVar)}>
      {/* Dashed ghost of the original range once the draft diverges */}
      {rangeChanged ? (
        <div
          className="absolute rounded-sm border border-dashed border-foreground/40"
          style={{
            left: `${info.originalStartMs * pixelsPerMs}px`,
            width: `${Math.max(2, (info.originalEndMs - info.originalStartMs) * pixelsPerMs)}px`,
            top: `${top + 4}px`,
            height: `${Math.max(4, height - 8)}px`,
          }}
        />
      ) : null}

      {/* Attempted range when the store rejects the draft (e.g. overlap) */}
      {info.invalid ? (
        <div
          className="absolute rounded-sm border border-destructive bg-destructive/10"
          style={{
            left: `${info.startMs * pixelsPerMs}px`,
            width: `${Math.max(2, (info.endMs - info.startMs) * pixelsPerMs)}px`,
            top: `${top + 4}px`,
            height: `${Math.max(4, height - 8)}px`,
          }}
        />
      ) : null}

      {/* Gesture HUD chip — flips below the row when there is no room above */}
      <div
        className="absolute flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border-strong bg-elevated/95 px-2 py-0.5 font-mono text-[10px] text-foreground shadow-e2 backdrop-blur-md whitespace-nowrap"
        style={{ left: `${anchorMs * pixelsPerMs}px`, top: `${chipTop}px` }}
      >
        <span className="size-1.5 rounded-full bg-lane" />
        <span className="font-semibold">{info.label ?? MODE_LABELS[info.mode]}</span>
        <span className="tabular-nums text-muted-foreground">{formatTimelineTime(anchorMs)}</span>
        <span className="tabular-nums">
          {deltaMs >= 0 ? "+" : ""}
          {(deltaMs / 1000).toFixed(2)}s
        </span>
        <span className="tabular-nums text-muted-foreground">
          · {formatTimelineTime(Math.max(0, info.endMs - info.startMs))}
        </span>
        {limit ? <span className="text-warning">{limit}</span> : null}
        {info.invalid ? (
          <span className="text-destructive">Overlaps — release to cancel</span>
        ) : null}
      </div>
    </div>
  )
})
