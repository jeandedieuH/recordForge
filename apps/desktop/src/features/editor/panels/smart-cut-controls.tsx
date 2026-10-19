import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@recordforge/ui"

// Scan controls for Smart Cut. Sensitivity gets a full row; minimum pause and
// padding share the second row so each select stays usable in the narrow panel.

// null = the adaptive RMS calibration; numbers are fixed dB floors.
const AUTO_VALUE = "auto"
const SENSITIVITY_OPTIONS = [
  { value: AUTO_VALUE, label: "Automatic (recommended)", hint: "Calibrates to this recording" },
  { value: "-45", label: "Conservative", hint: "Only clearly dead air" },
  { value: "-35", label: "Balanced", hint: "-35 dB RMS, most pauses" },
  { value: "-25", label: "More pauses", hint: "-25 dB RMS, catches quieter breaths" },
] as const
const MIN_PAUSE_OPTIONS = [300, 500, 1000] as const
const PADDING_OPTIONS = [80, 120, 200] as const

interface SmartCutScanControlsProps {
  thresholdDb: number | null
  minDurationMs: number
  paddingMs: number
  onThresholdDbChange: (value: number | null) => void
  onMinDurationMsChange: (value: number) => void
  onPaddingMsChange: (value: number) => void
}

export function SmartCutScanControls({
  thresholdDb,
  minDurationMs,
  paddingMs,
  onThresholdDbChange,
  onMinDurationMsChange,
  onPaddingMsChange,
}: SmartCutScanControlsProps) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-1">
        <span className="text-ui-caption font-medium text-foreground">Sensitivity</span>
        <Select
          value={thresholdDb === null ? AUTO_VALUE : String(thresholdDb)}
          onValueChange={(v) => onThresholdDbChange(v === AUTO_VALUE ? null : Number(v))}
        >
          <SelectTrigger className="w-full" aria-label="Sensitivity">
            {/* Explicit short label — SelectValue would otherwise portal the
                hint text inside ItemText into the trigger. */}
            <SelectValue placeholder="Sensitivity">
              {SENSITIVITY_OPTIONS.find(
                (o) => o.value === (thresholdDb === null ? AUTO_VALUE : String(thresholdDb)),
              )?.label ?? "Sensitivity"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Pause sensitivity — higher dB RMS is more sensitive</SelectLabel>
              {SENSITIVITY_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  <div className="flex flex-col">
                    <span>{option.label}</span>
                    <span className="text-ui-micro text-subtle-foreground">{option.hint}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <span className="text-ui-caption font-medium text-foreground">Minimum pause</span>
          <Select
            value={String(minDurationMs)}
            onValueChange={(v) => onMinDurationMsChange(Number(v))}
          >
            <SelectTrigger className="w-full" aria-label="Minimum pause">
              <SelectValue placeholder="Min pause" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Only detect pauses at least…</SelectLabel>
                {MIN_PAUSE_OPTIONS.map((ms) => (
                  <SelectItem key={ms} value={String(ms)}>
                    {ms} ms
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-ui-caption font-medium text-foreground">Padding</span>
          <Select value={String(paddingMs)} onValueChange={(v) => onPaddingMsChange(Number(v))}>
            <SelectTrigger className="w-full" aria-label="Padding">
              <SelectValue placeholder="Padding" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Keep this much around each cut</SelectLabel>
                {PADDING_OPTIONS.map((ms) => (
                  <SelectItem key={ms} value={String(ms)}>
                    {ms} ms
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  )
}
