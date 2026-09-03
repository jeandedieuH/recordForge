import { memo } from "react"
import type { TimelineTrack } from "@recordforge/contracts"
import {
  ArrowDown,
  ArrowUp,
  AudioLines,
  Captions,
  ChevronDown,
  ChevronUp,
  FileImage,
  GripVertical,
  Headphones,
  Lock,
  LockOpen,
  Monitor,
  MousePointer2,
  Music,
  Rows3,
  Shapes,
  ShieldAlert,
  Type,
  Video,
  Volume2,
  VolumeX,
  ZoomIn,
  type LucideIcon,
} from "lucide-react"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  IconButton,
  cn,
} from "@recordforge/ui"

interface TimelineTrackHeaderProps {
  track: TimelineTrack
  selected: boolean
  collapsed: boolean
  height: number
  top: number
  trackIndex?: number
  totalTracks?: number
  isDragging?: boolean
  dropIndicator?: "above" | "below" | null
  onStartReorder?: (track: TimelineTrack, clientY: number) => void
  onMoveTrackDelta?: (track: TimelineTrack, delta: -1 | 1) => void
  onToggleTrackMuted: (track: TimelineTrack) => void
  onToggleTrackSolo: (track: TimelineTrack) => void
  onToggleTrackLocked: (track: TimelineTrack) => void
  onToggleTrackCollapsed: (track: TimelineTrack) => void
  onCycleTrackHeight: (track: TimelineTrack) => void
}

function getTrackIcon(track: TimelineTrack): LucideIcon {
  if (track.kind === "screen") return Monitor
  if (track.kind === "camera") return Video
  if (track.kind === "cursor") return MousePointer2
  if (track.kind === "captions") return Captions
  if (track.kind === "effects") return ShieldAlert
  if (track.kind === "zoom") return ZoomIn
  if (track.kind === "annotations") return Shapes
  if (track.kind === "titles") return Type
  if (track.kind === "graphics" || track.kind === "overlay") return FileImage
  if (track.name.toLowerCase().includes("music")) return Music
  return AudioLines
}

function getTrackAccentColor(track: TimelineTrack): {
  border: string
  text: string
  bg: string
  glow: string
} {
  if (track.kind === "annotations") {
    return {
      border: "border-l-fuchsia-500",
      text: "text-fuchsia-400",
      bg: "bg-fuchsia-500/15",
      glow: "shadow-fuchsia-500/20",
    }
  }
  if (track.kind === "titles") {
    return {
      border: "border-l-amber-500",
      text: "text-amber-400",
      bg: "bg-amber-500/15",
      glow: "shadow-amber-500/20",
    }
  }
  if (track.kind === "graphics" || track.kind === "overlay") {
    return {
      border: "border-l-cyan-500",
      text: "text-cyan-400",
      bg: "bg-cyan-500/15",
      glow: "shadow-cyan-500/20",
    }
  }
  if (track.kind === "screen") {
    return {
      border: "border-l-track-screen",
      text: "text-track-screen",
      bg: "bg-track-screen/15",
      glow: "shadow-track-screen/20",
    }
  }
  if (track.kind === "camera") {
    return {
      border: "border-l-track-webcam",
      text: "text-track-webcam",
      bg: "bg-track-webcam/15",
      glow: "shadow-track-webcam/20",
    }
  }
  if (track.kind === "cursor") {
    return {
      border: "border-l-primary",
      text: "text-primary",
      bg: "bg-primary/15",
      glow: "shadow-primary/20",
    }
  }
  if (track.kind === "captions") {
    return {
      border: "border-l-track-captions",
      text: "text-track-captions",
      bg: "bg-track-captions/15",
      glow: "shadow-track-captions/20",
    }
  }
  if (track.kind === "effects") {
    return {
      border: "border-l-warning",
      text: "text-warning",
      bg: "bg-warning/15",
      glow: "shadow-warning/20",
    }
  }
  if (track.kind === "zoom") {
    return {
      border: "border-l-primary",
      text: "text-primary",
      bg: "bg-primary/15",
      glow: "shadow-primary/20",
    }
  }
  if (track.name.toLowerCase().includes("system")) {
    return {
      border: "border-l-track-system",
      text: "text-track-system",
      bg: "bg-track-system/15",
      glow: "shadow-track-system/20",
    }
  }
  return {
    border: "border-l-track-mic",
    text: "text-track-mic",
    bg: "bg-track-mic/15",
    glow: "shadow-track-mic/20",
  }
}

export const TimelineTrackHeader = memo(function TimelineTrackHeader({
  track,
  selected,
  collapsed,
  height,
  top,
  trackIndex = 0,
  totalTracks = 1,
  isDragging = false,
  dropIndicator = null,
  onStartReorder,
  onMoveTrackDelta,
  onToggleTrackMuted,
  onToggleTrackSolo,
  onToggleTrackLocked,
  onToggleTrackCollapsed,
  onCycleTrackHeight,
}: TimelineTrackHeaderProps) {
  const TrackIcon = getTrackIcon(track)
  const accent = getTrackAccentColor(track)

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="rowheader"
          aria-label={`${track.name} track header`}
          className={cn(
            "group/header absolute inset-x-0 flex items-center justify-between border-b border-l-3 border-border/80 px-2 transition-all duration-fast select-none",
            accent.border,
            selected
              ? "bg-overlay/80 shadow-xs border-r border-r-primary/40"
              : "bg-surface hover:bg-surface-container",
            track.muted && "opacity-50",
            track.locked && "bg-surface-dim/50",
            isDragging && "opacity-40 ring-1 ring-primary shadow-e2",
          )}
          style={{ transform: `translateY(${top}px)`, height }}
          onDoubleClick={() => onCycleTrackHeight(track)}
          title="Double-click header to cycle track height; drag grip to reorder"
        >
          {/* Visual Drop Insertion Indicators */}
          {dropIndicator === "above" ? (
            <div className="absolute inset-x-0 -top-0.5 h-1 bg-primary rounded-full shadow-[0_0_8px_rgba(9,77,178,0.9)] z-30 pointer-events-none" />
          ) : null}
          {dropIndicator === "below" ? (
            <div className="absolute inset-x-0 -bottom-0.5 h-1 bg-primary rounded-full shadow-[0_0_8px_rgba(9,77,178,0.9)] z-30 pointer-events-none" />
          ) : null}

          {/* Left: Reorder Grip, Track Icon & Details */}
          <div className="flex min-w-0 items-center gap-1.5">
            {/* Tactile Drag Grip */}
            {onStartReorder ? (
              <div
                className="cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-foreground transition-colors p-0.5 shrink-0"
                onPointerDown={(e) => {
                  if (e.button === 0) {
                    e.stopPropagation()
                    onStartReorder(track, e.clientY)
                  }
                }}
                title="Drag to reorder track position"
              >
                <GripVertical className="size-3.5" />
              </div>
            ) : null}

            <div
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-md border border-border/60 shadow-xs transition-transform group-hover/header:scale-105",
                accent.bg,
                accent.glow,
              )}
            >
              <TrackIcon className={cn("size-3.5", accent.text)} aria-hidden />
            </div>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-xs font-semibold text-foreground tracking-tight leading-snug">
                {track.name}
              </span>
              {!collapsed ? (
                <div className="flex items-center gap-1.5 font-mono text-[9px] text-subtle-foreground leading-none">
                  <span>
                    {track.clips.length} {track.clips.length === 1 ? "clip" : "clips"}
                  </span>
                  {track.muted ? (
                    <span className="flex items-center gap-0.5 text-destructive font-semibold">
                      <span className="size-1 rounded-full bg-destructive animate-pulse" /> MUTED
                    </span>
                  ) : null}
                  {track.solo ? (
                    <span className="flex items-center gap-0.5 text-primary font-semibold">
                      <span className="size-1 rounded-full bg-primary animate-pulse" /> SOLO
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          {/* Right: Quick Channel Controls */}
          <div className="flex shrink-0 items-center gap-0.5">
            {/* Mute Button with LED Active State */}
            <IconButton
              label={track.muted ? `Unmute ${track.name}` : `Mute ${track.name}`}
              tooltipSide="top"
              className={cn(
                "size-6 rounded transition-all duration-fast",
                track.muted
                  ? "bg-destructive/20 text-destructive border border-destructive/40 shadow-xs"
                  : "text-muted-foreground hover:bg-overlay hover:text-foreground",
              )}
              onClick={(e) => {
                e.stopPropagation()
                onToggleTrackMuted(track)
              }}
              aria-pressed={track.muted}
            >
              {track.muted ? <VolumeX className="size-3" /> : <Volume2 className="size-3" />}
            </IconButton>

            {/* Solo Button with LED Active State */}
            <IconButton
              label={track.solo ? `Unsolo ${track.name}` : `Solo ${track.name}`}
              tooltipSide="top"
              className={cn(
                "size-6 rounded transition-all duration-fast",
                track.solo
                  ? "bg-primary/20 text-primary border border-primary/40 font-bold shadow-xs"
                  : "text-muted-foreground hover:bg-overlay hover:text-foreground",
              )}
              onClick={(e) => {
                e.stopPropagation()
                onToggleTrackSolo(track)
              }}
              aria-pressed={track.solo}
            >
              <Headphones className="size-3" />
            </IconButton>

            {/* Lock Button with Tactile State */}
            <IconButton
              label={track.locked ? `Unlock ${track.name}` : `Lock ${track.name}`}
              tooltipSide="top"
              className={cn(
                "size-6 rounded transition-all duration-fast",
                track.locked
                  ? "bg-warning/20 text-warning border border-warning/40 shadow-xs"
                  : "text-muted-foreground hover:bg-overlay hover:text-foreground",
              )}
              onClick={(e) => {
                e.stopPropagation()
                onToggleTrackLocked(track)
              }}
              aria-pressed={track.locked}
            >
              {track.locked ? <Lock className="size-3" /> : <LockOpen className="size-3" />}
            </IconButton>

            {/* Collapse / Expand Toggle */}
            <IconButton
              label={collapsed ? `Expand ${track.name}` : `Collapse ${track.name}`}
              tooltipSide="top"
              className="size-6 rounded text-muted-foreground hover:bg-overlay hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation()
                onToggleTrackCollapsed(track)
              }}
              aria-expanded={!collapsed}
            >
              {collapsed ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
            </IconButton>

            {/* Height Cycle Toggle */}
            {!collapsed ? (
              <IconButton
                label={`Cycle ${track.name} height (compact / normal / tall)`}
                tooltipSide="top"
                className="hidden sm:flex size-6 rounded text-muted-foreground hover:bg-overlay hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation()
                  onCycleTrackHeight(track)
                }}
              >
                <Rows3 className="size-3" />
              </IconButton>
            ) : null}
          </div>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent className="w-48 bg-surface border-border shadow-e2">
        {onMoveTrackDelta && trackIndex > 0 ? (
          <ContextMenuItem onSelect={() => onMoveTrackDelta(track, -1)}>
            <ArrowUp className="size-3.5 mr-2" /> Move track up
          </ContextMenuItem>
        ) : null}
        {onMoveTrackDelta && trackIndex < totalTracks - 1 ? (
          <ContextMenuItem onSelect={() => onMoveTrackDelta(track, 1)}>
            <ArrowDown className="size-3.5 mr-2" /> Move track down
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onToggleTrackMuted(track)}>
          {track.muted ? "Unmute track" : "Mute track"}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onToggleTrackSolo(track)}>
          {track.solo ? "Unsolo track" : "Solo track"}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onToggleTrackLocked(track)}>
          {track.locked ? "Unlock track" : "Lock track"}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onCycleTrackHeight(track)}>
          Cycle track height
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})
