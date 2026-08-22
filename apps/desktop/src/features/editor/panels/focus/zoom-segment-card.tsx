import { memo } from "react"
import type { ManualZoomSegment } from "@recordforge/contracts"
import { zoomSegmentBadges } from "@recordforge/cursor-core"
import {
  Clock,
  Lock,
  MousePointer2,
  MousePointerClick,
  Move,
  Play,
  Scissors,
  Sparkles,
  Target,
  Trash2,
  Unlock,
  ZoomIn,
} from "lucide-react"
import { Badge, IconButton, cn } from "@recordforge/ui"
import { MiniFocusThumbnail } from "./mini-focus-thumbnail"

interface ZoomSegmentCardProps {
  segment: ManualZoomSegment
  canvas: { width: number; height: number }
  selected: boolean
  isPlayheadInside: boolean
  onSelect: () => void
  onJumpToStart: () => void
  onSplit: () => void
  onToggleLock: () => void
  onDelete: () => void
}

function badgeVariant(
  variant: "default" | "secondary" | "outline" | "warning",
): "default" | "accent" | "outline" | "warning" {
  if (variant === "secondary") return "outline"
  if (variant === "default") return "accent"
  return variant
}

function formatTimecode(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  const millis = Math.floor((ms % 1000) / 10)
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${millis.toString().padStart(2, "0")}`
}

function formatDuration(ms: number): string {
  const sec = ms / 1000
  return `${sec.toFixed(2)}s`
}

function getTriggerMeta(segment: ManualZoomSegment) {
  if (segment.source === "click") {
    return {
      Icon: MousePointerClick,
      label: "Click trigger",
      style: "text-sky-400 bg-sky-500/10 border-sky-500/20",
    }
  }
  if (segment.mode === "follow-cursor") {
    return {
      Icon: MousePointer2,
      label: "Follow cursor",
      style: "text-indigo-400 bg-indigo-500/10 border-indigo-500/20",
    }
  }
  if (segment.source === "cluster") {
    return {
      Icon: Sparkles,
      label: "Action cluster",
      style: "text-purple-400 bg-purple-500/10 border-purple-500/20",
    }
  }
  if (segment.source === "dwell") {
    return {
      Icon: Clock,
      label: "Cursor dwell",
      style: "text-amber-400 bg-amber-500/10 border-amber-500/20",
    }
  }
  if (segment.mode === "smooth-pan") {
    return {
      Icon: Move,
      label: "Smooth pan",
      style: "text-teal-400 bg-teal-500/10 border-teal-500/20",
    }
  }
  return {
    Icon: Target,
    label: "Manual target",
    style: "text-blue-400 bg-blue-500/10 border-blue-500/20",
  }
}

export const ZoomSegmentCard = memo(function ZoomSegmentCard({
  segment,
  canvas,
  selected,
  isPlayheadInside,
  onSelect,
  onJumpToStart,
  onSplit,
  onToggleLock,
  onDelete,
}: ZoomSegmentCardProps) {
  const badges = zoomSegmentBadges(segment)
  const trigger = getTriggerMeta(segment)
  const TriggerIcon = trigger.Icon

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Zoom segment at ${formatTimecode(segment.startMs)}, scale ${segment.scale.toFixed(1)}x`}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        "group relative flex flex-col gap-2 rounded-xl border p-2.5 text-left transition-all duration-base select-none cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        selected
          ? "border-primary bg-primary/10 ring-1 ring-primary/30 shadow-e1"
          : "border-border/80 bg-surface-dim/60 hover:border-border-strong hover:bg-surface-dim hover:shadow-e1",
      )}
    >
      {/* Left Active/Selected Accent Bar */}
      <div
        className={cn(
          "absolute inset-y-2 left-0 w-1 rounded-r-full transition-all duration-base",
          selected
            ? "bg-primary shadow-[0_0_8px_rgba(9,77,178,0.8)]"
            : isPlayheadInside
              ? "bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.8)]"
              : "bg-transparent group-hover:bg-border-strong",
        )}
      />

      {/* Header Row: Trigger Icon + Timecodes + Scale Pill */}
      <div className="flex items-center justify-between gap-2 pl-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <div
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-md border text-xs shadow-xs",
              trigger.style,
            )}
            title={trigger.label}
          >
            <TriggerIcon className="size-3.5" aria-hidden />
          </div>
          <div className="flex flex-wrap items-baseline gap-x-1.5 min-w-0">
            <span className="font-mono text-xs font-semibold tabular-nums text-foreground">
              {formatTimecode(segment.startMs)} →{" "}
              {formatTimecode(segment.startMs + segment.durationMs)}
            </span>
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              ({formatDuration(segment.durationMs)})
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {isPlayheadInside ? (
            <span
              className="flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-400"
              title="Playhead is currently inside this zoom segment"
            >
              <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Live
            </span>
          ) : null}

          {segment.locked ? (
            <span
              className="flex items-center rounded-full border border-warning/30 bg-warning/10 p-1 text-warning"
              title="Segment is locked"
            >
              <Lock className="size-2.5" />
            </span>
          ) : null}

          <span className="inline-flex items-center gap-1 rounded-md border border-border bg-overlay px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-foreground">
            <ZoomIn className="size-3 text-primary shrink-0" aria-hidden />
            {segment.scale.toFixed(1)}×
          </span>
        </div>
      </div>

      {/* Center Row: Spatial Mini-Thumbnail + Badges */}
      <div className="flex items-center gap-2.5 pl-1">
        <MiniFocusThumbnail target={segment.target} canvas={canvas} width={44} />

        <div className="flex flex-1 flex-wrap items-center gap-1 min-w-0">
          {badges.map((badge) => (
            <Badge
              key={badge.key}
              variant={badgeVariant(badge.variant)}
              className="text-[9px] px-1.5 py-0 capitalize"
            >
              {badge.label}
            </Badge>
          ))}

          {segment.easing && segment.easing !== "smooth" ? (
            <Badge
              variant="outline"
              className="text-[9px] px-1.5 py-0 text-muted-foreground capitalize"
            >
              {segment.easing}
            </Badge>
          ) : null}

          {segment.label ? (
            <span className="truncate rounded bg-overlay px-1.5 py-0 text-[10px] text-muted-foreground font-medium">
              "{segment.label}"
            </span>
          ) : null}
        </div>
      </div>

      {/* Action Toolbar Row */}
      <div className="mt-0.5 flex items-center justify-between border-t border-border/40 pt-1.5 pl-1">
        <span className="text-[10px] text-subtle-foreground font-medium group-hover:text-muted-foreground transition-colors">
          {selected ? "Active in inspector" : "Click to select & inspect"}
        </span>

        <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          <IconButton
            label="Jump playhead to start"
            size="sm"
            variant="ghost"
            className="size-6 p-0 text-subtle-foreground hover:text-primary hover:bg-primary/10"
            onClick={onJumpToStart}
          >
            <Play className="size-3" aria-hidden />
          </IconButton>

          <IconButton
            label="Split segment at midpoint"
            size="sm"
            variant="ghost"
            className="size-6 p-0 text-subtle-foreground hover:text-foreground"
            disabled={segment.locked}
            onClick={onSplit}
          >
            <Scissors className="size-3" aria-hidden />
          </IconButton>

          <IconButton
            label={segment.locked ? "Unlock zoom segment" : "Lock zoom segment"}
            size="sm"
            variant="ghost"
            className={cn(
              "size-6 p-0",
              segment.locked
                ? "text-warning hover:text-warning hover:bg-warning/10"
                : "text-subtle-foreground hover:text-foreground",
            )}
            onClick={onToggleLock}
          >
            {segment.locked ? (
              <Lock className="size-3" aria-hidden />
            ) : (
              <Unlock className="size-3" aria-hidden />
            )}
          </IconButton>

          <IconButton
            label="Delete zoom segment"
            size="sm"
            variant="ghost"
            className="size-6 p-0 text-subtle-foreground hover:text-recording hover:bg-recording/10"
            disabled={segment.locked}
            onClick={onDelete}
          >
            <Trash2 className="size-3" aria-hidden />
          </IconButton>
        </div>
      </div>
    </div>
  )
})
