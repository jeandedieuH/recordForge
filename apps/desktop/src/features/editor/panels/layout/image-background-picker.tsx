import { useMemo, useRef, useState } from "react"
import { Check, Upload, Trash2, Sliders, RotateCcw } from "lucide-react"
import {
  BACKGROUND_BLUR_PRESETS,
  BACKGROUND_DIM_PRESETS,
  IMAGE_BACKGROUND_PRESETS,
  type ImageBackgroundCategory,
} from "@recordforge/editor-core"
import { Button, Slider, cn } from "@recordforge/ui"

interface ImageBackgroundPickerProps {
  value: string
  onChange: (imageSrc: string) => void
  backgroundBlur?: number
  onBlurChange?: (blur: number) => void
  backgroundDim?: number
  onDimChange?: (dim: number) => void
}

const CATEGORIES: { value: ImageBackgroundCategory | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "abstract", label: "Abstract" },
  { value: "gradient-mesh", label: "Mesh" },
  { value: "dark", label: "Dark" },
  { value: "nature", label: "Nature" },
  { value: "studio", label: "Studio" },
  { value: "minimal", label: "Minimal" },
]

export function ImageBackgroundPicker({
  value,
  onChange,
  backgroundBlur = 0,
  onBlurChange,
  backgroundDim = 0,
  onDimChange,
}: ImageBackgroundPickerProps) {
  const [activeCategory, setActiveCategory] = useState<ImageBackgroundCategory | "all">("all")
  const fileInputRef = useRef<HTMLInputElement>(null)

  const filteredPresets = useMemo(() => {
    if (activeCategory === "all") return IMAGE_BACKGROUND_PRESETS
    return IMAGE_BACKGROUND_PRESETS.filter((p) => p.category === activeCategory)
  }, [activeCategory])

  const isPresetSelected = (presetSrc: string) => {
    return value.includes(presetSrc) || (value.startsWith("url(") && value.includes(presetSrc))
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string
      if (dataUrl) {
        onChange(dataUrl)
      }
    }
    reader.readAsDataURL(file)
  }

  const isCustomUploaded =
    value.startsWith("data:image/") ||
    (value.startsWith("blob:") && !IMAGE_BACKGROUND_PRESETS.some((p) => value.includes(p.src)))

  const hasActiveFilters = backgroundBlur > 0 || backgroundDim > 0

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

      {/* Preset Images Grid */}
      <div
        className="grid grid-cols-3 gap-2 max-h-[220px] overflow-y-auto pr-1"
        role="listbox"
        aria-label="Image background presets"
      >
        {filteredPresets.map((preset) => {
          const selected = isPresetSelected(preset.src)

          return (
            <button
              key={preset.id}
              type="button"
              role="option"
              aria-selected={selected}
              title={preset.name}
              onClick={() => onChange(preset.src)}
              className={cn(
                "group relative flex flex-col items-center overflow-hidden rounded-lg border border-border/80 p-1 text-left transition-all",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                selected
                  ? "border-primary bg-primary/10 ring-2 ring-primary ring-offset-1 ring-offset-background shadow-xs"
                  : "hover:border-border-hover hover:scale-[1.02] bg-surface-dim/50",
              )}
            >
              <div className="relative aspect-video w-full overflow-hidden rounded-md bg-surface-dim shadow-xs">
                <img
                  src={preset.src}
                  alt={preset.name}
                  loading="lazy"
                  className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
                />
                {selected && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                    <Check className="size-4 stroke-[3] text-white drop-shadow-md" aria-hidden />
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

      {/* Upload Custom Image & Manage */}
      <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface-dim p-2.5">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          className="hidden"
          onChange={handleFileUpload}
        />

        <Button
          variant="outline"
          size="sm"
          className="flex-1 text-xs"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="size-3.5 text-primary" aria-hidden />
          Upload Image
        </Button>

        {isCustomUploaded && (
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-destructive hover:bg-destructive/10"
            onClick={() => onChange("#070b14")}
            title="Remove custom image"
          >
            <Trash2 className="size-3.5" aria-hidden />
            Remove
          </Button>
        )}
      </div>

      {/* Image Filters: Blur & Dim */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-dim/50 p-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <Sliders className="size-3.5 text-primary" aria-hidden />
            <span>Image Filters</span>
          </div>
          {hasActiveFilters && (
            <button
              type="button"
              onClick={() => {
                onBlurChange?.(0)
                onDimChange?.(0)
              }}
              className="flex items-center gap-1 text-[10px] text-subtle-foreground hover:text-foreground transition-colors"
            >
              <RotateCcw className="size-3" aria-hidden />
              Reset filters
            </button>
          )}
        </div>

        {/* Background Blur */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[11px] text-subtle-foreground">
            <span>Background Blur</span>
            <span className="font-mono text-[10px] text-foreground">{backgroundBlur}px</span>
          </div>
          <Slider
            value={[backgroundBlur]}
            min={0}
            max={64}
            step={1}
            onValueChange={([val]) => val !== undefined && onBlurChange?.(val)}
          />
          <div className="flex items-center justify-between gap-1 pt-0.5">
            {BACKGROUND_BLUR_PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => onBlurChange?.(p.value)}
                className={cn(
                  "flex-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium transition-colors",
                  backgroundBlur === p.value
                    ? "bg-primary text-primary-foreground"
                    : "bg-surface text-subtle-foreground hover:bg-surface-hover hover:text-foreground",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Background Dim */}
        <div className="flex flex-col gap-1.5 pt-1 border-t border-border/50">
          <div className="flex items-center justify-between text-[11px] text-subtle-foreground">
            <span>Background Dim</span>
            <span className="font-mono text-[10px] text-foreground">
              {Math.round(backgroundDim * 100)}%
            </span>
          </div>
          <Slider
            value={[Math.round(backgroundDim * 100)]}
            min={0}
            max={90}
            step={5}
            onValueChange={([val]) => val !== undefined && onDimChange?.(val / 100)}
          />
          <div className="flex items-center justify-between gap-1 pt-0.5">
            {BACKGROUND_DIM_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => onDimChange?.(p.value)}
                className={cn(
                  "flex-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium transition-colors",
                  Math.abs(backgroundDim - p.value) < 0.01
                    ? "bg-primary text-primary-foreground"
                    : "bg-surface text-subtle-foreground hover:bg-surface-hover hover:text-foreground",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

