import { memo } from "react"
import type { ZoomPreset } from "@recordforge/contracts"
import { AlertCircle, Loader2, Sparkles, Wand2 } from "lucide-react"
import { Button, SimpleSelect } from "@recordforge/ui"

interface SmartZoomCardProps {
  preset: ZoomPreset
  onPresetChange: (preset: ZoomPreset) => void
  telemetryStatus: "loading" | "available" | "unavailable"
  onReviewSuggestions: () => void
  disabled?: boolean
}

export const SmartZoomCard = memo(function SmartZoomCard({
  preset,
  onPresetChange,
  telemetryStatus,
  onReviewSuggestions,
  disabled = false,
}: SmartZoomCardProps) {
  const isReviewDisabled = disabled || telemetryStatus !== "available" || preset === "manual-only"

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-border/90 bg-surface-dim/80 p-3 shadow-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <div className="flex size-5 items-center justify-center rounded-md bg-secondary/15 text-secondary">
            <Sparkles className="size-3 text-purple-400" aria-hidden />
          </div>
          <span className="text-xs font-semibold text-foreground">Smart Zoom</span>
        </div>

        <SimpleSelect
          aria-label="Smart zoom preset"
          size="sm"
          value={preset}
          onValueChange={(val) => onPresetChange(val as ZoomPreset)}
          className="h-7 w-36 text-[11px]"
          options={[
            { value: "product-demo", label: "Product Demo" },
            { value: "developer", label: "Developer (Code)" },
            { value: "cinematic", label: "Cinematic" },
            { value: "subtle", label: "Subtle" },
            { value: "manual-only", label: "Manual Only" },
          ]}
        />
      </div>

      <p className="text-[11px] leading-relaxed text-subtle-foreground">
        Intelligent action clustering detects rapid clicks and code edits to generate smooth,
        cinematic focus frames.
      </p>

      {telemetryStatus === "unavailable" ? (
        <div
          className="flex items-center gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-[10px] text-warning"
          role="status"
        >
          <AlertCircle className="size-3.5 shrink-0" aria-hidden />
          <span>No cursor telemetry detected in recording</span>
        </div>
      ) : null}

      {telemetryStatus === "loading" ? (
        <div
          className="flex items-center gap-1.5 rounded-md border border-border bg-overlay/50 px-2 py-1.5 text-[10px] text-subtle-foreground"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="size-3 shrink-0 animate-spin text-primary" aria-hidden />
          <span>Checking cursor telemetry…</span>
        </div>
      ) : null}

      <Button
        variant="outline"
        size="sm"
        className="h-7.5 w-full text-xs font-medium border-border/90 hover:border-primary/40 hover:bg-primary/5 transition-colors"
        disabled={isReviewDisabled}
        onClick={onReviewSuggestions}
      >
        <Wand2 className="size-3.5 text-purple-400" data-icon="inline-start" />
        <span>Generate & Review Suggestions</span>
      </Button>
    </div>
  )
})
