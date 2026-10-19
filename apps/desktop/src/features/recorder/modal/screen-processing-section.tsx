import { Keyboard, Sparkles, Zap } from "lucide-react"
import { Switch } from "@recordforge/ui"
import { useRecorderStore } from "../../../hooks/use-recorder"
import { useLicenseStore } from "../../../stores/license-store"
import { ProBadge } from "../../licensing/pro-badge"
import { isLinux } from "../../../lib/platform"

// GPU screen processing / Smart Zoom / Keystroke overlay — screen modes
// only; camera mode never captures keystrokes or cursor telemetry.
export function ScreenProcessingSection() {
  const { preferences, savePreferences } = useRecorderStore()
  const isPro = useLicenseStore((state) => state.status.tier === "pro")
  const openUpgradeDialog = useLicenseStore((state) => state.openUpgradeDialog)
  // Keystroke capture has no Linux input hook yet — keep the toggle honest
  // instead of silently recording nothing.
  const keystrokesSupported = !isLinux

  return (
    <div className="flex flex-col gap-4 md:col-span-2">
      <h3 className="font-label text-xs font-bold tracking-wider uppercase text-subtle-foreground">
        Processing
      </h3>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-border bg-surface-dim p-3.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-overlay text-muted-foreground">
                <Zap className="size-4" aria-hidden />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-foreground">GPU screen processing</div>
                <p className="mt-0.5 text-xs text-subtle-foreground">
                  Use a compatible GPU path when available; fall back automatically. Turn off to
                  compare the compatibility path.
                </p>
              </div>
            </div>
            <Switch
              checked={preferences.gpuScreenCapture}
              onCheckedChange={(checked) => void savePreferences({ gpuScreenCapture: checked })}
              aria-label="GPU screen processing"
            />
          </div>
        </div>

        <div className="rounded-lg border border-primary/25 bg-primary/5 p-3.5">
          <div className="flex items-center gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
              <Sparkles className="size-4" aria-hidden />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">Smart Zoom</span>
                <span className="rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                  {preferences.smartZoomEnabled ? "Ready" : "Off"}
                </span>
              </div>
              <p className="mt-0.5 truncate text-xs text-subtle-foreground">
                {preferences.smartZoomEnabled
                  ? `${preferences.smartZoomPreset} focus ranges will be added to the editor.`
                  : "Enable it in Settings → Recording Defaults."}
              </p>
            </div>
          </div>
        </div>

        {/* Keystroke overlay (Pro): captures modifier combos only —
            plain typing is never logged. */}
        <div className="rounded-lg border border-border bg-surface-dim p-3.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
                <Keyboard className="size-4" aria-hidden />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">Keystroke Overlay</span>
                  {!isPro ? <ProBadge /> : null}
                </div>
                <p className="mt-0.5 truncate text-xs text-subtle-foreground">
                  {!keystrokesSupported
                    ? "Keystroke capture is available on Windows and macOS only."
                    : preferences.captureKeystrokes
                      ? "Shortcuts like Ctrl+C will appear as on-screen badges."
                      : "Show shortcut badges in the exported video."}
                </p>
              </div>
            </div>
            <Switch
              checked={keystrokesSupported && preferences.captureKeystrokes}
              disabled={!keystrokesSupported}
              aria-label="Capture keystroke overlay"
              onCheckedChange={(checked) => {
                if (checked && !isPro) {
                  openUpgradeDialog(["keystroke-overlay"])
                  return
                }
                savePreferences({ captureKeystrokes: checked })
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
