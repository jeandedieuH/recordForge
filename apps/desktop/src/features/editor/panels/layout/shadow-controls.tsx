import { useState } from "react"
import { SunMedium } from "lucide-react"
import type { TimelineCanvas } from "@recordforge/contracts"
import { ColorPicker, SliderField, Switch, cn } from "@recordforge/ui"

interface ShadowControlsProps {
  canvas: TimelineCanvas
  onChange: (updates: Partial<TimelineCanvas>) => void
}

interface ShadowPreset {
  id: string
  label: string
  blur: number
  offsetY: number
  offsetX: number
  color: string
}

const SHADOW_PRESETS: ShadowPreset[] = [
  { id: "subtle", label: "Subtle", blur: 12, offsetY: 4, offsetX: 0, color: "#000000" },
  { id: "medium", label: "Medium", blur: 24, offsetY: 8, offsetX: 0, color: "#000000" },
  { id: "elevated", label: "Floating", blur: 40, offsetY: 16, offsetX: 0, color: "#000000" },
  { id: "glow", label: "Glow", blur: 32, offsetY: 0, offsetX: 0, color: "#6366f1" },
]

export function ShadowControls({ canvas, onChange }: ShadowControlsProps) {
  const [showAdvanced, setShowAdvanced] = useState(false)

  const isEnabled = canvas.shadow
  const currentBlur = canvas.shadowBlur ?? 24
  const currentOffsetX = canvas.shadowOffsetX ?? 0
  const currentOffsetY = canvas.shadowOffsetY ?? 8
  const currentColor = canvas.shadowColor ?? "#000000"

  const applyPreset = (preset: ShadowPreset) => {
    onChange({
      shadow: true,
      shadowBlur: preset.blur,
      shadowOffsetX: preset.offsetX,
      shadowOffsetY: preset.offsetY,
      shadowColor: preset.color,
    })
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-dim/50 p-3">
      {/* Switch Header */}
      <div className="flex items-center justify-between">
        <label
          htmlFor="canvas-shadow-toggle"
          className="flex items-center gap-2 text-xs font-medium text-foreground cursor-pointer"
        >
          <SunMedium className="size-4 text-primary" aria-hidden />
          <span>Canvas Drop Shadow</span>
        </label>
        <Switch
          id="canvas-shadow-toggle"
          checked={isEnabled}
          onCheckedChange={(checked) => onChange({ shadow: checked })}
        />
      </div>

      {isEnabled && (
        <div className="flex flex-col gap-3 pt-1">
          {/* Quick Presets */}
          <div className="flex items-center justify-between gap-1">
            {SHADOW_PRESETS.map((preset) => {
              const isMatch =
                currentBlur === preset.blur &&
                currentOffsetY === preset.offsetY &&
                currentColor.toLowerCase() === preset.color.toLowerCase()

              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  className={cn(
                    "flex-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
                    isMatch
                      ? "border-primary/60 bg-primary/15 font-semibold text-primary shadow-xs"
                      : "border-border/60 bg-surface text-subtle-foreground hover:border-border hover:bg-surface-hover hover:text-foreground",
                  )}
                >
                  {preset.label}
                </button>
              )
            })}
          </div>

          {/* Toggle Advanced */}
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="text-left text-[11px] text-subtle-foreground hover:text-primary transition-colors"
          >
            {showAdvanced ? "Hide fine adjustments" : "Fine-tune shadow blur & offset..."}
          </button>

          {showAdvanced && (
            <div className="flex flex-col gap-2.5 border-t border-border pt-2">
              {/* Blur Slider */}
              <SliderField
                label="Blur"
                size="sm"
                value={currentBlur}
                min={0}
                max={64}
                step={2}
                unit="px"
                onChange={(val) => onChange({ shadowBlur: val })}
              />

              {/* X Offset Slider */}
              <SliderField
                label="X Offset"
                size="sm"
                value={currentOffsetX}
                min={-32}
                max={48}
                step={2}
                unit="px"
                onChange={(val) => onChange({ shadowOffsetX: val })}
              />

              {/* Y Offset Slider */}
              <SliderField
                label="Y Offset"
                size="sm"
                value={currentOffsetY}
                min={-32}
                max={48}
                step={2}
                unit="px"
                onChange={(val) => onChange({ shadowOffsetY: val })}
              />

              {/* Shadow Color */}
              <div className="flex items-center justify-between pt-1">
                <span className="text-[11px] text-subtle-foreground">Shadow Color</span>
                <ColorPicker
                  aria-label="Shadow color"
                  value={currentColor}
                  onChange={(c) => onChange({ shadowColor: c })}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
