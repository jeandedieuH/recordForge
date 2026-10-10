import type { LucideIcon } from "lucide-react"
import { cn, Slider } from "@recordforge/ui"

interface SliderControlProps {
  icon: LucideIcon
  /** Accessible name — used for the group label and the slider thumb. */
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  readout: string
  readoutClassName?: string
}

/** Icon + compact accent slider + fixed-width readout used across the dock. */
export function SliderControl({
  icon: Icon,
  label,
  value,
  min,
  max,
  step,
  onChange,
  readout,
  readoutClassName,
}: SliderControlProps) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex min-w-0 flex-1 basis-32 items-center gap-2"
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <Slider
        size="sm"
        variant="accent"
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([next]) => {
          if (next !== undefined) onChange(next)
        }}
        thumbLabel={label}
        className="min-w-14 flex-1"
      />
      <span
        className={cn(
          "shrink-0 text-right text-xs tabular-nums text-muted-foreground",
          readoutClassName,
        )}
      >
        {readout}
      </span>
    </div>
  )
}
