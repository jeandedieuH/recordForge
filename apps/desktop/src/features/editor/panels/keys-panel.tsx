import type {
  KeystrokeModifierStyle,
  KeystrokeOverlaySettings,
  KeystrokePosition,
  KeystrokeTheme,
} from "@recordforge/contracts"
import { defaultKeystrokeOverlaySettings } from "@recordforge/contracts"
import { Keyboard } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Slider,
  Switch,
} from "@recordforge/ui"
import { ProBadge } from "../../licensing/pro-badge"
import { useLicenseStore } from "../../../stores/license-store"
import { useTimelineStore } from "../../../stores/timeline-store"
import { KeystrokeSample } from "../keystrokes/keystroke-sample"

const POSITIONS: { value: KeystrokePosition; label: string }[] = [
  { value: "bottom-center", label: "Bottom center" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "bottom-right", label: "Bottom right" },
  { value: "top-center", label: "Top center" },
  { value: "top-left", label: "Top left" },
  { value: "top-right", label: "Top right" },
]

const THEMES: { value: KeystrokeTheme; label: string }[] = [
  { value: "dark", label: "Dark glass" },
  { value: "light", label: "Light" },
  { value: "contrast", label: "High contrast" },
]

const MODIFIER_STYLES: { value: KeystrokeModifierStyle; label: string }[] = [
  { value: "symbols", label: "Symbols (⌘ ⇧ ⊞)" },
  { value: "text", label: "Names (Cmd, Shift)" },
]

/**
 * Keys panel — configures the keystroke badge overlay shared by the editor
 * preview and the export renderer. Settings live on
 * `project.exportSettings.keystrokeOverlay`, so the export card and this
 * panel stay in sync automatically.
 */
export function KeysPanel() {
  const settings =
    useTimelineStore((state) => state.project?.exportSettings.keystrokeOverlay) ??
    defaultKeystrokeOverlaySettings
  const setKeystrokeOverlay = useTimelineStore((state) => state.setKeystrokeOverlay)
  const keystrokeData = useTimelineStore((state) => state.keystrokeData)
  const keystrokeStatus = useTimelineStore((state) => state.keystrokeStatus)
  const isPro = useLicenseStore((state) => state.status.tier === "pro")
  const openUpgradeDialog = useLicenseStore((state) => state.openUpgradeDialog)

  const platform = keystrokeData?.platform ?? "unknown"
  const comboCount = keystrokeData?.events.length ?? 0

  function patch(update: Partial<KeystrokeOverlaySettings>) {
    setKeystrokeOverlay(update)
  }

  function handleToggle(enabled: boolean) {
    if (enabled && !isPro) {
      openUpgradeDialog(["keystroke-overlay"])
      return
    }
    patch({ enabled })
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <div className="flex items-center justify-between gap-2 border-b border-border pb-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Keyboard className="size-4 text-primary" aria-hidden />
          <h2>Keys</h2>
          {!isPro ? <ProBadge /> : null}
        </div>
        <Switch
          checked={settings.enabled}
          aria-label="Keystroke badges"
          onCheckedChange={handleToggle}
        />
      </div>

      <p className="text-[11px] leading-relaxed text-subtle-foreground">
        Show modifier combinations (Ctrl+C, Alt+Tab…) as keycap badges while recording. Plain typing
        is never captured or displayed.
      </p>

      {/* Capture status — four-states: loading skeleton → count | none. */}
      {keystrokeStatus === "loading" ? (
        <div className="h-9 animate-pulse rounded-md border border-border bg-surface-dim" />
      ) : comboCount > 0 ? (
        <div className="flex items-center justify-between rounded-md border border-border bg-surface-dim px-3 py-2 text-[11px]">
          <span className="text-foreground">{comboCount} shortcut presses captured</span>
          <span className="text-subtle-foreground">{platformLabel(platform)}</span>
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border bg-surface-dim p-3 text-[11px] leading-relaxed text-subtle-foreground">
          No shortcut presses were captured with this recording. Enable “capture keystrokes” in the
          recorder to light up the overlay.
        </div>
      )}

      {/* Live badge sample — driven by the same display model as preview and
          export, so control tweaks render exactly what ships. */}
      <KeystrokeSample settings={settings} platform={platform} />

      <div className="flex flex-col gap-3 text-xs text-subtle-foreground">
        <label className="flex flex-col gap-1.5">
          <span className="text-foreground">Position</span>
          <Select
            value={settings.position}
            onValueChange={(position) => patch({ position: position as KeystrokePosition })}
          >
            <SelectTrigger className="h-8 w-full" aria-label="Badge position">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {POSITIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-foreground">Theme</span>
            <Select
              value={settings.theme}
              onValueChange={(theme) => patch({ theme: theme as KeystrokeTheme })}
            >
              <SelectTrigger className="h-8 w-full" aria-label="Badge theme">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {THEMES.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-foreground">Modifiers</span>
            <Select
              value={settings.modifierStyle}
              onValueChange={(modifierStyle) =>
                patch({ modifierStyle: modifierStyle as KeystrokeModifierStyle })
              }
            >
              <SelectTrigger className="h-8 w-full" aria-label="Modifier glyph style">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODIFIER_STYLES.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="flex justify-between text-foreground">
            <span>Size</span>
            <span className="text-subtle-foreground">{Math.round(settings.scale * 100)}%</span>
          </span>
          <Slider
            value={[settings.scale * 100]}
            onValueChange={([scale]) => patch({ scale: scale / 100 })}
            min={50}
            max={200}
            step={5}
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="flex justify-between text-foreground">
              <span>Stack</span>
              <span className="text-subtle-foreground">{settings.maxStack}</span>
            </span>
            <Slider
              value={[settings.maxStack]}
              onValueChange={([maxStack]) => patch({ maxStack })}
              min={1}
              max={5}
              step={1}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="flex justify-between text-foreground">
              <span>Hold</span>
              <span className="text-subtle-foreground">{(settings.holdMs / 1000).toFixed(1)}s</span>
            </span>
            <Slider
              value={[settings.holdMs]}
              onValueChange={([holdMs]) => patch({ holdMs })}
              min={800}
              max={5000}
              step={100}
            />
          </label>
        </div>
      </div>
    </div>
  )
}

function platformLabel(platform: string): string {
  switch (platform) {
    case "windows":
      return "Windows"
    case "macos":
      return "macOS"
    case "linux":
      return "Linux"
    default:
      return "Recorded"
  }
}
