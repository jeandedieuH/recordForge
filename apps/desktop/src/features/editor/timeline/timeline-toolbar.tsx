import { useState } from "react"
import {
  ChevronsLeft,
  ChevronsRight,
  Compass,
  Flag,
  Keyboard,
  Magnet,
  Maximize2,
  MousePointer2,
  Pause,
  Play,
  ScanLine,
  Scissors,
  ShieldAlert,
  SkipBack,
  SkipForward,
  Sparkles,
  StepBack,
  StepForward,
  Trash2,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SimpleSelect,
  Slider,
  Switch,
  cn,
} from "@recordforge/ui"
import { formatTime } from "@recordforge/editor-core"
import type { MaskClip, TimelineMarker, ZoomPreset } from "@recordforge/contracts"
import { formatTimelineTime } from "./timeline-ruler"
import { parseTimecode } from "./timeline-navigation"
import { TimelineShortcutsDialog } from "./timeline-shortcuts-dialog"

export type TimelineTool = "select" | "split" | "range"

export interface TimelineToolbarProps {
  tool: TimelineTool
  onSelectTool: (tool: TimelineTool) => void
  snapEnabled: boolean
  snapThresholdMs: number
  onToggleSnap: (enabled: boolean) => void
  onChangeSnapThreshold: (thresholdMs: number) => void
  playheadMs: number
  durationMs: number
  isPlaying: boolean
  playbackRate: number
  zoom: number
  canRippleDelete?: boolean
  selectedRange?: { startMs: number; endMs: number } | null
  showMinimap?: boolean
  markers?: TimelineMarker[]
  onToggleMinimap?: () => void
  onTogglePlay: () => void
  onSeek: (timeMs: number) => void
  onStepFrame: (direction: -1 | 1) => void
  onJumpPreviousCut?: () => void
  onJumpNextCut?: () => void
  onSetPlaybackRate: (rate: number) => void
  onSetZoom: (zoom: number) => void
  onZoomToFit: () => void
  onAddMarker: () => void
  onAddMask: (mode: MaskClip["mode"]) => void
  onAddZoom?: (options?: { preset?: ZoomPreset; scale?: number }) => void
  onSplitAtPlayhead: () => void
  onRippleDeleteSelected: () => void
}

export function TimelineToolbar({
  tool,
  onSelectTool,
  snapEnabled,
  snapThresholdMs,
  onToggleSnap,
  onChangeSnapThreshold,
  playheadMs,
  durationMs,
  isPlaying,
  playbackRate,
  zoom,
  canRippleDelete = false,
  selectedRange = null,
  showMinimap = true,
  markers = [],
  onToggleMinimap,
  onTogglePlay,
  onSeek,
  onStepFrame,
  onJumpPreviousCut,
  onJumpNextCut,
  onSetPlaybackRate,
  onSetZoom,
  onZoomToFit,
  onAddMarker,
  onAddMask,
  onAddZoom,
  onSplitAtPlayhead,
  onRippleDeleteSelected,
}: TimelineToolbarProps) {
  const [snapPopoverOpen, setSnapPopoverOpen] = useState(false)
  const [jumpTimePopoverOpen, setJumpTimePopoverOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [jumpInputText, setJumpInputText] = useState("")
  const [jumpError, setJumpError] = useState(false)

  function adjustZoom(delta: number) {
    onSetZoom(Math.max(0, Math.min(100, Math.round(zoom + delta))))
  }

  function handleJumpSubmit(e: React.FormEvent) {
    e.preventDefault()
    const parsedMs = parseTimecode(jumpInputText, durationMs, playheadMs)
    if (parsedMs !== null) {
      onSeek(parsedMs)
      setJumpTimePopoverOpen(false)
      setJumpInputText("")
      setJumpError(false)
    } else {
      setJumpError(true)
    }
  }

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-dim/95 px-3 py-1.5 backdrop-blur-md select-none transition-colors duration-fast"
      role="toolbar"
      aria-label="Timeline editing and transport controls"
    >
      <TimelineShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />

      {/* Cluster 1: Tools & Quick Actions */}
      <div className="flex items-center gap-1.5">
        {/* Tool Mode Pill Selector */}
        <div
          className="flex items-center rounded-lg border border-border/80 bg-surface/90 p-0.5 shadow-e1"
          role="radiogroup"
          aria-label="Active editing tool"
        >
          <IconButton
            label="Selection tool"
            shortcut="V"
            tooltipSide="top"
            className={cn(
              "size-7 rounded-md transition-all duration-fast",
              tool === "select"
                ? "bg-primary text-white shadow-xs font-semibold"
                : "text-muted-foreground hover:bg-overlay hover:text-foreground",
            )}
            onClick={() => onSelectTool("select")}
            aria-checked={tool === "select"}
            role="radio"
          >
            <MousePointer2 className="size-3.5" />
          </IconButton>
          <IconButton
            label="Razor / Split tool"
            shortcut="C"
            tooltipSide="top"
            className={cn(
              "size-7 rounded-md transition-all duration-fast",
              tool === "split"
                ? "bg-primary text-white shadow-xs font-semibold"
                : "text-muted-foreground hover:bg-overlay hover:text-foreground",
            )}
            onClick={() => onSelectTool(tool === "split" ? "select" : "split")}
            aria-checked={tool === "split"}
            role="radio"
          >
            <Scissors className="size-3.5" />
          </IconButton>
          <IconButton
            label="Range selection tool"
            shortcut="R"
            tooltipSide="top"
            className={cn(
              "size-7 rounded-md transition-all duration-fast",
              tool === "range"
                ? "bg-primary text-white shadow-xs font-semibold"
                : "text-muted-foreground hover:bg-overlay hover:text-foreground",
            )}
            onClick={() => onSelectTool("range")}
            aria-checked={tool === "range"}
            role="radio"
          >
            <ScanLine className="size-3.5" />
          </IconButton>
        </div>

        <div className="h-4 w-px bg-border/60" />

        {/* Magnetic Snapping Popover */}
        <Popover open={snapPopoverOpen} onOpenChange={setSnapPopoverOpen}>
          <PopoverTrigger asChild>
            <Button
              variant={snapEnabled ? "secondary" : "ghost"}
              size="sm"
              className={cn(
                "h-7 gap-1.5 px-2 text-xs font-medium transition-all duration-fast",
                snapEnabled &&
                  "border border-primary/40 bg-primary/15 text-primary hover:bg-primary/25 shadow-xs",
              )}
              aria-label="Timeline snapping settings"
            >
              <Magnet
                className={cn("size-3.5", snapEnabled ? "text-primary" : "text-muted-foreground")}
              />
              <span className="hidden sm:inline">Snap</span>
              <span className="font-mono text-[10px] opacity-75">{snapThresholdMs}ms</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-56 p-3 bg-surface border-border shadow-e2" align="start">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-foreground">Timeline Snapping</span>
                <Switch
                  checked={snapEnabled}
                  onCheckedChange={onToggleSnap}
                  aria-label="Toggle magnetic snapping"
                />
              </div>
              <div className="space-y-1.5 pt-1">
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>Snap Tolerance</span>
                  <span className="font-mono font-medium text-foreground">
                    {snapThresholdMs} ms
                  </span>
                </div>
                <div className="grid grid-cols-4 gap-1">
                  {[60, 120, 240, 480].map((threshold) => (
                    <Button
                      key={threshold}
                      variant={snapThresholdMs === threshold ? "secondary" : "ghost"}
                      size="sm"
                      className={cn(
                        "h-6 px-1 text-[10px] font-mono",
                        snapThresholdMs === threshold && "bg-primary/20 text-primary font-bold",
                      )}
                      onClick={() => onChangeSnapThreshold(threshold)}
                    >
                      {threshold}ms
                    </Button>
                  ))}
                </div>
              </div>
              <p className="text-[10px] text-subtle-foreground">
                Hold{" "}
                <kbd className="rounded border border-border bg-surface px-1 py-0.5 font-mono text-[9px]">
                  Alt
                </kbd>{" "}
                while dragging to temporarily bypass magnetic snap.
              </p>
            </div>
          </PopoverContent>
        </Popover>

        {/* Split at Playhead */}
        <IconButton
          label="Split selected at playhead"
          shortcut="S"
          tooltipSide="top"
          className="size-7 text-muted-foreground hover:text-foreground"
          onClick={onSplitAtPlayhead}
        >
          <Scissors className="size-3.5" />
        </IconButton>

        {/* Add Marker */}
        <IconButton
          label="Add marker at playhead"
          shortcut="M"
          tooltipSide="top"
          className="size-7 text-muted-foreground hover:text-foreground"
          onClick={onAddMarker}
        >
          <Flag className="size-3.5" />
        </IconButton>

        {/* Privacy Masks Dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
              aria-label="Privacy mask presets"
            >
              <ShieldAlert className="size-3.5 text-warning" />
              <span className="hidden md:inline">Mask</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-40 bg-surface border-border shadow-e2">
            <DropdownMenuLabel className="text-xs">Add Privacy Mask</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onAddMask("blur")}>
              <span className="size-2 rounded-full bg-info mr-2" />
              Gaussian Blur
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onAddMask("pixelate")}>
              <span className="size-2 rounded-full bg-warning mr-2" />
              Pixelate
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onAddMask("redact")}>
              <span className="size-2 rounded-full bg-destructive mr-2" />
              Solid Redact
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Smart Zoom Dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:bg-primary/10 hover:text-primary transition-all duration-fast"
              aria-label="Add zoom segment (Z)"
            >
              <ZoomIn className="size-3.5 text-primary" />
              <span className="hidden md:inline font-medium">Zoom</span>
              <kbd className="hidden lg:inline-block rounded border border-border/80 bg-surface/80 px-1 py-0.2 font-mono text-[9px] text-muted-foreground">
                Z
              </kbd>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60 bg-surface border-border shadow-e2">
            <DropdownMenuLabel className="flex items-center justify-between text-xs">
              <span className="font-semibold text-foreground">Add Smart Zoom</span>
              <kbd className="font-mono text-[10px] text-muted-foreground">Z</kbd>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {selectedRange ? (
              <>
                <DropdownMenuItem
                  className="bg-primary/10 text-primary font-medium focus:bg-primary/20 focus:text-primary cursor-pointer"
                  onClick={() => onAddZoom?.({ preset: "product-demo" })}
                >
                  <Sparkles className="size-3.5 mr-2 text-primary shrink-0" />
                  <div className="flex flex-col min-w-0">
                    <span className="font-semibold text-xs truncate">Zoom Selected Range</span>
                    <span className="font-mono text-[10px] opacity-80 truncate">
                      {formatTime(selectedRange.startMs)} → {formatTime(selectedRange.endMs)}
                    </span>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem
              className="cursor-pointer py-1.5"
              onClick={() => onAddZoom?.({ preset: "product-demo" })}
            >
              <div className="flex flex-col gap-0.5 w-full">
                <div className="flex items-center justify-between text-xs font-medium">
                  <span>Standard Focus (1.5×)</span>
                  <span className="font-mono text-[10px] text-muted-foreground">Smooth</span>
                </div>
                <span className="text-[10px] text-muted-foreground">Auto-tracks active cursor</span>
              </div>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="cursor-pointer py-1.5"
              onClick={() => onAddZoom?.({ preset: "developer" })}
            >
              <div className="flex flex-col gap-0.5 w-full">
                <div className="flex items-center justify-between text-xs font-medium">
                  <span>Detail Close-up (2.0×)</span>
                  <span className="font-mono text-[10px] text-muted-foreground">Snappy</span>
                </div>
                <span className="text-[10px] text-muted-foreground">Crisp focus for code & UI</span>
              </div>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="cursor-pointer py-1.5"
              onClick={() => onAddZoom?.({ preset: "cinematic" })}
            >
              <div className="flex flex-col gap-0.5 w-full">
                <div className="flex items-center justify-between text-xs font-medium">
                  <span>Cinematic Pan (1.8×)</span>
                  <span className="font-mono text-[10px] text-muted-foreground">Cinematic</span>
                </div>
                <span className="text-[10px] text-muted-foreground">Smooth gliding camera</span>
              </div>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="cursor-pointer py-1.5"
              onClick={() => onAddZoom?.({ preset: "subtle" })}
            >
              <div className="flex flex-col gap-0.5 w-full">
                <div className="flex items-center justify-between text-xs font-medium">
                  <span>Subtle Zoom (1.25×)</span>
                  <span className="font-mono text-[10px] text-muted-foreground">Gentle</span>
                </div>
                <span className="text-[10px] text-muted-foreground">Light emphasis</span>
              </div>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="cursor-pointer py-1.5"
              onClick={() => onAddZoom?.({ preset: "manual-only" })}
            >
              <div className="flex flex-col gap-0.5 w-full">
                <div className="flex items-center justify-between text-xs font-medium">
                  <span>Fixed Center (1.5×)</span>
                  <span className="font-mono text-[10px] text-muted-foreground">Static</span>
                </div>
                <span className="text-[10px] text-muted-foreground">Centered screen frame</span>
              </div>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {canRippleDelete ? (
          <IconButton
            label="Ripple delete selected (Shift+Del)"
            shortcut="Shift+Del"
            tooltipSide="top"
            className="size-7 text-destructive hover:bg-destructive/10"
            onClick={onRippleDeleteSelected}
          >
            <Trash2 className="size-3.5" />
          </IconButton>
        ) : null}
      </div>

      {/* Cluster 2: Transport & Precision Navigation */}
      <div className="flex items-center gap-1 sm:gap-1.5">
        {/* Jump to Start */}
        <IconButton
          label="Go to start"
          shortcut="Home"
          tooltipSide="top"
          className="size-7 text-muted-foreground hover:text-foreground"
          onClick={() => onSeek(0)}
        >
          <SkipBack className="size-3.5" />
        </IconButton>

        {/* Jump to Previous Cut / Marker */}
        {onJumpPreviousCut ? (
          <IconButton
            label="Jump to previous cut / marker"
            shortcut="↑"
            tooltipSide="top"
            className="size-7 text-muted-foreground hover:text-foreground"
            onClick={onJumpPreviousCut}
          >
            <ChevronsLeft className="size-3.5" />
          </IconButton>
        ) : null}

        {/* Step Backward 1 Frame */}
        <IconButton
          label="Step backward 1 frame"
          shortcut="←"
          tooltipSide="top"
          className="size-7 text-muted-foreground hover:text-foreground"
          onClick={() => onStepFrame(-1)}
        >
          <StepBack className="size-3.5" />
        </IconButton>

        {/* Main Play/Pause Button */}
        <Button
          size="icon"
          className={cn(
            "size-8 rounded-full shadow-e2 transition-transform active:scale-95",
            isPlaying
              ? "bg-primary text-white hover:bg-primary-hover ring-2 ring-primary/40"
              : "bg-primary text-white hover:bg-primary-hover",
          )}
          onClick={onTogglePlay}
          aria-label={isPlaying ? "Pause preview (Space)" : "Play preview (Space)"}
        >
          {isPlaying ? (
            <Pause className="size-4 fill-current" />
          ) : (
            <Play className="size-4 fill-current translate-x-0.5" />
          )}
        </Button>

        {/* Step Forward 1 Frame */}
        <IconButton
          label="Step forward 1 frame"
          shortcut="→"
          tooltipSide="top"
          className="size-7 text-muted-foreground hover:text-foreground"
          onClick={() => onStepFrame(1)}
        >
          <StepForward className="size-3.5" />
        </IconButton>

        {/* Jump to Next Cut / Marker */}
        {onJumpNextCut ? (
          <IconButton
            label="Jump to next cut / marker"
            shortcut="↓"
            tooltipSide="top"
            className="size-7 text-muted-foreground hover:text-foreground"
            onClick={onJumpNextCut}
          >
            <ChevronsRight className="size-3.5" />
          </IconButton>
        ) : null}

        {/* Jump to End */}
        <IconButton
          label="Go to end"
          shortcut="End"
          tooltipSide="top"
          className="size-7 text-muted-foreground hover:text-foreground"
          onClick={() => onSeek(durationMs)}
        >
          <SkipForward className="size-3.5" />
        </IconButton>

        {/* Interactive Clickable Timecode Badge & Jump-To Popover */}
        <Popover
          open={jumpTimePopoverOpen}
          onOpenChange={(open) => {
            setJumpTimePopoverOpen(open)
            if (open) {
              setJumpError(false)
            }
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-md border border-border/80 bg-surface/90 px-2 py-0.5 font-mono text-xs shadow-xs transition-all duration-fast hover:border-primary/60 hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary cursor-pointer"
              title="Click to jump to specific timestamp or marker"
              aria-label={`Current playhead ${formatTimelineTime(playheadMs)} of total ${formatTimelineTime(durationMs)}. Click to jump to timecode.`}
            >
              <span className="font-semibold tabular-nums text-foreground">
                {formatTimelineTime(playheadMs)}
              </span>
              <span className="text-subtle-foreground font-sans">/</span>
              <span className="tabular-nums text-muted-foreground">
                {formatTimelineTime(durationMs)}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-3 bg-surface border-border shadow-e2" align="center">
            <form onSubmit={handleJumpSubmit} className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-foreground">Jump to Timestamp</span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  MM:SS, sec, or ±offset
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  placeholder="e.g. 01:23, +5, or -10"
                  value={jumpInputText}
                  aria-label="Target timecode, seconds, or relative offset"
                  onChange={(e) => {
                    setJumpInputText(e.target.value)
                    if (jumpError) setJumpError(false)
                  }}
                  className={cn(
                    "flex-1 h-7 rounded border bg-surface-dim px-2 font-mono text-xs text-foreground focus:outline-none focus:ring-1",
                    jumpError
                      ? "border-destructive focus:ring-destructive"
                      : "border-border focus:ring-primary",
                  )}
                  autoFocus
                />
                <Button type="submit" size="sm" className="h-7 px-2.5 text-xs">
                  Go
                </Button>
              </div>
              {jumpError ? (
                <p className="text-[10px] text-destructive font-medium">
                  Invalid format. Use MM:SS (e.g. 01:23), seconds (45), or relative offset (+5,
                  -10).
                </p>
              ) : null}
              <div className="flex items-center justify-between pt-1 border-t border-border/40 text-[10px]">
                <button
                  type="button"
                  onClick={() => {
                    onSeek(0)
                    setJumpTimePopoverOpen(false)
                  }}
                  className="text-primary hover:underline"
                >
                  Start
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onSeek(Math.max(0, playheadMs - 5000))
                    setJumpTimePopoverOpen(false)
                  }}
                  className="text-primary hover:underline"
                >
                  -5s
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onSeek(Math.min(durationMs, playheadMs + 5000))
                    setJumpTimePopoverOpen(false)
                  }}
                  className="text-primary hover:underline"
                >
                  +5s
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onSeek(durationMs)
                    setJumpTimePopoverOpen(false)
                  }}
                  className="text-primary hover:underline"
                >
                  End
                </button>
              </div>

              {/* Marker Quick Jump Section */}
              {markers.length > 0 ? (
                <div className="pt-2 border-t border-border/40 space-y-1.5">
                  <div className="flex items-center justify-between text-[10px] text-subtle-foreground uppercase tracking-wider font-semibold">
                    <span>Jump to Marker</span>
                    <span>{markers.length}</span>
                  </div>
                  <div className="max-h-28 overflow-y-auto space-y-1 pr-0.5">
                    {markers.map((marker) => (
                      <button
                        key={marker.id}
                        type="button"
                        onClick={() => {
                          onSeek(marker.timeMs)
                          setJumpTimePopoverOpen(false)
                        }}
                        className="flex w-full items-center justify-between rounded px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-overlay hover:text-foreground transition-colors cursor-pointer text-left"
                      >
                        <span className="flex items-center gap-1.5 truncate">
                          <span
                            className="size-2 shrink-0 rounded-full"
                            style={{ backgroundColor: marker.color }}
                          />
                          <span className="truncate">{marker.label}</span>
                        </span>
                        <span className="font-mono text-[10px] text-subtle-foreground shrink-0">
                          {formatTimelineTime(marker.timeMs)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </form>
          </PopoverContent>
        </Popover>
      </div>

      {/* Cluster 3: View Controls, Speed, Minimap & Help */}
      <div className="flex items-center gap-1.5">
        {/* Playback Rate Dropdown */}
        <SimpleSelect
          aria-label="Playback speed"
          size="sm"
          value={String(playbackRate)}
          onValueChange={(val) => onSetPlaybackRate(Number(val))}
          className="h-7 w-18 text-[11px] font-mono font-medium"
          options={[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4].map((rate) => ({
            value: String(rate),
            label: `${rate}×`,
          }))}
        />

        <div className="hidden h-4 w-px bg-border/60 sm:block" />

        {/* Zoom Slider and Fit Button */}
        <div className="hidden items-center gap-1 sm:flex">
          <IconButton
            label="Zoom out"
            shortcut="Ctrl -"
            tooltipSide="top"
            className="size-7 text-muted-foreground hover:text-foreground"
            onClick={() => adjustZoom(-10)}
            disabled={zoom <= 0}
          >
            <ZoomOut className="size-3.5" />
          </IconButton>

          <Slider
            size="sm"
            value={[zoom]}
            min={0}
            max={100}
            step={1}
            aria-label="Timeline zoom scale"
            className="w-18 lg:w-22"
            onValueChange={(value) => onSetZoom(value[0] ?? zoom)}
          />

          <IconButton
            label="Zoom in"
            shortcut="Ctrl +"
            tooltipSide="top"
            className="size-7 text-muted-foreground hover:text-foreground"
            onClick={() => adjustZoom(10)}
            disabled={zoom >= 100}
          >
            <ZoomIn className="size-3.5" />
          </IconButton>

          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
            onClick={onZoomToFit}
            title="Zoom to fit timeline (Shift+Z)"
          >
            <Maximize2 className="size-3 mr-1" />
            Fit
          </Button>
        </div>

        <div className="hidden h-4 w-px bg-border/60 sm:block" />

        {/* Minimap Overview Toggle Button */}
        {onToggleMinimap ? (
          <IconButton
            label={showMinimap ? "Hide overview minimap" : "Show overview minimap"}
            tooltipSide="top"
            className={cn(
              "size-7 transition-colors duration-fast",
              showMinimap
                ? "bg-primary/20 text-primary border border-primary/30"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={onToggleMinimap}
            aria-pressed={showMinimap}
          >
            <Compass className="size-3.5" />
          </IconButton>
        ) : null}

        {/* Keyboard Shortcuts Dialog Trigger */}
        <IconButton
          label="Timeline keyboard shortcuts"
          shortcut="?"
          tooltipSide="top"
          className="size-7 text-muted-foreground hover:text-foreground"
          onClick={() => setShortcutsOpen(true)}
        >
          <Keyboard className="size-3.5" />
        </IconButton>
      </div>
    </div>
  )
}
