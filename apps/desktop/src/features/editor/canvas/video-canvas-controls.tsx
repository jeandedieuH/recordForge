import { useCallback, useEffect, useRef, useState } from "react"
import type { CanvasAspectRatio } from "@recordforge/contracts"
import { createUpdateCanvasCommand } from "@recordforge/editor-core"
import { cn } from "@recordforge/ui"
import {
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  GripHorizontal,
} from "lucide-react"
import { useTimelineStore } from "../../../stores/timeline-store"

interface VideoCanvasControlsProps {
  videoBounds: {
    left: number
    top: number
    width: number
    height: number
    scale: number
  }
  canvasWidth: number
  canvasHeight: number
  padding: number
  aspectRatio: CanvasAspectRatio | undefined
  videoPositionY: number
  onTogglePlay: () => void
  isPlaying: boolean
  disabled?: boolean
  className?: string
  style?: React.CSSProperties
  children: React.ReactNode
}

interface DragState {
  pointerId: number
  startY: number
  initialPositionY: number
  slackPx: number
  moved: boolean
}

const SNAP_THRESHOLD = 0.035

/**
 * Provides direct manipulation canvas drag gestures and floating quick-alignment
 * controls for non-16:9 project video framing.
 */
export function VideoCanvasControls({
  videoBounds,
  canvasWidth: _canvasWidth,
  canvasHeight,
  padding,
  aspectRatio,
  videoPositionY,
  onTogglePlay,
  isPlaying: _isPlaying,
  disabled = false,
  className,
  style,
  children,
}: VideoCanvasControlsProps) {
  const execute = useTimelineStore((state) => state.execute)
  const isNon16x9 = Boolean(aspectRatio && aspectRatio !== "16:9")

  const [isHovered, setIsHovered] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [activeSnap, setActiveSnap] = useState<"top" | "center" | "bottom" | null>(null)
  const [currentYPercent, setCurrentYPercent] = useState(Math.round(videoPositionY * 100))

  const dragStateRef = useRef<DragState | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isDragging) {
      setCurrentYPercent(Math.round(videoPositionY * 100))
    }
  }, [videoPositionY, isDragging])

  // Compute available vertical movement slack inside canvas content area
  const computeSlackPx = useCallback(() => {
    const contentHeightPx = canvasHeight - padding * 2 * videoBounds.scale
    return Math.max(1, contentHeightPx - videoBounds.height)
  }, [canvasHeight, padding, videoBounds.scale, videoBounds.height])

  const setPositionY = useCallback(
    (nextRatio: number, commit = false) => {
      const clamped = Math.max(0, Math.min(1, nextRatio))
      setCurrentYPercent(Math.round(clamped * 100))
      execute(createUpdateCanvasCommand({ videoPositionY: clamped }), {
        coalesce: !commit,
      })
    },
    [execute],
  )

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return

    // If 16:9, just allow click to toggle play
    if (!isNon16x9) {
      return
    }

    event.currentTarget.setPointerCapture(event.pointerId)
    const slackPx = computeSlackPx()

    dragStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      initialPositionY: videoPositionY,
      slackPx,
      moved: false,
    }
    setActiveSnap(null)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current
    if (!drag || drag.pointerId !== event.pointerId) return

    const deltaY = event.clientY - drag.startY
    if (!drag.moved && Math.abs(deltaY) < 3) {
      return
    }

    drag.moved = true
    setIsDragging(true)

    const deltaRatio = deltaY / drag.slackPx
    let nextRatio = drag.initialPositionY + deltaRatio

    // Intelligent snap to Top (0.0), Center (0.5), Bottom (1.0)
    let snapped: "top" | "center" | "bottom" | null = null
    if (Math.abs(nextRatio - 0.0) < SNAP_THRESHOLD) {
      nextRatio = 0.0
      snapped = "top"
    } else if (Math.abs(nextRatio - 0.5) < SNAP_THRESHOLD) {
      nextRatio = 0.5
      snapped = "center"
    } else if (Math.abs(nextRatio - 1.0) < SNAP_THRESHOLD) {
      nextRatio = 1.0
      snapped = "bottom"
    }

    setActiveSnap(snapped)
    setPositionY(nextRatio, false)
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current
    if (!drag || drag.pointerId !== event.pointerId) return

    dragStateRef.current = null
    setIsDragging(false)
    setActiveSnap(null)

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    if (!drag.moved) {
      // Considered a click gesture -> toggle play
      onTogglePlay()
    } else {
      // Commit the final position to undo history
      const deltaY = event.clientY - drag.startY
      const deltaRatio = deltaY / drag.slackPx
      let finalRatio = drag.initialPositionY + deltaRatio

      if (Math.abs(finalRatio - 0.0) < SNAP_THRESHOLD) finalRatio = 0.0
      else if (Math.abs(finalRatio - 0.5) < SNAP_THRESHOLD) finalRatio = 0.5
      else if (Math.abs(finalRatio - 1.0) < SNAP_THRESHOLD) finalRatio = 1.0

      setPositionY(finalRatio, true)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isNon16x9 || disabled) return

    const step = event.shiftKey ? 0.05 : 0.01

    if (event.key === "ArrowUp") {
      event.preventDefault()
      setPositionY(videoPositionY - step, true)
    } else if (event.key === "ArrowDown") {
      event.preventDefault()
      setPositionY(videoPositionY + step, true)
    } else if (event.key === "Home") {
      event.preventDefault()
      setPositionY(0.0, true)
    } else if (event.key === "End") {
      event.preventDefault()
      setPositionY(1.0, true)
    } else if (event.key === "c" || event.key === "C") {
      event.preventDefault()
      setPositionY(0.5, true)
    }
  }

  const showControls = isNon16x9 && (isHovered || isDragging)

  return (
    <div
      ref={containerRef}
      tabIndex={isNon16x9 ? 0 : -1}
      role="region"
      aria-label={
        isNon16x9
          ? `Video positioning canvas: ${currentYPercent}%. Drag or use arrow keys to reposition.`
          : "Video preview"
      }
      className={cn(
        "group relative select-none outline-none",
        isNon16x9 ? (isDragging ? "cursor-grabbing" : "cursor-grab") : "cursor-pointer",
        className,
      )}
      style={style}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onKeyDown={handleKeyDown}
      onClick={!isNon16x9 ? onTogglePlay : undefined}
    >
      {/* Video Content */}
      {children}

      {/* Snap Guidelines across Canvas */}
      {isDragging && activeSnap && (
        <div
          className={cn(
            "pointer-events-none absolute left-0 right-0 z-40 border-t-2 border-dashed border-primary/80 transition-all",
            activeSnap === "top" && "top-0",
            activeSnap === "center" && "top-1/2 -translate-y-1/2",
            activeSnap === "bottom" && "bottom-0",
          )}
        />
      )}

      {/* Direct Manipulation Frame & Guides */}
      {showControls && (
        <>
          {/* Subtle Video Framing Border */}
          <div
            className={cn(
              "pointer-events-none absolute inset-0 z-30 rounded-[inherit] transition-all",
              isDragging
                ? "ring-2 ring-primary ring-offset-1 ring-offset-background/40"
                : "ring-1 ring-primary/40 group-hover:ring-primary/70",
            )}
          />

          {/* Floating On-Canvas Drag Handle Bar & HUD */}
          <div
            className={cn(
              "absolute left-1/2 -translate-x-1/2 z-40 flex items-center gap-1.5 rounded-full px-2.5 py-1 backdrop-blur-md transition-all shadow-e3",
              isDragging
                ? "bg-primary text-primary-foreground scale-105"
                : "bg-surface/90 text-foreground border border-border/80 hover:bg-surface",
              // Place toolbar at top edge of video (or flipped inside if near top)
              videoBounds.top < 44 ? "bottom-3" : "-top-9",
            )}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <GripHorizontal className="size-3.5 opacity-60" aria-hidden />
            <span className="font-mono text-[10px] font-semibold tracking-wide">
              {currentYPercent}%{activeSnap ? ` · ${activeSnap.toUpperCase()}` : ""}
            </span>

            {/* Quick Snap Direct Buttons */}
            <div className="flex items-center gap-0.5 border-l border-border/60 pl-1.5 ml-0.5">
              <button
                type="button"
                title="Align Top (0%) [Home]"
                aria-label="Align Top"
                onClick={() => setPositionY(0.0, true)}
                className={cn(
                  "flex size-5 items-center justify-center rounded transition-colors",
                  videoPositionY === 0.0
                    ? "bg-primary/20 text-primary font-bold"
                    : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
                )}
              >
                <AlignVerticalJustifyStart className="size-3" aria-hidden />
              </button>
              <button
                type="button"
                title="Align Center (50%) [C]"
                aria-label="Align Center"
                onClick={() => setPositionY(0.5, true)}
                className={cn(
                  "flex size-5 items-center justify-center rounded transition-colors",
                  videoPositionY === 0.5
                    ? "bg-primary/20 text-primary font-bold"
                    : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
                )}
              >
                <AlignVerticalJustifyCenter className="size-3" aria-hidden />
              </button>
              <button
                type="button"
                title="Align Bottom (100%) [End]"
                aria-label="Align Bottom"
                onClick={() => setPositionY(1.0, true)}
                className={cn(
                  "flex size-5 items-center justify-center rounded transition-colors",
                  videoPositionY === 1.0
                    ? "bg-primary/20 text-primary font-bold"
                    : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
                )}
              >
                <AlignVerticalJustifyEnd className="size-3" aria-hidden />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
