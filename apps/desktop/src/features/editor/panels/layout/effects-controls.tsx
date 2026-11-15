import { Sparkles, Wind } from "lucide-react"
import type { MotionBlurSettings, TimelineCanvas, ZoomSharpening } from "@recordforge/contracts"
import { SimpleSelect, SliderField, Switch } from "@recordforge/ui"

interface EffectsControlsProps {
  canvas: TimelineCanvas
  onChange: (updates: Partial<TimelineCanvas>) => void
}

const SHARPENING_OPTIONS: Array<{ value: ZoomSharpening; label: string }> = [
  { value: "off", label: "Off" },
  { value: "auto", label: "Auto" },
  { value: "strong", label: "Strong" },
]

/** Shutter defaults when motion blur is switched on (a 180° shutter reads best). */
const DEFAULT_BLUR: MotionBlurSettings = { enabled: true, cursor: 0.5, zoom: 0.5, pan: 0.5 }

/**
 * Zoom clarity (#3, Free) and motion blur (#1, Pro) canvas controls.
 *
 * Sharpening is a zoom-only quality pass and defaults to `auto`; motion blur is
 * a shutter fraction per motion source where 100% is a 180° shutter.
 */
export function EffectsControls({ canvas, onChange }: EffectsControlsProps) {
  const sharpening = canvas.zoomSharpening ?? "auto"
  const blur = canvas.motionBlur
  const blurEnabled = blur?.enabled ?? false

  const setBlur = (updates: Partial<MotionBlurSettings>) => {
    onChange({ motionBlur: { ...DEFAULT_BLUR, ...blur, enabled: true, ...updates } })
  }

  return (
    <div className="flex flex-col gap-3">
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

      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-dim/50 p-3">
        <div className="flex items-center justify-between gap-2">
          <label
            htmlFor="canvas-motion-blur-toggle"
            className="flex cursor-pointer items-center gap-2 text-xs font-medium text-foreground"
          >
            <Wind className="size-4 text-primary" aria-hidden />
            <span>Motion blur</span>
            <span className="rounded-sm bg-primary/15 px-1 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-primary">
              Pro
            </span>
          </label>
          <Switch
            id="canvas-motion-blur-toggle"
            checked={blurEnabled}
            onCheckedChange={(enabled) =>
              // `enabled` must be applied last: spreading the current settings
              // after the defaults would keep the old value and the toggle
              // would never switch on.
              onChange({ motionBlur: { ...DEFAULT_BLUR, ...blur, enabled } })
            }
          />
        </div>

        {blurEnabled ? (
          <div className="flex flex-col gap-3 pt-1">
            {(
              [
                ["cursor", "Cursor"],
                ["zoom", "Zoom"],
                ["pan", "Pan"],
              ] as const
            ).map(([key, label]) => (
              <SliderField
                key={key}
                label={label}
                size="sm"
                value={Math.round((blur?.[key] ?? DEFAULT_BLUR[key]) * 100)}
                min={0}
                max={100}
                step={5}
                unit="%"
                onChange={(value) =>
                  setBlur(
                    key === "cursor"
                      ? { cursor: value / 100 }
                      : key === "zoom"
                        ? { zoom: value / 100 }
                        : { pan: value / 100 },
                  )
                }
              />
            ))}
            <p className="-mt-1 text-[10px] leading-relaxed text-subtle-foreground">
              100% blurs across a whole frame (a 180° shutter). Cursor blur is exact on every
              renderer; zoom and pan blur need the GPU compositor and are reported otherwise.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  )
}
