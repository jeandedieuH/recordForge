import { Gauge, Pause, Play, RotateCcw, Type } from "lucide-react"
import { cn, IconButton } from "@recordforge/ui"
import { FONT_SIZE_LIMIT, WPM_LIMIT } from "../lib/teleprompter-settings"
import { useTeleprompterStore } from "../teleprompter-store"
import { DisplaySettingsPopover } from "./display-settings-popover"
import { SliderControl } from "./slider-control"

interface ControlDockProps {
  visible: boolean
  /** 0..1 — drawn as the thin accent bar on the dock's top edge. */
  progress: number
  atEnd: boolean
  onTogglePlay: () => void
  settingsOpen: boolean
  onSettingsOpenChange: (open: boolean) => void
}

/** Prompt-mode transport: restart, play/pause, speed + size, display settings. */
export function ControlDock({
  visible,
  progress,
  atEnd,
  onTogglePlay,
  settingsOpen,
  onSettingsOpenChange,
}: ControlDockProps) {
  const playing = useTeleprompterStore((state) => state.playing)
  const wpm = useTeleprompterStore((state) => state.settings.wpm)
  const fontSize = useTeleprompterStore((state) => state.settings.fontSize)
  const updateSettings = useTeleprompterStore((state) => state.updateSettings)
  const restart = useTeleprompterStore((state) => state.restart)

  const playLabel = playing ? "Pause" : atEnd ? "Replay" : "Play"

  return (
    <footer
      data-testid="control-dock"
      data-teleprompter-chrome
      className={cn(
        "relative shrink-0 border-t border-border/60 transition-opacity duration-base ease-forge",
        !visible && "pointer-events-none opacity-0",
      )}
    >
      <div
        role="progressbar"
        aria-label="Script progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        className="absolute inset-x-0 top-0 h-0.5 bg-border/60"
      >
        <div
          className="h-full bg-accent transition-[width] duration-base ease-linear"
          style={{ width: `${progress * 100}%` }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-2 pt-2.5">
        <div className="flex items-center gap-1.5">
          <IconButton label="Restart" shortcut="R" tooltipSide="top" onClick={restart}>
            <RotateCcw className="size-4" aria-hidden />
          </IconButton>
          <IconButton
            label={playLabel}
            shortcut="Space"
            tooltipSide="top"
            onClick={onTogglePlay}
            className="size-11 rounded-full bg-foreground text-background shadow-e1 hover:bg-foreground/85 hover:text-background"
          >
            {playing ? (
              <Pause className="size-5" aria-hidden />
            ) : (
              // Optical centering: the play triangle reads better nudged right.
              <Play className="ml-0.5 size-5" aria-hidden />
            )}
          </IconButton>
        </div>

        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-center gap-x-4 gap-y-1">
          <SliderControl
            icon={Gauge}
            label="Reading speed (words per minute)"
            value={wpm}
            min={WPM_LIMIT.min}
            max={WPM_LIMIT.max}
            step={WPM_LIMIT.step}
            onChange={(value) => updateSettings({ wpm: value })}
            readout={`${wpm} wpm`}
            readoutClassName="w-14"
          />
          <SliderControl
            icon={Type}
            label="Text size"
            value={fontSize}
            min={FONT_SIZE_LIMIT.min}
            max={FONT_SIZE_LIMIT.max}
            step={FONT_SIZE_LIMIT.step}
            onChange={(value) => updateSettings({ fontSize: value })}
            readout={`${fontSize}px`}
            readoutClassName="w-10"
          />
        </div>

        <DisplaySettingsPopover open={settingsOpen} onOpenChange={onSettingsOpenChange} />
      </div>
    </footer>
  )
}
