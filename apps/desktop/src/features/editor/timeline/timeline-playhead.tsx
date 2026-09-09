import { memo, useState } from "react"
import { formatTimelineTime } from "./timeline-ruler"
import { snapTime, type SnapTarget } from "@recordforge/editor-core"
import { cn } from "@recordforge/ui"

export interface TimelinePlayheadProps {
  playheadMs: number
  pixelsPerMs: number
  timelineHeight: number
  durationMs?: number
  isPlaying?: boolean
  getTimelineTime: (clientX: number) => number
  onSeek: (ms: number) => void
  onPause?: () => void
  snapTargets?: SnapTarget[]
  snapEnabled?: boolean
  snapThresholdMs?: number
  onSnapGuide?: (target: SnapTarget | null) => void
  isSplitTool?: boolean
}

export const TimelinePlayhead = memo(function TimelinePlayhead({
  playheadMs,
  pixelsPerMs,
  timelineHeight,
  durationMs,
  isPlaying,
  getTimelineTime,
  onSeek,
  onPause,
  snapTargets,
  snapEnabled = true,
  snapThresholdMs = 120,
  onSnapGuide,
  isSplitTool = false,
}: TimelinePlayheadProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [snappedLabel, setSnappedLabel] = useState<string | null>(null)
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

    const rawMs = getTimelineTime(e.clientX)
    if (snapTargets && snapEnabled && !e.altKey) {
      const snap = snapTime(rawMs, snapTargets, {
        enabled: true,
        thresholdMs: snapThresholdMs,
      })
      if (snap.snapped) {
        onSnapGuide?.(snap.target)
        setSnappedLabel(snap.target?.label ?? null)
        onSeek(snap.timeMs)
        return
      }
    }

    onSnapGuide?.(null)
    setSnappedLabel(null)
    onSeek(rawMs)
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!isDragging) return
    e.stopPropagation()
    e.preventDefault()

    const rawMs = getTimelineTime(e.clientX)
    if (snapTargets && snapEnabled && !e.altKey) {
      const snap = snapTime(rawMs, snapTargets, {
        enabled: true,
        thresholdMs: snapThresholdMs,
      })
      if (snap.snapped) {
        onSnapGuide?.(snap.target)
        setSnappedLabel(snap.target?.label ?? null)
        onSeek(snap.timeMs)
        return
      }
    }

    onSnapGuide?.(null)
    setSnappedLabel(null)
    onSeek(rawMs)
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (isDragging) {
      setIsDragging(false)
      setSnappedLabel(null)
      onSnapGuide?.(null)
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const frameMs = 1000 / 30
    if (e.key === "ArrowLeft") {
      e.preventDefault()
      e.stopPropagation()
      const delta = e.shiftKey ? 1000 : frameMs
      onSeek(Math.max(0, Math.round(playheadMs - delta)))
    } else if (e.key === "ArrowRight") {
      e.preventDefault()
      e.stopPropagation()
      const delta = e.shiftKey ? 1000 : frameMs
      const maxMs = durationMs ?? Number.MAX_SAFE_INTEGER
      onSeek(Math.min(maxMs, Math.round(playheadMs + delta)))
    } else if (e.key === "PageUp") {
      e.preventDefault()
      e.stopPropagation()
      onSeek(Math.max(0, Math.round(playheadMs - 1000)))
    } else if (e.key === "PageDown") {
      e.preventDefault()
      e.stopPropagation()
      const maxMs = durationMs ?? Number.MAX_SAFE_INTEGER
      onSeek(Math.min(maxMs, Math.round(playheadMs + 1000)))
    } else if (e.key === "Home") {
      e.preventDefault()
      e.stopPropagation()
      onSeek(0)
    } else if (e.key === "End" && durationMs !== undefined) {
      e.preventDefault()
      e.stopPropagation()
      onSeek(durationMs)
    }
  }

  return (
    <div
      className="pointer-events-none absolute top-0 bottom-0 left-0 z-40"
      style={{
        transform: `translate3d(${left}px, 0, 0)`,
        willChange: "transform",
      }}
    >
      {/* Draggable Playhead Needle Head & Handle */}
      <div
        data-timeline-playhead
        className={cn(
          "absolute top-0 -left-3.5 z-50 flex flex-col items-center select-none group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-surface-dim rounded-t-md",
          isSplitTool
            ? "pointer-events-none"
            : "pointer-events-auto cursor-grab active:cursor-grabbing",
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleKeyDown}
        title="Drag playhead to scrub timeline (Hold Alt to bypass snapping; Left/Right to step frame)"
        role="slider"
        tabIndex={0}
        aria-label="Timeline playhead"
        aria-valuenow={Math.round(playheadMs)}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, Math.round(durationMs ?? 0))}
        aria-valuetext={formatTimelineTime(playheadMs)}
      >
        {/* Floating Live Timecode Bubble when Dragging / Scrubbing */}
        {isDragging ? (
          <div className="absolute -top-7 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full border border-primary/90 bg-surface/95 px-2.5 py-0.5 font-mono text-[10px] font-bold text-foreground shadow-e3 backdrop-blur-md whitespace-nowrap animate-in fade-in zoom-in-95 duration-fast">
            <span
              className={cn(
                "size-1.5 rounded-full",
                snappedLabel ? "bg-warning animate-pulse" : "bg-primary",
              )}
            />
            <span>{formatTimelineTime(playheadMs)}</span>
            {snappedLabel ? (
              <span className="text-[9px] font-normal text-muted-foreground max-w-28 truncate">
                · {snappedLabel}
              </span>
            ) : null}
          </div>
        ) : null}

        {/* Sculpted Precision Playhead Cap */}
        <div
          className={cn(
            "flex h-5 w-7 items-center justify-center rounded-t-md bg-gradient-to-b from-primary via-primary to-primary-hover text-white shadow-e2 transition-all duration-fast",
            isDragging
              ? "scale-110 shadow-e3 ring-2 ring-primary ring-offset-1 ring-offset-surface-dim"
              : "group-hover:scale-105 group-hover:shadow-e2",
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
        className="absolute top-4 bottom-0 w-px -translate-x-1/2 bg-primary shadow-xs"
        style={{ height: `${Math.max(timelineHeight, 200)}px` }}
        aria-hidden
      />
    </div>
  )
})
