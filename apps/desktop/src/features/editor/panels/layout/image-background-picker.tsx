import { useRef } from "react"
import { Check, Upload, Trash2, Sliders, RotateCcw } from "lucide-react"
import {
  BACKGROUND_BLUR_PRESETS,
  BACKGROUND_DIM_PRESETS,
  IMAGE_BACKGROUND_PRESETS,
} from "@recordforge/editor-core"
import { Button, SliderField, cn } from "@recordforge/ui"

interface ImageBackgroundPickerProps {
  value: string
  onChange: (imageSrc: string) => void
  backgroundBlur?: number
  onBlurChange?: (blur: number) => void
  backgroundDim?: number
  onDimChange?: (dim: number) => void
  backgroundFit?: "cover" | "contain" | "fill"
  onFitChange?: (fit: "cover" | "contain" | "fill") => void
}

export function ImageBackgroundPicker({
  value,
  onChange,
  backgroundBlur = 0,
  onBlurChange,
  backgroundDim = 0,
  onDimChange,
  backgroundFit = "cover",
  onFitChange,
}: ImageBackgroundPickerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)

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
      {/* Preset Images Grid */}
      <div
        className="grid grid-cols-3 gap-2 max-h-56 overflow-y-auto pr-1"
        role="listbox"
        aria-label="Image background presets"
      >
        {IMAGE_BACKGROUND_PRESETS.map((preset) => {
          const selected = isPresetSelected(preset.src)

          return (
            <button
              key={preset.id}
              type="button"
              role="option"
              aria-selected={selected}
              aria-label={`Background preset ${preset.id.replace("bg-", "")}`}
              onClick={() => onChange(preset.src)}
              className={cn(
                "group relative aspect-video w-full overflow-hidden rounded-md border border-border/80 p-0.5 transition-all",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                selected
                  ? "border-primary bg-primary/10 ring-2 ring-primary ring-offset-1 ring-offset-background shadow-xs scale-105"
                  : "hover:border-border-hover hover:scale-105 bg-surface-dim/50",
              )}
            >
              <div className="relative size-full overflow-hidden rounded-[4px] bg-surface-dim shadow-xs">
                <img
                  src={preset.src}
                  alt={`Background ${preset.id.replace("bg-", "")}`}
                  loading="lazy"
                  className="size-full object-cover transition-transform duration-300 group-hover:scale-110"
                />
                {selected && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                    <Check className="size-4 stroke-3 text-white drop-shadow-md" aria-hidden />
                  </div>
                )}
              </div>
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

      {/* Sizing & Fit Mode */}
      <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-dim/50 p-2.5">
        <div className="flex items-center justify-between text-[11px] text-subtle-foreground font-medium">
          <span>Image Sizing</span>
          <span className="text-[10px] text-foreground font-medium capitalize">
            {backgroundFit === "contain" ? "Fit / Full Image" : "Fill / Cover"}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-1.5 pt-0.5">
          <button
            type="button"
            onClick={() => onFitChange?.("cover")}
            className={cn(
              "flex flex-col items-center gap-0.5 rounded-md border p-2 text-center transition-colors",
              backgroundFit !== "contain"
                ? "border-primary/60 bg-primary/15 font-semibold text-primary shadow-xs"
                : "border-border/60 bg-surface text-subtle-foreground hover:border-border hover:bg-surface-hover hover:text-foreground",
            )}
          >
            <span className="text-xs font-medium">Fill / Cover</span>
            <span className="text-[9px] opacity-75">Fills canvas, crops edges</span>
          </button>
          <button
            type="button"
            onClick={() => onFitChange?.("contain")}
            className={cn(
              "flex flex-col items-center gap-0.5 rounded-md border p-2 text-center transition-colors",
              backgroundFit === "contain"
                ? "border-primary/60 bg-primary/15 font-semibold text-primary shadow-xs"
                : "border-border/60 bg-surface text-subtle-foreground hover:border-border hover:bg-surface-hover hover:text-foreground",
            )}
          >
            <span className="text-xs font-medium">Fit / Full Image</span>
            <span className="text-[9px] opacity-75">No zoom, soft ambient blur</span>
          </button>
        </div>
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
        <SliderField
          label="Background Blur"
          value={backgroundBlur}
          min={0}
          max={64}
          step={1}
          unit="px"
          presets={BACKGROUND_BLUR_PRESETS.map((p) => ({ label: p.label, value: p.value }))}
          onChange={(val) => onBlurChange?.(val)}
        />

        {/* Background Dim */}
        <div className="pt-1 border-t border-border/50">
          <SliderField
            label="Background Dim"
            value={Math.round(backgroundDim * 100)}
            min={0}
            max={90}
            step={5}
            unit="%"
            presets={BACKGROUND_DIM_PRESETS.map((p) => ({
              label: p.label,
              value: Math.round(p.value * 100),
            }))}
            onChange={(val) => onDimChange?.(val / 100)}
          />
        </div>
      </div>
    </div>
  )
}
