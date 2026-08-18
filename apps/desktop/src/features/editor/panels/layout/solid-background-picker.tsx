import { useMemo, useState } from "react"
import { Check, Pipette } from "lucide-react"
import { SOLID_COLOR_PRESETS, type SolidColorCategory } from "@recordforge/editor-core"
import { ColorPicker, cn } from "@recordforge/ui"

interface SolidBackgroundPickerProps {
  value: string
  onChange: (color: string) => void
}

const CATEGORIES: { value: SolidColorCategory | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "studio", label: "Studio" },
  { value: "dark", label: "Dark" },
  { value: "vibrant", label: "Vibrant" },
  { value: "light", label: "Light" },
]

export function SolidBackgroundPicker({ value, onChange }: SolidBackgroundPickerProps) {
  const [activeCategory, setActiveCategory] = useState<SolidColorCategory | "all">("all")

  const filteredPresets = useMemo(() => {
    if (activeCategory === "all") return SOLID_COLOR_PRESETS
    return SOLID_COLOR_PRESETS.filter((p) => p.category === activeCategory)
  }, [activeCategory])

  const isPresetSelected = (presetColor: string) => {
    return value.toLowerCase() === presetColor.toLowerCase()
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
              "rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors",
              activeCategory === cat.value
                ? "bg-primary text-primary-foreground"
                : "bg-surface-dim text-subtle-foreground hover:bg-surface hover:text-foreground",
            )}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Preset Swatches Grid */}
      <div
        className="grid grid-cols-6 gap-1.5"
        role="listbox"
        aria-label="Solid background presets"
      >
        {filteredPresets.map((preset) => {
          const selected = isPresetSelected(preset.color)
          const isLight =
            preset.color === "#ffffff" || preset.color === "#f8fafc" || preset.color === "#f1f5f9"

          return (
            <button
              key={preset.id}
              type="button"
              role="option"
              aria-selected={selected}
              title={`${preset.name} (${preset.color})`}
              onClick={() => onChange(preset.color)}
              className={cn(
                "group relative aspect-square w-full rounded-md border border-border/80 p-0.5 transition-all",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                selected
                  ? "ring-2 ring-primary ring-offset-1 ring-offset-background scale-105"
                  : "hover:scale-105 hover:border-border-hover",
              )}
            >
              <span
                className="flex size-full items-center justify-center rounded-[4px] shadow-xs"
                style={{ backgroundColor: preset.color }}
              >
                {selected && (
                  <Check
                    className={cn("size-3.5 stroke-[3]", isLight ? "text-slate-900" : "text-white")}
                    aria-hidden
                  />
                )}
              </span>
            </button>
          )
        })}
      </div>

      {/* Custom Color Picker & Hex Input */}
      <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface-dim p-2">
        <div className="flex items-center gap-2">
          <Pipette className="size-3.5 text-primary" aria-hidden />
          <span className="text-xs font-medium text-foreground">Custom Color</span>
        </div>
        <div className="flex items-center gap-2">
          <ColorPicker
            aria-label="Custom background color"
            value={value.startsWith("#") ? value : "#070b14"}
            onChange={onChange}
          />
        </div>
      </div>
    </div>
  )
}
