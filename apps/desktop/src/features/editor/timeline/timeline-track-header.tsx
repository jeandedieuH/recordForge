import { memo, useEffect, useRef, useState } from "react"
import type { TimelineTrack } from "@recordforge/contracts"
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  GripVertical,
  Headphones,
  ListChecks,
  Lock,
  LockOpen,
  Pencil,
  Rows3,
  Volume2,
  VolumeX,
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
import { getTrackLaneTheme, laneStyle } from "./lanes/lane-theme"

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
  // Live drag-resize target — clamps locally to a sensible lane range.
  onSetTrackHeight?: (track: TimelineTrack, height: number) => void
  onRenameTrack?: (track: TimelineTrack, name: string) => void
  onSelectTrackClips?: (track: TimelineTrack) => void
}

const RESIZE_MIN = 36
const RESIZE_MAX = 200
const RESIZE_DEFAULT = 56

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
  onSetTrackHeight,
  onRenameTrack,
  onSelectTrackClips,
}: TimelineTrackHeaderProps) {
  const theme = getTrackLaneTheme(track)
  const TrackIcon = theme.icon

  const [isEditing, setIsEditing] = useState(false)
  const [draftName, setDraftName] = useState(track.name)
  const inputRef = useRef<HTMLInputElement>(null)
  const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null)

  useEffect(() => {
    if (isEditing) inputRef.current?.select()
  }, [isEditing])

  function startRename() {
    if (track.locked || !onRenameTrack) return
    setDraftName(track.name)
    setIsEditing(true)
  }

  function commitRename() {
    setIsEditing(false)
    const nextName = draftName.trim()
    if (nextName && nextName !== track.name) {
      onRenameTrack?.(track, nextName)
    }
  }

  function cancelRename() {
    setIsEditing(false)
    setDraftName(track.name)
  }

  function handleResizePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!onSetTrackHeight || event.button !== 0) return
    event.stopPropagation()
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeRef.current = { startY: event.clientY, startHeight: height }
  }

  function handleResizePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const resize = resizeRef.current
    if (!resize) return
    const next = Math.round(
      Math.max(
        RESIZE_MIN,
        Math.min(RESIZE_MAX, resize.startHeight + event.clientY - resize.startY),
      ),
    )
    onSetTrackHeight?.(track, next)
  }

  function handleResizePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    resizeRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="rowheader"
          aria-label={`${track.name} track header`}
          className={cn(
            "group/header absolute inset-x-0 flex items-center border-b border-border/60 px-2 pl-2.5 transition-colors duration-fast select-none",
            selected ? "bg-lane/8" : "bg-surface hover:bg-surface-container",
            track.muted && "opacity-50",
            track.locked && "bg-surface-dim/50",
            isDragging && "opacity-40 ring-1 ring-lane shadow-e2",
          )}
          style={{ ...laneStyle(theme.colorVar), transform: `translateY(${top}px)`, height }}
          onDoubleClick={() => onCycleTrackHeight(track)}
          title="Double-click name to rename; double-click header to cycle height; drag grip to reorder"
        >
          {/* Lane accent bar */}
          <div
            className={cn(
              "absolute left-1 inset-y-2 w-0.75 rounded-full",
              selected ? "bg-lane" : "bg-lane/40",
            )}
            aria-hidden
          />

          {/* Drop insertion indicator — thin lane-colored line */}
          {dropIndicator === "above" ? (
            <div className="absolute inset-x-0 top-0 h-0.5 bg-lane z-30 pointer-events-none" />
          ) : null}
          {dropIndicator === "below" ? (
            <div className="absolute inset-x-0 bottom-0 h-0.5 bg-lane z-30 pointer-events-none" />
          ) : null}

          {/* Left: Reorder Grip, Track Icon & Details */}
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {/* Tactile Drag Grip (revealed on hover so the name keeps the space) */}
            {onStartReorder ? (
              <div
                className="cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-foreground transition-all p-0.5 shrink-0 opacity-0 group-hover/header:opacity-100"
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

            <div className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-lane/15 text-lane">
              <TrackIcon className="size-3.5" aria-hidden />
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              {isEditing ? (
                <input
                  ref={inputRef}
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename()
                    if (e.key === "Escape") cancelRename()
                  }}
                  onBlur={commitRename}
                  onPointerDown={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  aria-label={`Rename ${track.name} track`}
                  className="w-full min-w-0 select-text rounded-sm border border-primary/50 bg-surface px-1 py-px text-xs font-semibold text-foreground tracking-tight leading-snug outline-none focus-visible:ring-1 focus-visible:ring-primary"
                />
              ) : (
                <span
                  className="truncate text-xs font-semibold text-foreground tracking-tight leading-snug"
                  title={
                    onRenameTrack && !track.locked
                      ? `${track.name} — double-click to rename`
                      : track.name
                  }
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    startRename()
                  }}
                >
                  {track.name}
                </span>
              )}
              {!collapsed ? (
                <div className="flex items-center gap-1 text-[10px] text-subtle-foreground leading-none">
                  <span>
                    {track.clips.length} {track.clips.length === 1 ? "clip" : "clips"}
                  </span>
                  {/* Active-state badges stay visible; buttons appear on hover */}
                  {track.muted ? (
                    <span className="rounded-sm bg-destructive/20 px-1 font-bold text-destructive">
                      M
                    </span>
                  ) : null}
                  {track.solo ? (
                    <span className="rounded-sm bg-warning/20 px-1 font-bold text-warning">S</span>
                  ) : null}
                  {track.locked ? <Lock className="size-2.5 text-warning" aria-hidden /> : null}
                </div>
              ) : null}
            </div>
          </div>

          {/* Right: Quick Channel Controls — revealed on hover/focus over a
              surface fade so they don't steal width from the name. */}
          <div
            className={cn(
              "absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-sm bg-surface/95 px-0.5 py-px shadow-e1 transition-opacity duration-fast",
              isEditing
                ? "hidden"
                : "pointer-events-none opacity-0 group-hover/header:pointer-events-auto group-hover/header:opacity-100 group-focus-within/header:pointer-events-auto group-focus-within/header:opacity-100",
            )}
          >
            <IconButton
              label={track.muted ? `Unmute ${track.name}` : `Mute ${track.name}`}
              tooltipSide="top"
              className={cn(
                "size-5 rounded transition-all duration-fast",
                track.muted
                  ? "bg-destructive/20 text-destructive border border-destructive/40"
                  : "text-muted-foreground hover:bg-overlay hover:text-foreground",
              )}
              onClick={(e) => {
                e.stopPropagation()
                onToggleTrackMuted(track)
              }}
              aria-pressed={track.muted}
            >
              {track.muted ? <VolumeX className="size-2.5" /> : <Volume2 className="size-2.5" />}
            </IconButton>

            <IconButton
              label={track.solo ? `Unsolo ${track.name}` : `Solo ${track.name}`}
              tooltipSide="top"
              className={cn(
                "size-5 rounded transition-all duration-fast",
                track.solo
                  ? "bg-warning/20 text-warning border border-warning/40 font-bold"
                  : "text-muted-foreground hover:bg-overlay hover:text-foreground",
              )}
              onClick={(e) => {
                e.stopPropagation()
                onToggleTrackSolo(track)
              }}
              aria-pressed={track.solo}
            >
              <Headphones className="size-2.5" />
            </IconButton>

            <IconButton
              label={track.locked ? `Unlock ${track.name}` : `Lock ${track.name}`}
              tooltipSide="top"
              className={cn(
                "size-5 rounded transition-all duration-fast",
                track.locked
                  ? "bg-warning/20 text-warning border border-warning/40"
                  : "text-muted-foreground hover:bg-overlay hover:text-foreground",
              )}
              onClick={(e) => {
                e.stopPropagation()
                onToggleTrackLocked(track)
              }}
              aria-pressed={track.locked}
            >
              {track.locked ? <Lock className="size-2.5" /> : <LockOpen className="size-2.5" />}
            </IconButton>

            <IconButton
              label={collapsed ? `Expand ${track.name}` : `Collapse ${track.name}`}
              tooltipSide="top"
              className="size-5 rounded text-muted-foreground hover:bg-overlay hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation()
                onToggleTrackCollapsed(track)
              }}
              aria-expanded={!collapsed}
            >
              {collapsed ? (
                <ChevronDown className="size-2.5" />
              ) : (
                <ChevronUp className="size-2.5" />
              )}
            </IconButton>

            {!collapsed ? (
              <IconButton
                label={`Cycle ${track.name} height (compact / normal / tall)`}
                tooltipSide="top"
                className="size-5 rounded text-muted-foreground hover:bg-overlay hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation()
                  onCycleTrackHeight(track)
                }}
              >
                <Rows3 className="size-2.5" />
              </IconButton>
            ) : null}
          </div>

          {/* Bottom drag-resize handle — hidden on collapsed lanes; the hover
              line previews the grab. */}
          {!collapsed && onSetTrackHeight ? (
            <div
              className="group/resize absolute inset-x-0 bottom-0 h-1.5 cursor-row-resize"
              onPointerDown={handleResizePointerDown}
              onPointerMove={handleResizePointerMove}
              onPointerUp={handleResizePointerUp}
              onPointerCancel={handleResizePointerUp}
              onDoubleClick={(e) => {
                // Reset to the default lane height; stopPropagation keeps the
                // header's own double-click height-cycle from also firing.
                e.stopPropagation()
                onSetTrackHeight(track, RESIZE_DEFAULT)
              }}
              title="Drag to resize lane — double-click to reset"
            >
              <div className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-lane opacity-0 transition-opacity group-hover/resize:opacity-100" />
            </div>
          ) : null}
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
        {onRenameTrack && !track.locked ? (
          <ContextMenuItem onSelect={startRename}>
            <Pencil className="size-3.5 mr-2" /> Rename track
          </ContextMenuItem>
        ) : null}
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
        {onSelectTrackClips && track.clips.length > 0 ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onSelectTrackClips(track)}>
              <ListChecks className="size-3.5 mr-2" /> Select all clips
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
})
