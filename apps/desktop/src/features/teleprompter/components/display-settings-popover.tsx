import { SlidersHorizontal } from "lucide-react"
import {
  IconButton,
  Kbd,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Slider,
  Switch,
} from "@recordforge/ui"
import { OPACITY_LIMIT } from "../lib/teleprompter-settings"
import { useTeleprompterStore } from "../teleprompter-store"

interface DisplaySettingsPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DisplaySettingsPopover({ open, onOpenChange }: DisplaySettingsPopoverProps) {
  const mirror = useTeleprompterStore((state) => state.settings.mirror)
  const opacity = useTeleprompterStore((state) => state.settings.opacity)
  const updateSettings = useTeleprompterStore((state) => state.updateSettings)

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <IconButton label="Display settings" tooltipSide="top" className="size-8 shrink-0">
          <SlidersHorizontal className="size-4" aria-hidden />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-64">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="teleprompter-mirror" className="text-xs font-medium">
              Mirror text
            </Label>
            <Switch
              id="teleprompter-mirror"
              checked={mirror}
              onCheckedChange={(checked) => updateSettings({ mirror: checked })}
            />
          </div>

          <div role="group" aria-label="Window opacity" className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-foreground">Window opacity</span>
              <span className="text-xs tabular-nums text-muted-foreground">{opacity}%</span>
            </div>
            <Slider
              size="sm"
              variant="accent"
              min={OPACITY_LIMIT.min}
              max={OPACITY_LIMIT.max}
              step={OPACITY_LIMIT.step}
              value={[opacity]}
              onValueChange={([next]) => {
                if (next !== undefined) updateSettings({ opacity: next })
              }}
              thumbLabel="Window opacity"
            />
          </div>

          <div
            data-testid="teleprompter-shortcuts-legend"
            className="border-t border-border/60 pt-2.5"
          >
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-subtle-foreground">
              Shortcuts
            </p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Kbd>Space</Kbd> Play/pause
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>↑↓</Kbd> Speed
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>+−</Kbd> Text size
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>R</Kbd> Restart
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>M</Kbd> Mirror
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>E</Kbd> Edit
              </span>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
