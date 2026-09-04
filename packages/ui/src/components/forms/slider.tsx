import * as SliderPrimitive from "@radix-ui/react-slider"
import { cva, type VariantProps } from "class-variance-authority"
import type { ComponentProps, ReactNode } from "react"
import { cn } from "../../lib/cn"

const sliderTrackVariants = cva(
  "relative w-full grow overflow-hidden rounded-full border border-border/50 bg-surface-container-highest/80 shadow-inner",
  {
    variants: {
      size: {
        sm: "h-1",
        default: "h-1.5",
        lg: "h-2",
      },
    },
    defaultVariants: {
      size: "default",
    },
  },
)

const sliderRangeVariants = cva("absolute h-full rounded-full transition-all duration-75", {
  variants: {
    variant: {
      primary: "bg-primary",
      accent: "bg-accent",
      emerald: "bg-track-mic",
    },
  },
  defaultVariants: {
    variant: "primary",
  },
})

const sliderThumbVariants = cva(
  "block cursor-grab rounded-full bg-foreground shadow-md shadow-black/40 transition-[transform,box-shadow] duration-fast ease-forge outline-none hover:scale-115 active:scale-105 active:cursor-grabbing active:shadow-lg focus-visible:ring-4 disabled:pointer-events-none",
  {
    variants: {
      size: {
        sm: "size-3 border-[1.5px]",
        default: "size-3.5 border-2",
        lg: "size-4 border-2",
      },
      variant: {
        primary: "border-primary focus-visible:ring-primary/25",
        accent: "border-accent focus-visible:ring-accent/25",
        emerald: "border-track-mic focus-visible:ring-track-mic/25",
      },
    },
    defaultVariants: {
      size: "default",
      variant: "primary",
    },
  },
)

const sliderRootVariants = cva(
  "relative flex w-full touch-none items-center select-none data-[disabled]:opacity-40",
  {
    variants: {
      size: {
        sm: "h-4",
        default: "h-5",
        lg: "h-6",
      },
    },
    defaultVariants: {
      size: "default",
    },
  },
)

interface SliderProps
  extends
    ComponentProps<typeof SliderPrimitive.Root>,
    VariantProps<typeof sliderRootVariants>,
    VariantProps<typeof sliderRangeVariants> {
  /** Optional tick marks at percentage points (0..100) */
  ticks?: number[]
}

function Slider({ className, size, variant, ticks, value, defaultValue, ...props }: SliderProps) {
  const values = value ?? defaultValue ?? [0]

  return (
    <SliderPrimitive.Root
      className={cn(sliderRootVariants({ size }), className)}
      value={value}
      defaultValue={defaultValue}
      {...props}
    >
      <SliderPrimitive.Track className={cn(sliderTrackVariants({ size }))}>
        <SliderPrimitive.Range className={cn(sliderRangeVariants({ variant }))} />
        {ticks?.map((tick) => (
          <span
            key={tick}
            className="pointer-events-none absolute top-1/2 size-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted-foreground/40"
            style={{ left: `${Math.max(0, Math.min(100, tick))}%` }}
            aria-hidden
          />
        ))}
      </SliderPrimitive.Track>
      {values.map((_, index) => (
        <SliderPrimitive.Thumb
          key={index}
          aria-label="Value"
          className={cn(sliderThumbVariants({ size, variant }))}
        />
      ))}
    </SliderPrimitive.Root>
  )
}

interface SliderPreset {
  value: number
  label: string
}

interface SliderFieldProps extends Omit<SliderProps, "value" | "onValueChange" | "onChange"> {
  label: ReactNode
  value: number
  onChange?: (value: number) => void
  onValueChange?: (value: number) => void
  formatValue?: (value: number) => string
  unit?: string
  presets?: SliderPreset[]
  containerClassName?: string
}

/**
 * High-level compound Slider component with integrated label, current value readout,
 * and optional quick-preset buttons.
 */
function SliderField({
  label,
  value,
  onChange,
  onValueChange,
  formatValue,
  unit,
  presets,
  containerClassName,
  min = 0,
  max = 100,
  step = 1,
  size = "default",
  variant = "primary",
  ...props
}: SliderFieldProps) {
  const displayValue = formatValue ? formatValue(value) : `${value}${unit ?? ""}`

  const handleChange = (val: number) => {
    onChange?.(val)
    onValueChange?.(val)
  }

  return (
    <div className={cn("flex flex-col gap-1.5", containerClassName)}>
      <div className="flex items-center justify-between text-[11px] text-subtle-foreground">
        <span className="font-medium text-foreground/80">{label}</span>
        <span className="font-mono text-[10px] text-foreground">{displayValue}</span>
      </div>
      <Slider
        size={size}
        variant={variant}
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([val]) => {
          if (val !== undefined) handleChange(val)
        }}
        {...props}
      />
      {presets && presets.length > 0 ? (
        <div className="flex items-center justify-between gap-1 pt-0.5">
          {presets.map((p) => {
            const isSelected = value === p.value
            return (
              <button
                key={p.value}
                type="button"
                onClick={() => handleChange(p.value)}
                className={cn(
                  "flex-1 cursor-pointer rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium transition-colors duration-fast ease-forge",
                  isSelected
                    ? "border-primary/60 bg-primary/15 font-semibold text-primary shadow-xs"
                    : "border-border/60 bg-surface text-subtle-foreground hover:border-border hover:bg-surface-hover hover:text-foreground",
                )}
              >
                {p.label}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

export { Slider, SliderField, sliderRootVariants, sliderThumbVariants, sliderTrackVariants }
export type { SliderFieldProps, SliderPreset, SliderProps }
