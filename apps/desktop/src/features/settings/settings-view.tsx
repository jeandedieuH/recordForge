import { useEffect, useState } from "react"
import {
  Cloud,
  Cpu,
  Folder,
  HardDrive,
  Moon,
  Monitor,
  Sliders,
  Sparkles,
  Sun,
  Volume2,
} from "lucide-react"
import type { RecordingConfig } from "@recordforge/contracts"
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from "@recordforge/ui"
import { useThemeStore } from "../../stores/theme-store"
import { useRecorderStore } from "../../hooks/use-recorder"
import { getSetting, isTauri, setSetting } from "../../lib/settings"
import { DiagnosticsPanel } from "./diagnostics-panel"

type SettingsTab = "general" | "quality" | "diagnostics" | "storage"

export function SettingsView() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("general")
  const { theme, setTheme, micaEnabled, setMicaEnabled, micaActive } = useThemeStore()
  const { selectedProfileId, setSelectedProfileId } = useRecorderStore()

  const [savePath, setSavePath] = useState("C:\\Users\\User\\Videos\\recordForge")
  const [countdownSec, setCountdownSec] = useState("3")
  const [startMinimized, setStartMinimized] = useState(false)

  useEffect(() => {
    if (!isTauri()) return
    void Promise.all([getSetting("countdownSeconds"), getSetting("startMinimized")]).then(
      ([countdown, minimized]) => {
        if (countdown === "0" || countdown === "3" || countdown === "5") {
          setCountdownSec(countdown)
        }
        setStartMinimized(minimized === "true")
      },
    )
  }, [])

  function handleCountdownChange(value: string) {
    setCountdownSec(value)
    if (isTauri()) void setSetting("countdownSeconds", value)
  }

  function handleStartMinimizedChange(value: boolean) {
    setStartMinimized(value)
    if (isTauri()) void setSetting("startMinimized", String(value))
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
      </div>

      {/* Tab 1: General & Appearance */}
      {activeTab === "general" ? (
        <div className="space-y-6">
          {/* Theme Selection Cards */}
          <div className="rounded-2xl border border-border bg-surface p-5 space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Theme Preference</h3>
              <p className="text-xs text-subtle-foreground mt-0.5">
                Select your preferred visual style for recordForge.
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

          {/* Windows Mica Glass Transparency */}
          <div className="rounded-2xl border border-border bg-surface p-5 flex items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-foreground">
                  Windows Mica Glass Backdrop
                </h3>
                <span className="rounded bg-primary/15 px-2 py-0.5 text-[10px] font-mono font-medium text-primary">
                  {micaActive ? "Active" : "Opaque Fallback"}
                </span>
              </div>
              <p className="text-xs text-subtle-foreground mt-0.5">
                Enable Windows 11 translucent backdrop material behind the window titlebar and
                canvas.
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
                onChange={(e) => setSavePath(e.target.value)}
                className="flex-1 font-mono text-xs"
              />
              <Button variant="secondary" className="h-9 px-4 text-xs">
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
                  Keep recordForge running in the notification area when window is closed.
                </p>
              </div>
              <Switch checked={startMinimized} onCheckedChange={handleStartMinimizedChange} />
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

            <div className="grid grid-cols-3 gap-3">
              {[
                {
                  id: "low-impact",
                  name: "Low Impact",
                  desc: "Best for gaming & low-spec PCs. 720p @ 30fps",
                },
                {
                  id: "balanced",
                  name: "Balanced",
                  desc: "Optimal balance of quality & filesize. 1080p @ 30fps",
                },
                {
                  id: "high-quality",
                  name: "Maximum Quality",
                  desc: "Higher quality capture for editing. 1080p @ 30fps",
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
        </div>
      ) : null}

      {/* Tab 3: Hardware & Diagnostics */}
      {activeTab === "diagnostics" ? <DiagnosticsPanel /> : null}

      {/* Tab 4: Storage & Cloud */}
      {activeTab === "storage" ? (
        <div className="space-y-6">
          {/* Disk Usage Overview */}
          <div className="rounded-2xl border border-border bg-surface p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Local Storage Quota</h3>
                <p className="text-xs text-subtle-foreground mt-0.5">
                  Available storage on current output drive (C:)
                </p>
              </div>
              <span className="font-mono text-xs font-semibold text-foreground">
                14.2 GB / 480 GB Used
              </span>
            </div>

            <div className="h-2.5 w-full overflow-hidden rounded-full bg-surface-dim border border-border">
              <div className="h-full w-[12%] rounded-full bg-primary" />
            </div>
          </div>

          {/* Cloud Integration Cards */}
          <div className="rounded-2xl border border-border bg-surface p-5 space-y-4">
            <h3 className="text-sm font-semibold text-foreground">Cloud Storage Integrations</h3>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex items-center justify-between rounded-xl border border-border bg-surface-dim p-4">
                <div className="flex items-center gap-3">
                  <Cloud className="size-5 text-amber-400" />
                  <div>
                    <p className="text-xs font-semibold text-foreground">Amazon S3 Storage</p>
                    <p className="text-[10px] text-subtle-foreground">Not connected</p>
                  </div>
                </div>
                <Button variant="outline" size="sm" className="h-7 text-[11px] px-3">
                  Connect
                </Button>
              </div>

              <div className="flex items-center justify-between rounded-xl border border-border bg-surface-dim p-4">
                <div className="flex items-center gap-3">
                  <Cloud className="size-5 text-sky-400" />
                  <div>
                    <p className="text-xs font-semibold text-foreground">Google Drive</p>
                    <p className="text-[10px] text-subtle-foreground">Not connected</p>
                  </div>
                </div>
                <Button variant="outline" size="sm" className="h-7 text-[11px] px-3">
                  Connect
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
