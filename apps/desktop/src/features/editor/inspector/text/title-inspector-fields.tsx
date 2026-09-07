import { useId } from "react"
import type { TextClip } from "@recordforge/contracts"
import { Label, NativeSelect } from "@recordforge/ui"
import { DebouncedSlider } from "../fields"

export interface TitleSectionProps {
  clip: TextClip
  onChange: (update: Partial<TextClip>) => void
}

export function TitleSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: readonly (readonly [T, string])[]
  onChange: (value: T) => void
}) {
  const id = useId()
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <NativeSelect
        id={id}
        size="sm"
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map(([key, name]) => (
          <option key={key} value={key}>
            {name}
          </option>
        ))}
      </NativeSelect>
    </div>
  )
}

export function TitleSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  unit,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit?: string
  onChange: (value: number) => void
}) {
  const id = useId()
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id} className="text-xs text-muted-foreground">
          {label}
        </Label>
        <span className="font-mono text-xs tabular-nums">
          {value}
          {unit}
        </span>
      </div>
      <DebouncedSlider
        id={id}
        aria-label={label}
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueCommit={([next]) => onChange(next)}
      />
    </div>
  )
}
