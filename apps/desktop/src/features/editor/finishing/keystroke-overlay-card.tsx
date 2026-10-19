import type { KeystrokeOverlay, ProFeatureKey } from "@recordforge/contracts"
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
} from "@recordforge/ui"
import { Keyboard } from "lucide-react"
import { ProBadge } from "../../licensing/pro-badge"

// Shared keystroke badge card — Finishing panel, Cursor panel, and export
// view all edit the same durable project.exportSettings.keystrokeOverlay.
interface KeystrokeOverlayCardProps {
  overlay: KeystrokeOverlay
  disabled?: boolean
  isPro: boolean
  // Number of captured modifier-combo events on this recording; 0 shows the
  // "nothing captured" state instead of dead controls.
  eventCount: number
  // False on platforms without a capture hook (Linux) — explains rather
  // than pretending the feature could have recorded. Events already on disk
  // still preview/export even when capture is unsupported.
  captureSupported: boolean
  // Four-states for the event load: skeleton while loading, retry on error.
  // `status` replaces conflating load errors with "unsupported platform".
  status: "loading" | "loaded" | "error"
  statusError?: string | null
  onRetry?: () => void
  onChange: (update: boolean | Partial<KeystrokeOverlay>) => void
  onUpgradeRequest: (features?: ProFeatureKey[]) => void
}

const HOLD_OPTIONS = [
  { value: "800", label: "Short (800 ms)" },
  { value: "1400", label: "Balanced (1.4 s)" },
  { value: "2500", label: "Long (2.5 s)" },
  { value: "4000", label: "Extended (4 s)" },
] as const

const POSITION_OPTIONS = [
  { value: "bottom-center", label: "Bottom center" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "bottom-right", label: "Bottom right" },
  { value: "top-center", label: "Top center" },
] as const

const SCALE_OPTIONS = [
  { value: "75", label: "Small (75%)" },
  { value: "100", label: "Default (100%)" },
  { value: "125", label: "Large (125%)" },
  { value: "150", label: "Extra large (150%)" },
] as const

export function KeystrokeOverlayCard({
  overlay,
  disabled,
  isPro,
  eventCount,
  captureSupported,
  status,
  statusError,
  onRetry,
  onChange,
  onUpgradeRequest,
}: KeystrokeOverlayCardProps) {
  function gate(): boolean {
    if (isPro) return false
    onUpgradeRequest(["keystroke-overlay"])
    return true
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex w-full items-center justify-between p-4">
        <span className="flex items-center gap-2 font-label text-xs font-bold uppercase tracking-wider text-muted-foreground">
          <Keyboard className="size-4 text-primary" aria-hidden />
          Keystroke badges
          {!isPro ? <ProBadge /> : null}
        </span>
        <Switch
          checked={overlay.enabled}
          disabled={disabled}
          aria-label="Keystroke badges"
          onCheckedChange={(enabled) => {
            if (enabled && gate()) return
            onChange(enabled)
          }}
        />
      </div>
      {overlay.enabled ? (
        <div className="flex flex-col gap-4 border-t border-border p-5 text-xs text-subtle-foreground">
          {status === "loading" ? (
            <Skeleton className="h-4 w-3/4 rounded" />
          ) : status === "error" ? (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={onRetry} disabled={disabled}>
                Retry
              </Button>
              <span className="flex-1">
                Couldn't load captured shortcuts{statusError ? ` — ${statusError}` : ""}.
              </span>
            </div>
          ) : eventCount === 0 ? (
            <p>
              {captureSupported
                ? "No shortcuts captured in this recording — enable Keystroke Overlay in the recorder before recording to show badges. On macOS, capture also requires granting RecordForge Accessibility permission in System Settings."
                : "Keystroke capture isn't available on Linux — events captured on Windows or macOS still preview and export."}
            </p>
          ) : (
            <p className="text-foreground">
              {eventCount} shortcut{eventCount === 1 ? "" : "s"} captured — badges play on the
              canvas when the overlay is enabled.
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-foreground">Show for</span>
              <Select
                value={String(overlay.durationMs)}
                onValueChange={(value) => onChange({ durationMs: Number(value) })}
                disabled={disabled}
              >
                <SelectTrigger className="h-8 w-full" aria-label="Badge duration">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOLD_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-foreground">Size</span>
              <Select
                value={String(overlay.scalePercent)}
                onValueChange={(value) => onChange({ scalePercent: Number(value) })}
                disabled={disabled}
              >
                <SelectTrigger className="h-8 w-full" aria-label="Badge size">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCALE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-foreground">Position</span>
            <Select
              value={overlay.position}
              onValueChange={(value) =>
                onChange({ position: value as KeystrokeOverlay["position"] })
              }
              disabled={disabled}
            >
              <SelectTrigger className="h-8 w-full" aria-label="Badge position">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {POSITION_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <p>
            Modifier combos recorded during capture (Ctrl+C, Alt+Tab…) appear as badges. Plain
            typing is never recorded or shown.
          </p>
        </div>
      ) : null}
    </div>
  )
}
