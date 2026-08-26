import { useEffect, useState } from "react"
import { getVersion } from "@tauri-apps/api/app"
import { Moon, ShieldCheck, Sparkles, Sun, Wand2, Zap } from "lucide-react"
import { Badge, Button, Switch } from "@recordforge/ui"
import { isTauri } from "../../../lib/settings"
import { useThemeStore } from "../../../stores/theme-store"

export function WelcomeStep() {
  const { theme, setTheme, micaEnabled, setMicaEnabled } = useThemeStore()
  const [appVersion, setAppVersion] = useState("development")

  useEffect(() => {
    if (!isTauri()) return
    void getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion("unknown"))
  }, [])

  return (
    <div className="flex flex-col gap-6 text-foreground">
      {/* Hero Branding Section */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-linear-to-br from-surface via-surface to-surface-dim p-6 sm:p-7 shadow-e2">
        <div className="absolute top-0 right-0 -mr-12 -mt-12 size-48 rounded-full bg-primary/15 blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 left-1/4 -mb-12 size-40 rounded-full bg-secondary/15 blur-2xl pointer-events-none" />

        <div className="relative flex flex-col sm:flex-row items-center sm:items-start gap-5 text-center sm:text-left">
          <div className="relative flex size-18 shrink-0 items-center justify-center rounded-2xl border border-border-strong bg-surface-dim shadow-e2 group">
            <img
              src="/icon.svg"
              alt="RecordForge Logo"
              className="size-11 object-contain select-none transition-transform duration-base ease-forge group-hover:scale-105"
            />
            <span className="absolute -bottom-1 -right-1 flex size-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-white shadow-sm ring-2 ring-surface">
              1
            </span>
          </div>

          <div className="space-y-1.5 flex-1">
            <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2">
              <h1 className="font-serif text-2xl sm:text-3xl font-bold tracking-tight text-foreground">
                Welcome to RecordForge
              </h1>
              <Badge variant="accent" className="text-xs px-2.5 py-0.5 font-mono">
                v{appVersion}
              </Badge>
              <Badge variant="outline" className="text-xs px-2 py-0.5 text-subtle-foreground">
                Desktop Native
              </Badge>
            </div>
            <p className="text-sm text-subtle-foreground max-w-xl leading-relaxed">
              Studio-grade, local-first screen recorder and proxy timeline editor engineered for
              zero audio-video drift, hardware-accelerated encoding, and pristine captures.
            </p>
          </div>
        </div>
      </div>

      {/* 3 Core Value Pillars */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
        <div className="flex flex-col gap-2 rounded-xl border border-border/80 bg-surface/60 p-4 transition-colors duration-fast hover:border-primary/40 hover:bg-surface">
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Zap className="size-4" />
            </div>
            <span className="text-sm font-semibold text-foreground">Hardware Accelerated</span>
          </div>
          <p className="text-xs text-subtle-foreground leading-relaxed">
            Low-latency audio sync, low-impact CPU profiles, and GPU-accelerated
            NVENC/QSV/VAAPI/VideoToolbox pipelines.
          </p>
        </div>

        <div className="flex flex-col gap-2 rounded-xl border border-border/80 bg-surface/60 p-4 transition-colors duration-fast hover:border-primary/40 hover:bg-surface">
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <ShieldCheck className="size-4" />
            </div>
            <span className="text-sm font-semibold text-foreground">100% Local & Private</span>
          </div>
          <p className="text-xs text-subtle-foreground leading-relaxed">
            Your media never touches the cloud without explicit export. Includes automatic crash
            recovery.
          </p>
        </div>

        <div className="flex flex-col gap-2 rounded-xl border border-border/80 bg-surface/60 p-4 transition-colors duration-fast hover:border-primary/40 hover:bg-surface">
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 items-center justify-center rounded-lg bg-secondary/10 text-secondary">
              <Wand2 className="size-4" />
            </div>
            <span className="text-sm font-semibold text-foreground">Proxy Timeline Editor</span>
          </div>
          <p className="text-xs text-subtle-foreground leading-relaxed">
            Trim, split, zoom, and annotate immediately after recording without heavy re-encoding
            delays.
          </p>
        </div>
      </div>

      {/* Visual Preference Configuration */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-xl border border-border bg-surface-dim/70 p-4.5">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Sparkles className="size-4 text-primary" />
            <span>Interface Style & Materials</span>
          </div>
          <p className="text-xs text-subtle-foreground">
            Choose your preferred color theme and translucent backdrop material.
          </p>
        </div>

        <div className="flex items-center gap-3 self-end sm:self-center">
          {/* Theme Switcher */}
          <div className="flex items-center rounded-lg border border-border bg-surface p-1">
            <Button
              variant={theme === "dark" ? "primary" : "ghost"}
              size="sm"
              className="h-7 px-2.5 text-xs gap-1.5"
              onClick={() => void setTheme("dark")}
            >
              <Moon className="size-3.5" />
              Dark
            </Button>
            <Button
              variant={theme === "light" ? "primary" : "ghost"}
              size="sm"
              className="h-7 px-2.5 text-xs gap-1.5"
              onClick={() => void setTheme("light")}
            >
              <Sun className="size-3.5" />
              Light
            </Button>
            <Button
              variant={theme === "system" ? "primary" : "ghost"}
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => void setTheme("system")}
            >
              System
            </Button>
          </div>

          {/* Mica / Acrylic Toggle */}
          <div className="flex items-center gap-2 pl-2 border-l border-border">
            <span className="text-xs text-subtle-foreground select-none">Mica / Glass</span>
            <Switch
              checked={micaEnabled}
              onCheckedChange={(checked) => void setMicaEnabled(checked)}
              aria-label="Toggle window transparency and backdrop material"
            />
          </div>
        </div>
      </div>
    </div>
  )
}
