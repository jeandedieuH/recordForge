import { Badge, NumberInputField, Slider, ToggleGroup, ToggleGroupItem } from "@recordforge/ui"
import { Sparkles } from "lucide-react"

interface SmartCutControlsProps {
  /** Effective silence threshold in dBFS currently applied. */
  thresholdDb: number
  /** True while the threshold follows the estimate rather than the slider. */
  isAuto: boolean
  onSensitivityChange: (db: number) => void
  onAutoSelect: () => void
  minDurationMs: number
  onMinDurationChange: (ms: number) => void
  paddingMs: number
  onPaddingChange: (ms: number) => void
  disabled?: boolean
}

const MIN_DURATION_CHOICES = [
  { value: "300", label: "0.3 s" },
  { value: "500", label: "0.5 s" },
  { value: "1000", label: "1 s" },
  { value: "2000", label: "2 s" },
] as const

// The slider exposes a friendly 0–100 "sensitivity" that maps onto the dB
// range where speech-vs-silence decisions actually happen.
const SLIDER_MIN_DB = -55
const SLIDER_MAX_DB = -24

function dbToSlider(db: number): number {
  return Math.round(((db - SLIDER_MIN_DB) / (SLIDER_MAX_DB - SLIDER_MIN_DB)) * 100)
}

function sliderToDb(value: number): number {
  return Math.round(SLIDER_MIN_DB + (value / 100) * (SLIDER_MAX_DB - SLIDER_MIN_DB))
}

export function SmartCutControls({
  thresholdDb,

  isAuto,
  onSensitivityChange,
  onAutoSelect,
  minDurationMs,
  onMinDurationChange,
  paddingMs,
  onPaddingChange,
  disabled,
}: SmartCutControlsProps) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-foreground/80">Sensitivity</span>
        <button
          type="button"
          onClick={onAutoSelect}
          disabled={disabled || isAuto}
          className="disabled:opacity-100"
          title={
            isAuto
              ? "Threshold estimated from the recording's noise floor"
              : "Reset to the estimated noise-floor threshold"
          }
        >
          <Badge variant={isAuto ? "accent" : "default"} className="cursor-pointer gap-1">
            <Sparkles className="size-2.5" aria-hidden />
            {isAuto ? "Auto" : "Set auto"} · {thresholdDb} dB
          </Badge>
        </button>
      </div>
      <Slider
        value={[dbToSlider(thresholdDb)]}
        min={0}
        max={100}
        step={1}
        thumbLabel="Silence sensitivity"
        aria-label="Silence sensitivity"
        disabled={disabled}
        onValueChange={([value]) => onSensitivityChange(sliderToDb(value ?? 0))}
      />
      <div className="flex items-end justify-between gap-2">
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-foreground/80">Min silence</span>
          <ToggleGroup
            type="single"
            value={String(minDurationMs)}
            onValueChange={(value) => {
              if (value) onMinDurationChange(Number(value))
            }}
            className="inline-flex rounded-md border border-border"
            aria-label="Minimum silence duration"
          >
            {MIN_DURATION_CHOICES.map((choice) => (
              <ToggleGroupItem
                key={choice.value}
                value={choice.value}
                disabled={disabled}
                className="px-2 py-1 text-[10px]"
              >
                {choice.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <NumberInputField
          size="sm"
          label="Keep padding"
          unit="ms"
          min={0}
          max={400}
          step={10}
          value={paddingMs}
          disabled={disabled}
          onChange={(value) => onPaddingChange(value)}
          containerClassName="w-[86px] shrink-0"
        />
      </div>
    </div>
  )
}
