import { useState } from "react"
import { Frame } from "lucide-react"
import type { BorderStyle, TimelineCanvas } from "@recordforge/contracts"
import { ColorPicker, SliderField, Switch, cn } from "@recordforge/ui"

interface BorderControlsProps {
  canvas: TimelineCanvas
  onChange: (updates: Partial<TimelineCanvas>) => void
}

const BORDER_STYLES: Array<{ value: BorderStyle; label: string }> = [
  { value: "solid", label: "Solid" },
  { value: "gradient", label: "Gradient" },
  { value: "double", label: "Double" },
  { value: "glass", label: "Glass" },
]

/**
 * Canvas frame border (#11). Free feature: a rim drawn inside the screen rect,
 * so it frames the recording without covering it.
 */
export function BorderControls({ canvas, onChange }: BorderControlsProps) {
  const [showAdvanced, setShowAdvanced] = useState(false)
  const width = canvas.borderWidth ?? 0
  const isEnabled = width > 0
  const style = canvas.borderStyle ?? "solid"
  const color = canvas.borderColor ?? "#ffffff"
  const gradient = canvas.borderGradient ?? { from: color, to: "#6366f1", angle: 135 }

  const setStyle = (next: BorderStyle) => {
    // Switching to gradient seeds the ramp from the current solid colour so the
    // frame never jumps to an unrelated pair.
    onChange({
      borderStyle: next,
      ...(next === "gradient" && !canvas.borderGradient
        ? { borderGradient: { from: color, to: "#6366f1", angle: 135 } }
        : {}),
    })
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-dim/50 p-3">
      <div className="flex items-center justify-between">
        <label
          htmlFor="canvas-border-toggle"
          className="flex items-center gap-2 text-xs font-medium text-foreground cursor-pointer"
        >
          <Frame className="size-4 text-primary" aria-hidden />
          <span>Frame Border</span>
        </label>
        <Switch
          id="canvas-border-toggle"
          checked={isEnabled}
          onCheckedChange={(checked) => onChange({ borderWidth: checked ? 8 : 0 })}
        />
      </div>

      {isEnabled ? (
        <div className="flex flex-col gap-3 pt-1">
          <SliderField
            label="Thickness"
            size="sm"
            value={width}
            min={1}
            max={64}
            step={1}
            unit="px"
            onChange={(value) => onChange({ borderWidth: value })}
          />

          <div className="flex items-center justify-between gap-1">
            {BORDER_STYLES.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setStyle(option.value)}
                className={cn(
                  "flex-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
                  style === option.value
                    ? "border-primary/60 bg-primary/15 font-semibold text-primary shadow-xs"
                    : "border-border/60 bg-surface text-subtle-foreground hover:border-border hover:bg-surface-hover hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>

          {style === "gradient" ? (
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-subtle-foreground">Gradient start</span>
                <ColorPicker
                  aria-label="Border gradient start colour"
                  value={gradient.from}
                  onChange={(from) => onChange({ borderGradient: { ...gradient, from } })}
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-subtle-foreground">Gradient end</span>
                <ColorPicker
                  aria-label="Border gradient end colour"
                  value={gradient.to}
                  onChange={(to) => onChange({ borderGradient: { ...gradient, to } })}
                />
              </div>
              <SliderField
                label="Angle"
                size="sm"
                value={gradient.angle}
                min={0}
                max={360}
                step={15}
                unit="°"
                onChange={(angle) => onChange({ borderGradient: { ...gradient, angle } })}
              />
            </div>
          ) : (
            <div className="flex items-center justify-between pt-1">
              <span className="text-[11px] text-subtle-foreground">Border color</span>
              <ColorPicker
                aria-label="Border colour"
                value={color}
                onChange={(next) => onChange({ borderColor: next })}
              />
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowAdvanced((current) => !current)}
            className="text-left text-[11px] text-subtle-foreground hover:text-primary transition-colors"
          >
            {showAdvanced ? "Hide opacity" : "Adjust opacity..."}
          </button>

          {showAdvanced ? (
            <SliderField
              label="Opacity"
              size="sm"
              value={Math.round((canvas.borderOpacity ?? 1) * 100)}
              min={0}
              max={100}
              step={5}
              unit="%"
              onChange={(value) => onChange({ borderOpacity: value / 100 })}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
