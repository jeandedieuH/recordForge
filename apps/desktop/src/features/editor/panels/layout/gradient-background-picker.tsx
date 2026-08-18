import { useMemo, useState } from "react"
import { Check, SlidersHorizontal, Compass } from "lucide-react"
import {
  GRADIENT_PRESETS,
  buildLinearGradient,
  parseGradientColors,
  type GradientCategory,
} from "@recordforge/editor-core"
import { ColorPicker, Slider, cn } from "@recordforge/ui"

interface GradientBackgroundPickerProps {
  value: string
  onChange: (gradient: string) => void
}

const CATEGORIES: { value: GradientCategory | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "vibrant", label: "Vibrant" },
  { value: "dark", label: "Dark" },
  { value: "mesh", label: "Mesh & Glow" },
  { value: "pastel", label: "Pastel" },
]

const QUICK_ANGLES = [45, 90, 135, 180, 225, 270]

export function GradientBackgroundPicker({ value, onChange }: GradientBackgroundPickerProps) {
  const [activeCategory, setActiveCategory] = useState<GradientCategory | "all">("all")
  const [showCustomBuilder, setShowCustomBuilder] = useState(false)

  // Custom gradient state initialized from current value if gradient, else defaults
  const parsed = useMemo(() => parseGradientColors(value), [value])
  const [customColor1, setCustomColor1] = useState(parsed.colors[0] || "#6366f1")
  const [customColor2, setCustomColor2] = useState(parsed.colors[1] || "#a855f7")
  const [customAngle, setCustomAngle] = useState(parsed.angle || 135)
  const [includeMidColor, setIncludeMidColor] = useState(false)
  const [customColor3, setCustomColor3] = useState("#ec4899")

  const filteredPresets = useMemo(() => {
    if (activeCategory === "all") return GRADIENT_PRESETS
    return GRADIENT_PRESETS.filter((p) => p.category === activeCategory)
  }, [activeCategory])

  const isPresetSelected = (presetGradient: string) => {
    return value.trim() === presetGradient.trim()
  }

  const applyCustomLinear = (c1: string, c2: string, angle: number, c3?: string) => {
    const grad = buildLinearGradient(c1, c2, angle, includeMidColor ? c3 : undefined)
    onChange(grad)
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Category Pills */}
      <div className="flex flex-wrap items-center gap-1">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.value}
            type="button"
            onClick={() => setActiveCategory(cat.value)}
            className={cn(
              "rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors",
              activeCategory === cat.value
                ? "border-primary/40 bg-primary/15 font-semibold text-primary"
                : "border-transparent bg-surface-dim text-subtle-foreground hover:bg-surface hover:text-foreground",
            )}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Preset Gradients Grid */}
      <div
        className="grid grid-cols-4 gap-2"
        role="listbox"
        aria-label="Gradient background presets"
      >
        {filteredPresets.map((preset) => {
          const selected = isPresetSelected(preset.gradient)

          return (
            <button
              key={preset.id}
              type="button"
              role="option"
              aria-selected={selected}
              title={preset.name}
              onClick={() => onChange(preset.gradient)}
              className={cn(
                "group relative flex flex-col items-center overflow-hidden rounded-lg border border-border/80 p-1 text-left transition-all",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                selected
                  ? "border-primary bg-primary/10 ring-2 ring-primary ring-offset-1 ring-offset-background shadow-xs"
                  : "hover:border-border-hover hover:scale-[1.02] bg-surface-dim/50",
              )}
            >
              <div
                className="relative aspect-video w-full rounded-md shadow-xs transition-transform group-hover:scale-105"
                style={{ background: preset.gradient }}
              >
                {selected && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/25">
                    <Check className="size-4 stroke-3 text-white drop-shadow-md" aria-hidden />
                  </div>
                )}
              </div>
              <span className="mt-1 w-full truncate text-center text-[10px] font-medium text-foreground">
                {preset.name}
              </span>
            </button>
          )
        })}
      </div>

      {/* Custom Gradient Generator Toggle */}
      <div className="rounded-lg border border-border bg-surface-dim p-2.5">
        <button
          type="button"
          onClick={() => setShowCustomBuilder(!showCustomBuilder)}
          className="flex w-full items-center justify-between text-xs font-medium text-foreground hover:text-primary transition-colors"
        >
          <span className="flex items-center gap-2">
            <SlidersHorizontal className="size-3.5 text-primary" aria-hidden />
            Custom Gradient Builder
          </span>
          <span className="text-[10px] text-subtle-foreground">
            {showCustomBuilder ? "Hide" : "Customize"}
          </span>
        </button>

        {showCustomBuilder && (
          <div className="mt-3 flex flex-col gap-3 border-t border-border pt-3">
            {/* Color Stops */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-subtle-foreground">Start:</span>
                <ColorPicker
                  aria-label="Gradient start color"
                  value={customColor1}
                  onChange={(c) => {
                    setCustomColor1(c)
                    applyCustomLinear(c, customColor2, customAngle, customColor3)
                  }}
                />
              </div>

              {includeMidColor && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-subtle-foreground">Mid:</span>
                  <ColorPicker
                    aria-label="Gradient middle color"
                    value={customColor3}
                    onChange={(c) => {
                      setCustomColor3(c)
                      applyCustomLinear(customColor1, customColor2, customAngle, c)
                    }}
                  />
                </div>
              )}

              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-subtle-foreground">End:</span>
                <ColorPicker
                  aria-label="Gradient end color"
                  value={customColor2}
                  onChange={(c) => {
                    setCustomColor2(c)
                    applyCustomLinear(customColor1, c, customAngle, customColor3)
                  }}
                />
              </div>
            </div>

            {/* Toggle 3rd color */}
            <label className="flex items-center justify-between text-[11px] text-subtle-foreground cursor-pointer">
              <span>3-Color Blend</span>
              <input
                type="checkbox"
                checked={includeMidColor}
                onChange={(e) => {
                  setIncludeMidColor(e.target.checked)
                  applyCustomLinear(
                    customColor1,
                    customColor2,
                    customAngle,
                    e.target.checked ? customColor3 : undefined,
                  )
                }}
                className="rounded border-border text-primary focus:ring-primary size-3.5"
              />
            </label>

            {/* Angle Control */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-[11px] text-subtle-foreground">
                <span className="flex items-center gap-1">
                  <Compass className="size-3 text-primary" aria-hidden />
                  Angle
                </span>
                <span className="font-mono text-[10px] text-foreground">{customAngle}°</span>
              </div>
              <Slider
                value={[customAngle]}
                min={0}
                max={360}
                step={5}
                onValueChange={([val]) => {
                  if (val !== undefined) {
                    setCustomAngle(val)
                    applyCustomLinear(customColor1, customColor2, val, customColor3)
                  }
                }}
              />

              {/* Quick Angle Chips */}
              <div className="flex items-center justify-between gap-1 pt-1">
                {QUICK_ANGLES.map((angle) => (
                  <button
                    key={angle}
                    type="button"
                    onClick={() => {
                      setCustomAngle(angle)
                      applyCustomLinear(customColor1, customColor2, angle, customColor3)
                    }}
                    className={cn(
                      "rounded border px-1.5 py-0.5 font-mono text-[9px] font-medium transition-colors",
                      customAngle === angle
                        ? "border-primary/60 bg-primary/15 font-semibold text-primary shadow-xs"
                        : "border-border/60 bg-surface text-subtle-foreground hover:border-border hover:bg-surface-hover hover:text-foreground",
                    )}
                  >
                    {angle}°
                  </button>
                ))}
              </div>
            </div>

            {/* Live Gradient Preview Bar */}
            <div
              className="h-6 w-full rounded-md border border-border shadow-inner"
              style={{
                background: buildLinearGradient(
                  customColor1,
                  customColor2,
                  customAngle,
                  includeMidColor ? customColor3 : undefined,
                ),
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
