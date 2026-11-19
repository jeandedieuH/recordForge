import { Sparkles } from "lucide-react"
import type { TimelineCanvas, ZoomSharpening } from "@recordforge/contracts"
import { SimpleSelect } from "@recordforge/ui"
import { MotionBlurControls } from "./motion-blur-controls"

interface EffectsControlsProps {
  canvas: TimelineCanvas
  onChange: (updates: Partial<TimelineCanvas>) => void
}

const SHARPENING_OPTIONS: Array<{ value: ZoomSharpening; label: string }> = [
  { value: "off", label: "Off" },
  { value: "auto", label: "Auto" },
  { value: "strong", label: "Strong" },
]

/**
 * Zoom clarity (#3, Free) and motion blur (#1, Pro) canvas controls.
 *
 * Sharpening is a zoom-only quality pass and defaults to `auto`; motion blur
 * applies a physical shutter curve across cursor, zoom, and pan motion in both
 * editor preview and export.
 */
export function EffectsControls({ canvas, onChange }: EffectsControlsProps) {
  const sharpening = canvas.zoomSharpening ?? "auto"

  return (
    <div className="flex flex-col gap-3">
      <MotionBlurControls canvas={canvas} onChange={onChange} />

      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-dim/50 p-3">
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-xs font-medium text-foreground">
            <Sparkles className="size-4 text-primary" aria-hidden />
            <span>Zoom clarity</span>
          </label>
          <SimpleSelect
            aria-label="Zoom sharpening"
            size="sm"
            value={sharpening}
            onValueChange={(value) => onChange({ zoomSharpening: value as ZoomSharpening })}
            className="w-28"
            options={SHARPENING_OPTIONS}
          />
        </div>
        <p className="-mt-1 text-[10px] leading-relaxed text-subtle-foreground">
          Re-samples zooms from the source resolution and sharpens what still has to be upscaled.
          Auto picks the strength from the remaining upscale.
        </p>
      </div>
    </div>
  )
}
