import { useState } from "react"
import {
  Flag,
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
  NativeSelect,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Slider,
  Switch,
  cn,
} from "@recordforge/ui"
import { formatTime } from "@recordforge/editor-core"
import type { MaskClip } from "@recordforge/contracts"

export type TimelineTool = "select" | "split" | "range"

interface TimelineToolbarProps {
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
  onTogglePlay: () => void
  onSeek: (timeMs: number) => void
  onStepFrame: (direction: -1 | 1) => void
  onSetPlaybackRate: (rate: number) => void
  onSetZoom: (zoom: number) => void
  onZoomToFit: () => void
  onAddMarker: () => void
  onAddMask: (mode: MaskClip["mode"]) => void
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
  onTogglePlay,
  onSeek,
  onStepFrame,
  onSetPlaybackRate,
  onSetZoom,
  onZoomToFit,
  onAddMarker,
  onAddMask,
  onSplitAtPlayhead,
  onRippleDeleteSelected,
}: TimelineToolbarProps) {
  const [snapPopoverOpen, setSnapPopoverOpen] = useState(false)

  function adjustZoom(delta: number) {
    onSetZoom(Math.max(0, Math.min(100, Math.round(zoom + delta))))
  }

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-dim/80 px-3 py-1.5 backdrop-blur-md"
      role="toolbar"
      aria-label="Timeline editing and transport controls"
    >
      {/* Left Section: Tool Selection & Quick Actions */}
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
                ? "bg-primary text-white shadow-xs"
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
            shortcut="S"
            tooltipSide="top"
            className={cn(
              "size-7 rounded-md transition-all duration-fast",
              tool === "split"
                ? "bg-primary text-white shadow-xs"
                : "text-muted-foreground hover:bg-overlay hover:text-foreground",
            )}
            onClick={() => onSelectTool("split")}
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
                ? "bg-primary text-white shadow-xs"
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

        {/* Snapping Popover */}
        <Popover open={snapPopoverOpen} onOpenChange={setSnapPopoverOpen}>
          <PopoverTrigger asChild>
            <Button
              variant={snapEnabled ? "secondary" : "ghost"}
              size="sm"
              className={cn(
                "h-7 gap-1.5 px-2 text-xs font-medium transition-all duration-fast",
                snapEnabled &&
                  "border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20",
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
          <PopoverContent className="w-56 p-3" align="start">
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
                while dragging to bypass snap temporarily.
              </p>
            </div>
          </PopoverContent>
        </Popover>

        {/* Quick Edit Actions */}
        <IconButton
          label="Split at playhead"
          shortcut="S"
          tooltipSide="top"
          className="size-7 text-muted-foreground hover:text-foreground"
          onClick={onSplitAtPlayhead}
        >
          <Scissors className="size-3.5" />
        </IconButton>

        <IconButton
          label="Add marker"
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
          <DropdownMenuContent align="start" className="w-40">
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

        {canRippleDelete ? (
          <IconButton
            label="Ripple delete selected"
            shortcut="Shift+Del"
            tooltipSide="top"
            className="size-7 text-destructive hover:bg-destructive/10"
            onClick={onRippleDeleteSelected}
          >
            <Trash2 className="size-3.5" />
          </IconButton>
        ) : null}
      </div>

      {/* Center Section: Transport Controls & Timecode */}
      <div className="flex items-center gap-2">
        <IconButton
          label="Go to start"
          shortcut="Home"
          tooltipSide="top"
          className="size-7 text-muted-foreground hover:text-foreground"
          onClick={() => onSeek(0)}
        >
          <SkipBack className="size-3.5" />
        </IconButton>

        <IconButton
          label="Step backward 1 frame"
          shortcut="Left Arrow"
          tooltipSide="top"
          className="size-7 text-muted-foreground hover:text-foreground"
          onClick={() => onStepFrame(-1)}
        >
          <StepBack className="size-3.5" />
        </IconButton>

        <Button
          size="icon"
          className={cn(
            "size-8 rounded-full shadow-e2 transition-transform active:scale-95",
            isPlaying
              ? "bg-primary text-white hover:bg-primary-hover"
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

        <IconButton
          label="Step forward 1 frame"
          shortcut="Right Arrow"
          tooltipSide="top"
          className="size-7 text-muted-foreground hover:text-foreground"
          onClick={() => onStepFrame(1)}
        >
          <StepForward className="size-3.5" />
        </IconButton>

        <IconButton
          label="Go to end"
          shortcut="End"
          tooltipSide="top"
          className="size-7 text-muted-foreground hover:text-foreground"
          onClick={() => onSeek(durationMs)}
        >
          <SkipForward className="size-3.5" />
        </IconButton>

        {/* Formatted Precision Timecode Badge */}
        <div
          className="flex items-center gap-1 rounded-md border border-border/80 bg-surface/90 px-2 py-0.5 font-mono text-xs shadow-xs"
          title="Current playhead position / Total duration"
        >
          <span className="font-semibold tabular-nums text-foreground">
            {formatTime(playheadMs)}
          </span>
          <span className="text-subtle-foreground">/</span>
          <span className="tabular-nums text-muted-foreground">{formatTime(durationMs)}</span>
        </div>
      </div>

      {/* Right Section: Playback Speed & Zoom Controls */}
      <div className="flex items-center gap-2">
        {/* Playback Rate Dropdown */}
        <NativeSelect
          aria-label="Playback speed"
          value={String(playbackRate)}
          onChange={(event) => onSetPlaybackRate(Number(event.target.value))}
          className="h-7 w-18 pl-2 pr-6 text-[11px] font-mono font-medium"
        >
          {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4].map((rate) => (
            <option key={rate} value={rate}>
              {rate}×
            </option>
          ))}
        </NativeSelect>

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
            value={[zoom]}
            min={0}
            max={100}
            step={1}
            aria-label="Timeline zoom scale"
            className="w-20 lg:w-24"
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

          <span className="w-10 text-right font-mono text-[10px] tabular-nums text-subtle-foreground">
            {Math.round(zoom)}%
          </span>
        </div>
      </div>
    </div>
  )
}
