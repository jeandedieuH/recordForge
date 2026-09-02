import { useState } from "react"
import type { CanvasAspectRatio } from "@recordforge/contracts"
import { createUpdateCanvasCommand } from "@recordforge/editor-core"
import { Button, cn } from "@recordforge/ui"
import {
  ChevronDown,
  ChevronUp,
  LayoutTemplate,
  Monitor,
  Smartphone,
  Square,
  Tv,
} from "lucide-react"
import { useTimelineStore } from "../../../stores/timeline-store"
import { ASPECT_RATIO_OPTIONS } from "../panels/layout/aspect-ratio-selector"

const PADDING_PRESETS = [0, 24, 48, 64]

interface CanvasToolbarOverlayProps {
  className?: string
}

/**
 * Floating on-canvas direct layout toolbar providing 1-click aspect ratio switching,
 * canvas resolution badge, and padding presets directly over the canvas monitor.
 */
export function CanvasToolbarOverlay({ className }: CanvasToolbarOverlayProps) {
  const engine = useTimelineStore((state) => state.engine)
  const draftTimeline = useTimelineStore((state) => state.draftTimeline)
  const timeline = draftTimeline ?? engine?.history.present ?? null
  const execute = useTimelineStore((state) => state.execute)
  const [isCollapsed, setIsCollapsed] = useState(false)

  if (!timeline) return null

  const currentRatio: CanvasAspectRatio = timeline.canvas.aspectRatio ?? "16:9"
  const currentPadding = timeline.canvas.padding

  const handleSelectRatio = (ratio: CanvasAspectRatio) => {
    const option = ASPECT_RATIO_OPTIONS.find((opt) => opt.value === ratio)
    if (!option) return
    execute(
      createUpdateCanvasCommand({
        aspectRatio: option.value,
        width: option.width,
        height: option.height,
      }),
    )
  }

  const handleSelectPadding = (padding: number) => {
    execute(createUpdateCanvasCommand({ padding }))
  }

  const getRatioIcon = (ratio: CanvasAspectRatio) => {
    switch (ratio) {
      case "16:9":
        return <Monitor className="size-3" aria-hidden />
      case "9:16":
      case "4:5":
        return <Smartphone className="size-3" aria-hidden />
      case "1:1":
        return <Square className="size-3" aria-hidden />
      case "5:4":
        return <Tv className="size-3" aria-hidden />
      default:
        return <LayoutTemplate className="size-3" aria-hidden />
    }
  }

  return (
    <div
      className={cn(
        "pointer-events-auto absolute top-3 left-1/2 -translate-x-1/2 z-40 flex items-center gap-1.5 rounded-full border border-border/70 bg-background/80 px-2 py-1 shadow-e3 backdrop-blur-md transition-all",
        className,
      )}
      role="toolbar"
      aria-label="Direct canvas layout framing controls"
    >
      {isCollapsed ? (
        <button
          type="button"
          onClick={() => setIsCollapsed(false)}
          className="flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
          title="Expand canvas framing toolbar"
        >
          {getRatioIcon(currentRatio)}
          <span className="font-mono text-[10px] font-semibold text-foreground">
            {currentRatio}
          </span>
          <ChevronDown className="size-3 opacity-60" aria-hidden />
        </button>
      ) : (
        <>
          {/* Aspect Ratio Selector Pills */}
          <div className="flex items-center gap-0.5" role="radiogroup" aria-label="Aspect ratio">
            {ASPECT_RATIO_OPTIONS.map((opt) => {
              const isSelected = currentRatio === opt.value
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  title={`${opt.label} (${opt.resolution}) — ${opt.sublabel}`}
                  onClick={() => handleSelectRatio(opt.value)}
                  className={cn(
                    "flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition-all",
                    isSelected
                      ? "bg-primary text-primary-foreground shadow-xs font-semibold"
                      : "text-subtle-foreground hover:bg-surface-hover hover:text-foreground",
                  )}
                >
                  {getRatioIcon(opt.value)}
                  <span className="font-mono text-[10px]">{opt.label}</span>
                </button>
              )
            })}
          </div>

          <div className="h-3 w-px bg-border/80" aria-hidden />

          {/* Quick Padding Presets */}
          <div className="flex items-center gap-0.5" aria-label="Canvas padding">
            {PADDING_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                title={`Canvas Padding ${p}px`}
                onClick={() => handleSelectPadding(p)}
                className={cn(
                  "rounded px-1.5 py-0.5 font-mono text-[10px] font-medium transition-colors",
                  currentPadding === p
                    ? "bg-surface-dim text-foreground font-bold shadow-xs border border-border"
                    : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
                )}
              >
                {p === 0 ? "0" : `${p}`}
              </button>
            ))}
          </div>

          <div className="h-3 w-px bg-border/80" aria-hidden />

          {/* Current Resolution Badge */}
          <span className="font-mono text-[9px] text-muted-foreground px-1">
            {timeline.canvas.width}×{timeline.canvas.height}
          </span>

          {/* Collapse Button */}
          <Button
            variant="ghost"
            size="sm"
            className="size-5 p-0 text-muted-foreground hover:text-foreground"
            onClick={() => setIsCollapsed(true)}
            title="Collapse toolbar"
            aria-label="Collapse toolbar"
          >
            <ChevronUp className="size-3" aria-hidden />
          </Button>
        </>
      )}
    </div>
  )
}
