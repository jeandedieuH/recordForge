import type { CanvasAspectRatio } from "@recordforge/contracts"
import { Monitor, Smartphone, Square, Tv } from "lucide-react"
import { cn } from "@recordforge/ui"

interface AspectRatioOption {
  value: CanvasAspectRatio
  label: string
  resolution: string
  sublabel: string
  icon: typeof Monitor
  width: number
  height: number
}

export const ASPECT_RATIO_OPTIONS: AspectRatioOption[] = [
  {
    value: "16:9",
    label: "16:9",
    resolution: "1920 × 1080",
    sublabel: "Landscape / YouTube",
    icon: Monitor,
    width: 1920,
    height: 1080,
  },
  {
    value: "9:16",
    label: "9:16",
    resolution: "1080 × 1920",
    sublabel: "Shorts / TikTok / Reels",
    icon: Smartphone,
    width: 1080,
    height: 1920,
  },
  {
    value: "1:1",
    label: "1:1",
    resolution: "1080 × 1080",
    sublabel: "Square / Feed",
    icon: Square,
    width: 1080,
    height: 1080,
  },
  {
    value: "5:4",
    label: "5:4",
    resolution: "1350 × 1080",
    sublabel: "Desktop / Classic",
    icon: Tv,
    width: 1350,
    height: 1080,
  },
  {
    value: "4:5",
    label: "4:5",
    resolution: "1080 × 1350",
    sublabel: "Portrait / Social Feed",
    icon: Smartphone,
    width: 1080,
    height: 1350,
  },
]

interface AspectRatioSelectorProps {
  value: CanvasAspectRatio | undefined
  onChange: (option: AspectRatioOption) => void
}

export function AspectRatioSelector({ value = "16:9", onChange }: AspectRatioSelectorProps) {
  const current = value ?? "16:9"

  return (
    <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Canvas aspect ratio">
      {ASPECT_RATIO_OPTIONS.map((opt) => {
        const isSelected = current === opt.value
        const Icon = opt.icon

        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            onClick={() => onChange(opt)}
            className={cn(
              "group relative flex flex-col items-center justify-between rounded-lg border p-2 text-left transition-all",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
              isSelected
                ? "border-primary/80 bg-primary/10 text-foreground shadow-xs"
                : "border-border bg-surface-dim/70 text-subtle-foreground hover:border-border-hover hover:bg-surface hover:text-foreground",
            )}
          >
            <div className="flex w-full items-center justify-between">
              <Icon
                className={cn(
                  "size-3.5 transition-colors",
                  isSelected
                    ? "text-primary"
                    : "text-subtle-foreground group-hover:text-foreground",
                )}
                aria-hidden
              />
              <span
                className={cn(
                  "font-mono text-[10px] font-semibold",
                  isSelected ? "text-primary" : "text-foreground",
                )}
              >
                {opt.label}
              </span>
            </div>

            <div className="mt-1.5 w-full">
              <p className="truncate text-[10px] font-medium text-foreground">{opt.sublabel}</p>
              <p className="font-mono text-[9px] text-muted-foreground">{opt.resolution}</p>
            </div>
          </button>
        )
      })}
    </div>
  )
}
