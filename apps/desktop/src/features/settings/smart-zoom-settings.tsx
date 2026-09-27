import { memo } from "react"
import { Sparkles } from "lucide-react"
import type { RecordingSmartZoomPreset } from "@recordforge/contracts"
import { ZOOM_PRESETS } from "@recordforge/cursor-core"
import { SimpleSelect, Switch } from "@recordforge/ui"

// Options derive from the canonical preset table so labels and scales here can
// never drift from what generation actually applies.
const SMART_ZOOM_PRESET_OPTIONS = Object.values(ZOOM_PRESETS).map((definition) => ({
  value: definition.id,
  label:
    definition.id === "manual-only"
      ? definition.label
      : `${definition.label} · ${definition.scale}×`,
}))

interface SmartZoomSettingsProps {
  enabled: boolean
  preset: RecordingSmartZoomPreset
  disabled?: boolean
  onEnabledChange: (enabled: boolean) => void
  onPresetChange: (preset: RecordingSmartZoomPreset) => void
}

export const SmartZoomSettings = memo(function SmartZoomSettings({
  enabled,
  preset,
  disabled = false,
  onEnabledChange,
  onPresetChange,
}: SmartZoomSettingsProps) {
  return (
    <section className="rounded-2xl border border-primary/30 bg-primary/5 p-5 shadow-e1">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Sparkles className="size-4" aria-hidden />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-foreground">
                Smart Zoom for new recordings
              </h3>
              <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                {enabled ? "On" : "Off"}
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-subtle-foreground">
              Detects clicks and focused cursor activity, then adds editable zoom ranges to the new
              recording before it opens in the editor.
            </p>
          </div>
        </div>
        <Switch
          checked={enabled}
          disabled={disabled}
          onCheckedChange={onEnabledChange}
          aria-label="Enable smart zoom for new recordings"
        />
      </div>

      <div className="mt-4 flex flex-col gap-1.5 border-t border-primary/15 pt-4">
        <label htmlFor="smart-zoom-preset" className="text-xs font-medium text-foreground">
          Smart zoom style
        </label>
        <SimpleSelect
          aria-label="Smart zoom style"
          value={preset}
          disabled={disabled}
          onValueChange={(val) => onPresetChange(val as RecordingSmartZoomPreset)}
          className="w-full sm:w-60"
          options={SMART_ZOOM_PRESET_OPTIONS}
        />
        <p
          id="smart-zoom-preset-help"
          className="text-[11px] leading-relaxed text-subtle-foreground"
        >
          The generated ranges remain independent and can be moved, trimmed, retargeted, or deleted
          from the Zoom lane.
        </p>
      </div>
    </section>
  )
})
