import { Button, IconButton, Label, Switch } from "@recordforge/ui"
import {
  ArrowDown,
  ArrowDownLeft,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  Crosshair,
  RotateCcw,
} from "lucide-react"
import { InspectorSection, NumberField } from "../fields"
import { fitTitleLayout, type TitleCanvas, type TitlePlacement } from "./title-layout"
import type { TitleSectionProps } from "./title-inspector-fields"

export interface TitleLayoutProps extends TitleSectionProps {
  canvas: TitleCanvas
  onReset: () => void
  canReset: boolean
}
const placements = [
  ["Top left", ArrowUpLeft],
  ["Top center", ArrowUp],
  ["Top right", ArrowUpRight],
  ["Middle left", ArrowLeft],
  ["Center", Crosshair],
  ["Middle right", ArrowRight],
  ["Bottom left", ArrowDownLeft],
  ["Bottom center", ArrowDown],
  ["Bottom right", ArrowDownRight],
] as const

export function TitleLayoutSection({
  clip,
  onChange,
  canvas,
  onReset,
  canReset,
}: TitleLayoutProps) {
  return (
    <InspectorSection title="Layout">
      {/* Quick Placement */}
      <div className="flex items-center gap-3">
        <div
          role="group"
          aria-label="Place title on canvas"
          className="grid shrink-0 grid-cols-3 gap-1 rounded-lg border border-border bg-surface-dim p-1"
        >
          {placements.map(([label, Icon], index) => (
            <IconButton
              key={label}
              label={`Place ${label.toLowerCase()}`}
              className="size-8"
              disabled={clip.locked}
              onClick={() =>
                onChange(
                  fitTitleLayout(clip, canvas, {}, {
                    column: index % 3,
                    row: Math.floor(index / 3),
                  } as TitlePlacement),
                )
              }
            >
              <Icon className="size-4" aria-hidden />
            </IconButton>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {clip.locked
            ? "Unlock the title to change placement."
            : "Place within a 5% safe margin. Oversized boxes fit inside the canvas."}
        </p>
      </div>
      <fieldset disabled={clip.locked} className="grid grid-cols-2 gap-2 disabled:opacity-50">
        <NumberField
          label="Box width"
          value={Math.round(clip.width)}
          min={20}
          max={canvas.width}
          unit="px"
          onChange={(width) => onChange(fitTitleLayout(clip, canvas, { width }))}
        />
        <NumberField
          label="Box height"
          value={Math.round(clip.height)}
          min={20}
          max={canvas.height}
          unit="px"
          onChange={(height) => onChange(fitTitleLayout(clip, canvas, { height }))}
        />
      </fieldset>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={`title-${clip.id}-fit`} className="text-xs">
          Fit text to box
        </Label>
        <Switch
          id={`title-${clip.id}-fit`}
          aria-label="Fit text to box"
          checked={clip.autoScaleText}
          onCheckedChange={(autoScaleText) => onChange({ autoScaleText })}
        />
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="gap-2"
        disabled={clip.locked || !canReset}
        onClick={onReset}
      >
        <RotateCcw className="size-3" aria-hidden />
        Reset to preset dimensions
      </Button>
    </InspectorSection>
  )
}
