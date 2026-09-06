import { useId, type ComponentProps } from "react"
import {
  NumberInput,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@recordforge/ui"
import { DebouncedSlider } from "./fields"

export function AnnotationNumberField({
  label,
  ...props
}: ComponentProps<typeof NumberInput> & { label: string }) {
  const id = useId()
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="block text-xs text-muted-foreground">
        {label}
      </label>
      <NumberInput id={id} size="default" className="text-xs" {...props} />
    </div>
  )
}

export function AnnotationSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  disabled?: boolean
}) {
  const id = useId()
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="block text-xs text-muted-foreground">
        {label}
      </label>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          const option = options.find((item) => item.value === next)
          if (option) onChange(option.value)
        }}
      >
        <SelectTrigger id={id} className="h-8 w-full text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value} className="text-xs">
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  )
}

export function AnnotationSlider({
  label,
  value,
  displayValue,
  onChange,
  min = 0,
  max,
  step = 1,
}: {
  label: string
  value: number
  displayValue: string
  onChange: (value: number) => void
  min?: number
  max: number
  step?: number
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span id={id} className="text-muted-foreground">
          {label}
        </span>
        <span className="tabular-nums text-foreground">{displayValue}</span>
      </div>
      {/* Name the group because the shared slider owns its internal thumb label. */}
      <DebouncedSlider
        role="group"
        aria-labelledby={id}
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueCommit={([next]) => onChange(next)}
      />
    </div>
  )
}
