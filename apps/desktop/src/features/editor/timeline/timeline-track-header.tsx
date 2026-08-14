import { memo } from "react"
import type { TimelineTrack } from "@recordforge/contracts"
import {
  AudioLines,
  Captions,
  ChevronDown,
  ChevronUp,
  Headphones,
  Lock,
  LockOpen,
  Monitor,
  MousePointer2,
  Rows3,
  ShieldAlert,
  Video,
  Volume2,
  VolumeX,
  ZoomIn,
  type LucideIcon,
} from "lucide-react"
import { IconButton, cn } from "@recordforge/ui"

interface TimelineTrackHeaderProps {
  track: TimelineTrack
  selected: boolean
  collapsed: boolean
  height: number
  top: number
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
  return AudioLines
}

function getTrackAccentColor(track: TimelineTrack): {
  border: string
  text: string
  bg: string
} {
  if (track.kind === "screen") {
    return { border: "border-l-track-screen", text: "text-track-screen", bg: "bg-track-screen/10" }
  }
  if (track.kind === "camera") {
    return { border: "border-l-track-webcam", text: "text-track-webcam", bg: "bg-track-webcam/10" }
  }
  if (track.kind === "cursor") {
    return { border: "border-l-primary", text: "text-primary", bg: "bg-primary/10" }
  }
  if (track.kind === "captions") {
    return {
      border: "border-l-track-captions",
      text: "text-track-captions",
      bg: "bg-track-captions/10",
    }
  }
  if (track.kind === "effects") {
    return { border: "border-l-warning", text: "text-warning", bg: "bg-warning/10" }
  }
  if (track.kind === "zoom") {
    return { border: "border-l-primary", text: "text-primary", bg: "bg-primary/10" }
  }
  if (track.name.toLowerCase().includes("system")) {
    return { border: "border-l-track-system", text: "text-track-system", bg: "bg-track-system/10" }
  }
  return { border: "border-l-track-mic", text: "text-track-mic", bg: "bg-track-mic/10" }
}

export const TimelineTrackHeader = memo(function TimelineTrackHeader({
  track,
  selected,
  collapsed,
  height,
  top,
  onToggleTrackMuted,
  onToggleTrackSolo,
  onToggleTrackLocked,
  onToggleTrackCollapsed,
  onCycleTrackHeight,
}: TimelineTrackHeaderProps) {
  const TrackIcon = getTrackIcon(track)
  const accent = getTrackAccentColor(track)

  return (
    <div
      className={cn(
        "absolute inset-x-0 flex items-center justify-between border-b border-l-3 border-border px-2.5 transition-colors duration-fast",
        accent.border,
        selected ? "bg-overlay/60 shadow-xs" : "bg-surface hover:bg-surface-container",
        track.muted && "opacity-50",
        track.locked && "bg-surface-dim/40",
      )}
      style={{ transform: `translateY(${top}px)`, height }}
    >
      {/* Track Label and Icon */}
      <div className="flex min-w-0 items-center gap-2">
        <div className={cn("flex size-5 shrink-0 items-center justify-center rounded", accent.bg)}>
          <TrackIcon className={cn("size-3.5", accent.text)} aria-hidden />
        </div>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xs font-semibold text-foreground leading-none">
            {track.name}
          </span>
          {!collapsed && track.clips.length > 0 ? (
            <span className="text-[10px] text-subtle-foreground font-mono">
              {track.clips.length} clip{track.clips.length > 1 ? "s" : ""}
            </span>
          ) : null}
        </div>
      </div>

      {/* Control Buttons */}
      <div className="flex shrink-0 items-center gap-0.5">
        {/* Mute Button */}
        <IconButton
          label={track.muted ? `Unmute ${track.name}` : `Mute ${track.name}`}
          tooltipSide="top"
          className={cn(
            "size-6 rounded",
            track.muted
              ? "bg-destructive/20 text-destructive"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => onToggleTrackMuted(track)}
        >
          {track.muted ? <VolumeX className="size-3" /> : <Volume2 className="size-3" />}
        </IconButton>

        {/* Solo Button */}
        <IconButton
          label={track.solo ? `Unsolo ${track.name}` : `Solo ${track.name}`}
          tooltipSide="top"
          className={cn(
            "size-6 rounded",
            track.solo
              ? "bg-primary/20 text-primary font-bold shadow-xs"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => onToggleTrackSolo(track)}
        >
          <Headphones className="size-3" />
        </IconButton>

        {/* Lock Button */}
        <IconButton
          label={track.locked ? `Unlock ${track.name}` : `Lock ${track.name}`}
          tooltipSide="top"
          className={cn(
            "size-6 rounded",
            track.locked
              ? "bg-warning/20 text-warning"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => onToggleTrackLocked(track)}
        >
          {track.locked ? <Lock className="size-3" /> : <LockOpen className="size-3" />}
        </IconButton>

        {/* Collapse / Expand Toggle */}
        <IconButton
          label={collapsed ? `Expand ${track.name}` : `Collapse ${track.name}`}
          tooltipSide="top"
          className="size-6 rounded text-muted-foreground hover:text-foreground"
          onClick={() => onToggleTrackCollapsed(track)}
        >
          {collapsed ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
        </IconButton>

        {/* Height Cycle */}
        {!collapsed ? (
          <IconButton
            label={`Change ${track.name} height`}
            tooltipSide="top"
            className="size-6 rounded text-muted-foreground hover:text-foreground hidden sm:flex"
            onClick={() => onCycleTrackHeight(track)}
          >
            <Rows3 className="size-3" />
          </IconButton>
        ) : null}
      </div>
    </div>
  )
})
