import { useEffect, useState } from "react"
import { getVersion } from "@tauri-apps/api/app"
import {
  Cpu,
  Folder,
  HardDrive,
  Info,
  Moon,
  Monitor,
  MousePointer2,
  Sliders,
  Sparkles,
  Sun,
  Video,
  Volume2,
} from "lucide-react"
import type {
  CursorSettings,
  RecordingConfig,
  RecordingSmartZoomPreset,
} from "@recordforge/contracts"
import { cursorSettingsSchema, defaultCursorSettings } from "@recordforge/contracts"
import {
  Button,
  Input,
  NumberInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from "@recordforge/ui"
import { open } from "@tauri-apps/plugin-dialog"
import { join, videoDir } from "@tauri-apps/api/path"
import { useThemeStore } from "../../stores/theme-store"
import { useRecorderStore } from "../../hooks/use-recorder"
import { getSetting, isTauri, setSetting } from "../../lib/settings"
import { playExportChime } from "../../lib/export-notifications"
import { DiagnosticsPanel } from "./diagnostics-panel"
import { CursorInspector } from "../editor/cursor"
import { StorageSettings } from "./storage-settings"
import { SmartZoomSettings } from "./smart-zoom-settings"
import { AboutView } from "../about"

export type SettingsTab = "general" | "quality" | "cursor" | "diagnostics" | "storage" | "about"

export interface SettingsViewProps {
  onNavigateToAbout?: () => void
  onReplayOnboarding?: () => void
  onPrepareForUpdate?: () => Promise<void>
}

export function SettingsView({
  onNavigateToAbout,
  onReplayOnboarding,
  onPrepareForUpdate,
}: SettingsViewProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("general")
  const { theme, setTheme, micaEnabled, setMicaEnabled, micaActive } = useThemeStore()
  const {
    selectedProfileId,
    setSelectedProfileId,
    preferences,
    preferencesLoaded,
    loadPreferences,
    savePreferences,
  } = useRecorderStore()

  const [savePath, setSavePath] = useState("")
  const [countdownSec, setCountdownSec] = useState("3")
  const [minimizeToTray, setMinimizeToTray] = useState(false)
  const [notifyOnExport, setNotifyOnExport] = useState(true)
  const [soundOnExport, setSoundOnExport] = useState(true)
  const [cursorSettings, setCursorSettings] = useState<CursorSettings>(defaultCursorSettings)
  const [appVersion, setAppVersion] = useState("development")

  useEffect(() => {
    if (!isTauri()) return
    void getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion("unknown"))
  }, [])

  useEffect(() => {
    void loadPreferences()
  }, [loadPreferences])

  useEffect(() => {
    async function load() {
      let countdown: string | null = null
      let minimized: string | null = null
      let cursorRaw: string | null = null
      let folder: string | null = null

      if (isTauri()) {
        const results = await Promise.all([
          getSetting("countdownSeconds").catch(() => null),
          getSetting("minimizeToTray").catch(() => null),
          getSetting("startMinimized").catch(() => null),
          getSetting("defaultCursorSettings").catch(() => null),
          getSetting("defaultOutputFolder").catch(() => null),
          getSetting("notifyOnExportComplete").catch(() => null),
          getSetting("soundOnExportComplete").catch(() => null),
        ])
        countdown = results[0]
        minimized = results[1] ?? results[2]
        cursorRaw = results[3]
        folder = results[4]
        if (results[5] !== null) setNotifyOnExport(results[5] === "true")
        if (results[6] !== null) setSoundOnExport(results[6] === "true")

        if (!folder) {
          try {
            const vDir = await videoDir()
            folder = await join(vDir, "recordForge")
          } catch {
            folder = "C:\\recordForge"
          }
        }
      }

      if (!cursorRaw) {
        cursorRaw = localStorage.getItem("recordforge:defaultCursorSettings")
      }

      if (countdown === "0" || countdown === "3" || countdown === "5") {
        setCountdownSec(countdown)
      }
      if (minimized !== null) {
        setMinimizeToTray(minimized === "true")
      }
      if (folder) {
        setSavePath(folder)
      }
      if (cursorRaw) {
        try {
          const parsed = cursorSettingsSchema.safeParse(JSON.parse(cursorRaw))
          if (parsed.success) {
            setCursorSettings(parsed.data)
          }
        } catch {
          // Keep defaults if parsing fails
        }
      }
    }
    void load()
  }, [])

  function handleCountdownChange(value: string) {
    setCountdownSec(value)
    if (isTauri()) void setSetting("countdownSeconds", value)
  }

  function handleSavePathChange(value: string) {
    setSavePath(value)
    if (isTauri()) void setSetting("defaultOutputFolder", value)
  }

  async function handleBrowseOutputFolder() {
    if (!isTauri()) return
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: savePath || undefined,
        title: "Select Default Output Folder",
      })
      if (selected && typeof selected === "string") {
        setSavePath(selected)
        await setSetting("defaultOutputFolder", selected)
      }
    } catch (err) {
      console.warn("Failed to select output folder:", err)
    }
  }

  function handleMinimizeToTrayChange(value: boolean) {
    setMinimizeToTray(value)
    if (isTauri()) {
      void setSetting("minimizeToTray", String(value))
      void setSetting("startMinimized", String(value))
    }
  }

  function handleNotifyOnExportChange(value: boolean) {
    setNotifyOnExport(value)
    if (isTauri()) {
      void setSetting("notifyOnExportComplete", String(value))
    }
  }

  function handleSoundOnExportChange(value: boolean) {
    setSoundOnExport(value)
    if (isTauri()) {
      void setSetting("soundOnExportComplete", String(value))
    }
  }

  function handleCursorChange(updated: Partial<CursorSettings>) {
    const next = { ...cursorSettings, ...updated }
    setCursorSettings(next)
    const json = JSON.stringify(next)
    try {
      localStorage.setItem("recordforge:defaultCursorSettings", json)
    } catch {
      // Ignore localStorage errors
    }
    if (isTauri()) void setSetting("defaultCursorSettings", json)
  }

  function handleCursorReset() {
    setCursorSettings(defaultCursorSettings)
    const json = JSON.stringify(defaultCursorSettings)
    try {
      localStorage.setItem("recordforge:defaultCursorSettings", json)
    } catch {
      // Ignore localStorage errors
    }
    if (isTauri()) void setSetting("defaultCursorSettings", json)
  }

  function handleSmartZoomEnabledChange(enabled: boolean) {
    void savePreferences({ smartZoomEnabled: enabled })
  }

  function handleSmartZoomPresetChange(preset: RecordingSmartZoomPreset) {
    void savePreferences({ smartZoomPreset: preset })
  }

  function handleCameraSyncOffsetChange(offsetMs: number) {
    const clamped = Math.max(-2000, Math.min(5000, Math.round(offsetMs)))
    void savePreferences({ cameraSyncOffsetMs: clamped })
  }

  return (
    <div className="flex flex-col gap-6 p-6 max-w-6xl mx-auto w-full">
      {/* Header & Subtitle */}
      <div>
        <h2 className="font-serif text-2xl font-bold tracking-tight text-foreground">
          Settings & Preferences
        </h2>
        <p className="text-xs text-subtle-foreground mt-1">
          Customize recording defaults, appearance, hardware acceleration, and local storage.
        </p>
      </div>

      {/* Tab Pill Navigation */}
      <div className="flex items-center gap-1.5 border-b border-border pb-3 overflow-x-auto">
        <button
          type="button"
          onClick={() => setActiveTab("general")}
          className={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-all ${
            activeTab === "general"
              ? "bg-primary text-white shadow-sm"
              : "text-subtle-foreground hover:bg-surface hover:text-foreground"
          }`}
        >
          <Sparkles className="size-4" />
          <span>General & Appearance</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("quality")}
          className={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-all ${
            activeTab === "quality"
              ? "bg-primary text-white shadow-sm"
              : "text-subtle-foreground hover:bg-surface hover:text-foreground"
          }`}
        >
          <Sliders className="size-4" />
          <span>Recording Defaults</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("cursor")}
          className={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-all ${
            activeTab === "cursor"
              ? "bg-primary text-white shadow-sm"
              : "text-subtle-foreground hover:bg-surface hover:text-foreground"
          }`}
        >
          <MousePointer2 className="size-4" />
          <span>Custom Cursor</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("diagnostics")}
          className={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-all ${
            activeTab === "diagnostics"
              ? "bg-primary text-white shadow-sm"
              : "text-subtle-foreground hover:bg-surface hover:text-foreground"
          }`}
        >
          <Cpu className="size-4" />
          <span>Hardware & Diagnostics</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("storage")}
          className={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-all ${
            activeTab === "storage"
              ? "bg-primary text-white shadow-sm"
              : "text-subtle-foreground hover:bg-surface hover:text-foreground"
          }`}
        >
          <HardDrive className="size-4" />
          <span>Storage & Cloud</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("about")}
          className={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-all ${
            activeTab === "about"
              ? "bg-primary text-white shadow-sm"
              : "text-subtle-foreground hover:bg-surface hover:text-foreground"
          }`}
        >
          <Info className="size-4" />
          <span>About & Studio</span>
        </button>
      </div>

      {/* Tab 1: General & Appearance */}
      {activeTab === "general" ? (
        <div className="space-y-6">
          {/* Theme Selection Cards */}
          <div className="rounded-2xl border border-border bg-surface p-5 space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Theme Preference</h3>
              <p className="text-xs text-subtle-foreground mt-0.5">
                Select your preferred visual style for RecordForge.
              </p>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <button
                type="button"
                onClick={() => void setTheme("dark")}
                className={`flex flex-col items-center gap-2.5 rounded-xl border p-4 transition-all ${
                  theme === "dark"
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border bg-surface-dim text-subtle-foreground hover:border-border-strong"
                }`}
              >
                <Moon className="size-6 text-primary" />
                <span className="text-xs font-semibold">Dark Mode</span>
              </button>

              <button
                type="button"
                onClick={() => void setTheme("light")}
                className={`flex flex-col items-center gap-2.5 rounded-xl border p-4 transition-all ${
                  theme === "light"
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border bg-surface-dim text-subtle-foreground hover:border-border-strong"
                }`}
              >
                <Sun className="size-6 text-amber-400" />
                <span className="text-xs font-semibold">Light Mode</span>
              </button>

              <button
                type="button"
                onClick={() => void setTheme("system")}
                className={`flex flex-col items-center gap-2.5 rounded-xl border p-4 transition-all ${
                  theme === "system"
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border bg-surface-dim text-subtle-foreground hover:border-border-strong"
                }`}
              >
                <Monitor className="size-6 text-sky-400" />
                <span className="text-xs font-semibold">System Auto</span>
              </button>
            </div>
          </div>

          {/* Translucent Glass & Acrylic Backdrop */}
          <div className="rounded-2xl border border-border bg-surface p-5 flex items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-foreground">
                  Translucent Glass & Acrylic Backdrop
                </h3>
                <span className="rounded bg-primary/15 px-2 py-0.5 text-[10px] font-mono font-medium text-primary">
                  {micaActive ? "Active" : "Opaque Fallback"}
                </span>
              </div>
              <p className="text-xs text-subtle-foreground mt-0.5">
                Enable OS translucent backdrop material (Mica on Windows, Vibrancy on macOS) behind
                the window titlebar and panels.
              </p>
            </div>

            <Switch
              checked={micaEnabled}
              onCheckedChange={(checked) => void setMicaEnabled(checked)}
            />
          </div>

          {/* Output Folder Location */}
          <div className="rounded-2xl border border-border bg-surface p-5 space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Default Output Folder</h3>
              <p className="text-xs text-subtle-foreground mt-0.5">
                Recorded video sessions will be saved locally to this folder.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Input
                value={savePath}
                onChange={(e) => handleSavePathChange(e.target.value)}
                placeholder="Select or enter output folder..."
                className="flex-1 font-mono text-xs"
              />
              <Button
                variant="secondary"
                onClick={() => void handleBrowseOutputFolder()}
                className="h-9 px-4 text-xs cursor-pointer"
              >
                <Folder className="mr-1.5 size-3.5" /> Browse
              </Button>
            </div>
          </div>

          {/* Behavior Toggles */}
          <div className="rounded-2xl border border-border bg-surface p-5 space-y-4">
            <h3 className="text-sm font-semibold text-foreground">Application Behavior</h3>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-foreground">Minimize to System Tray</p>
                <p className="text-[11px] text-subtle-foreground">
                  Keep RecordForge running in the notification area when window is closed.
                </p>
              </div>
              <Switch checked={minimizeToTray} onCheckedChange={handleMinimizeToTrayChange} />
            </div>
          </div>

          {/* Export Alerts & Notifications Card */}
          <div className="rounded-2xl border border-border bg-surface p-5 space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Export Completion Alerts</h3>
              <p className="text-xs text-subtle-foreground mt-0.5">
                Configure system notifications and audio alerts when an export finishes in the
                background.
              </p>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-foreground">System Desktop Notifications</p>
                <p className="text-[11px] text-subtle-foreground">
                  Show an OS desktop notification when a lengthy export finishes while minimized or
                  in the background.
                </p>
              </div>
              <Switch checked={notifyOnExport} onCheckedChange={handleNotifyOnExportChange} />
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-foreground">Audio Completion Chime</p>
                <p className="text-[11px] text-subtle-foreground">
                  Play a soft harmonic audio chime when rendering completes.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => playExportChime()}
                  className="h-7 px-2.5 text-xs gap-1.5 cursor-pointer text-muted-foreground hover:text-foreground"
                  title="Preview completion chime"
                >
                  <Volume2 className="size-3.5 text-accent" />
                  Test Sound
                </Button>
                <Switch checked={soundOnExport} onCheckedChange={handleSoundOnExportChange} />
              </div>
            </div>
          </div>

          {/* Welcome & Onboarding Tour Card */}
          <div className="rounded-2xl border border-border bg-surface p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-foreground">
                    Welcome & Onboarding Tour
                  </h3>
                  <span className="rounded bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent">
                    Interactive Walkthrough
                  </span>
                </div>
                <p className="text-xs text-subtle-foreground mt-0.5">
                  Replay the 5-step onboarding guide to review hardware tuning, audio setup, and
                  cursor telemetry effects.
                </p>
              </div>
              {onReplayOnboarding && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onReplayOnboarding}
                  className="h-8 px-3 text-xs cursor-pointer gap-1.5"
                >
                  <Sparkles className="size-3.5 text-accent" /> Replay Tour
                </Button>
              )}
            </div>
          </div>

          {/* About & Developer Summary Card */}
          <div className="rounded-2xl border border-border bg-surface p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-foreground">About RecordForge</h3>
                  <span className="rounded bg-primary/15 px-2 py-0.5 text-[10px] font-mono font-medium text-primary">
                    v{appVersion} GNU GPLv3
                  </span>
                </div>
                <p className="text-xs text-subtle-foreground mt-0.5">
                  Free and open-source screen recorder developed by Prestige Tech &amp; recordForge
                  contributors.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (onNavigateToAbout) onNavigateToAbout()
                  else setActiveTab("about")
                }}
                className="h-8 px-3 text-xs cursor-pointer"
              >
                <Info className="mr-1.5 size-3.5 text-primary" /> View Details
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Tab 2: Recording Defaults */}
      {activeTab === "quality" ? (
        <div className="space-y-6">
          {/* Preset Profile Selection */}
          <div className="rounded-2xl border border-border bg-surface p-5 space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Default Quality Profile</h3>
              <p className="text-xs text-subtle-foreground mt-0.5">
                Choose the default encoding quality preset for screen captures.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {[
                {
                  id: "low-impact",
                  name: "Low Impact",
                  desc: "Best for battery & low-spec PCs. 720p @ 30fps",
                },
                {
                  id: "balanced",
                  name: "Balanced",
                  desc: "Recommended quality & size. 1080p @ 30fps",
                },
                {
                  id: "smooth-60fps",
                  name: "Smooth 60 FPS",
                  desc: "Fluid motion for UI & gaming. 1080p @ 60fps",
                },
                {
                  id: "ultra-4k",
                  name: "Ultra 4K",
                  desc: "Crisp presentation for high-DPI. 4K @ 30fps",
                },
                {
                  id: "ultra-4k-60",
                  name: "Ultra 4K 60 FPS",
                  desc: "Ultimate fidelity for powerful PCs. 4K @ 60fps",
                },
                {
                  id: "high-quality",
                  name: "Maximum Quality",
                  desc: "High bitrate master capture. 1080p @ 30fps",
                },
              ].map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedProfileId(p.id as RecordingConfig["profile"])}
                  className={`flex flex-col items-start gap-1.5 rounded-xl border p-4 text-left transition-all ${
                    selectedProfileId === p.id
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-surface-dim text-subtle-foreground hover:border-border-strong"
                  }`}
                >
                  <span className="text-xs font-semibold text-foreground">{p.name}</span>
                  <span className="text-[11px] text-subtle-foreground leading-snug">{p.desc}</span>
                </button>
              ))}
            </div>
          </div>

          <SmartZoomSettings
            enabled={preferences.smartZoomEnabled}
            preset={preferences.smartZoomPreset}
            disabled={!preferencesLoaded}
            onEnabledChange={handleSmartZoomEnabledChange}
            onPresetChange={handleSmartZoomPresetChange}
          />

          {/* Countdown & Audio Options */}
          <div className="rounded-2xl border border-border bg-surface p-5 space-y-4">
            <h3 className="text-sm font-semibold text-foreground">Recording Countdown & Audio</h3>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-subtle-foreground mb-1.5">
                  Countdown Delay Before Start
                </label>
                <Select value={countdownSec} onValueChange={handleCountdownChange}>
                  <SelectTrigger className="w-full rounded-lg border border-border bg-surface-dim px-3 py-2 text-xs text-foreground">
                    <SelectValue placeholder="Select delay" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">No delay (Immediate start)</SelectItem>
                    <SelectItem value="3">3 Seconds countdown</SelectItem>
                    <SelectItem value="5">5 Seconds countdown</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="block text-xs font-medium text-subtle-foreground mb-1.5">
                  Audio Sync Mode
                </label>
                <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-dim px-3 py-2 text-xs text-foreground">
                  <Volume2 className="size-4 text-sky-400" />
                  <span>Hardware Timestamp Synchronized</span>
                </div>
              </div>
            </div>
          </div>

          {/* Camera Lip-Sync & Audio Alignment */}
          <div className="rounded-2xl border border-border bg-surface p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <Video className="size-4 text-primary" />
                  <h3 className="text-sm font-semibold text-foreground">Camera Lip-Sync Offset</h3>
                </div>
                <p className="text-xs text-subtle-foreground mt-0.5">
                  Calibrate the timing offset between camera video and microphone audio for new
                  recordings.
                </p>
              </div>
              <span className="rounded bg-primary/10 px-2.5 py-1 text-xs font-mono font-semibold text-primary">
                {preferences.cameraSyncOffsetMs > 0
                  ? `+${preferences.cameraSyncOffsetMs}`
                  : preferences.cameraSyncOffsetMs}{" "}
                ms
              </span>
            </div>

            <p className="text-[11px] leading-relaxed text-subtle-foreground">
              If mouth movement appears before voice is heard, set a positive offset (e.g. +150ms to
              +300ms) to delay the camera video. If voice is heard before mouth movement, set a
              negative offset.
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <NumberInput
                step={25}
                min={-2000}
                max={5000}
                unit="ms"
                size="sm"
                value={preferences.cameraSyncOffsetMs}
                onChange={(val) => handleCameraSyncOffsetChange(val)}
                className="w-32"
              />

              <div className="flex items-center gap-1.5">
                {[0, 150, 250, 350].map((presetMs) => (
                  <button
                    key={presetMs}
                    type="button"
                    onClick={() => handleCameraSyncOffsetChange(presetMs)}
                    className={`rounded-lg px-2.5 py-1 text-xs font-mono transition-all ${
                      preferences.cameraSyncOffsetMs === presetMs
                        ? "bg-primary text-white shadow-xs"
                        : "border border-border bg-surface-dim text-subtle-foreground hover:bg-surface hover:text-foreground"
                    }`}
                  >
                    {presetMs === 0 ? "0 ms (Default)" : `+${presetMs} ms`}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Tab: Custom Cursor */}
      {activeTab === "cursor" ? (
        <div className="max-w-2xl rounded-2xl border border-border bg-surface p-6 shadow-e1">
          <CursorInspector
            settings={cursorSettings}
            onChange={handleCursorChange}
            onReset={handleCursorReset}
            presetsEnabled={true}
          />
        </div>
      ) : null}

      {/* Tab 3: Hardware & Diagnostics */}
      {activeTab === "diagnostics" ? <DiagnosticsPanel /> : null}

      {/* Tab 4: Storage & Cloud */}
      {activeTab === "storage" ? <StorageSettings /> : null}

      {/* Tab 5: About & Studio */}
      {activeTab === "about" ? (
        <AboutView
          onNavigateToDiagnostics={() => setActiveTab("diagnostics")}
          onPrepareForUpdate={onPrepareForUpdate}
          onReplayOnboarding={onReplayOnboarding}
        />
      ) : null}
    </div>
  )
}
