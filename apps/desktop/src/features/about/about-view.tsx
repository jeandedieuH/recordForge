import { useState } from "react"
import {
  AppWindow,
  CheckCircle2,
  Code2,
  Copy,
  Cpu,
  ExternalLink,
  Flame,
  Globe,
  Info,
  Layers,
  Lock,
  Radio,
  ShieldCheck,
  Sparkles,
  Video,
  Wand2,
  Zap,
} from "lucide-react"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  useToast,
} from "@recordforge/ui"
import { openUrl } from "@tauri-apps/plugin-opener"
import { isTauri } from "../../lib/settings"
import { useRecorderStore } from "../../hooks/use-recorder"

export interface AboutViewProps {
  onNavigateToSettings?: () => void
  onNavigateToDiagnostics?: () => void
  onReplayOnboarding?: () => void
}

const PRESTIGE_TECH_URL = "https://prestigetech.dev"
const MASTER_DEV_URL = "https://me.prestigetech.dev"

export function AboutView({ 
  onNavigateToSettings, 
  onNavigateToDiagnostics, 
  onReplayOnboarding,
}: AboutViewProps) {
  const { toast } = useToast()
  const diagnostics = useRecorderStore((state) => state.diagnostics)
  const [isCopying, setIsCopying] = useState(false)

  async function handleOpenUrl(url: string, label: string) {
    try {
      if (isTauri()) {
        await openUrl(url)
      } else {
        window.open(url, "_blank", "noopener,noreferrer")
      }
    } catch {
      window.open(url, "_blank", "noopener,noreferrer")
    }
    toast({
      title: `Opening ${label}`,
      description: url,
    })
  }

  async function handleCopyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text)
      toast({
        title: "Copied to clipboard",
        description: `${label} copied successfully.`,
      })
    } catch (err) {
      toast({
        title: "Copy failed",
        description: String(err),
        variant: "error",
      })
    }
  }

  async function handleCopySystemReport() {
    setIsCopying(true)
    try {
      const cpu = diagnostics?.platform?.cpu ?? "Windows 11 Compatible CPU"
      const os = diagnostics?.platform?.os ?? "Windows 11"
      const report = [
        "RecordForge Desktop System Report",
        "================================",
        "App Version: 1.0.0 (Release)",
        "Licensing: Free Proprietary (Not Open-Source)",
        `Platform: ${os}`,
        `Processor: ${cpu}`,
        "Engine: Rust Native (Tauri v2) + WASAPI Audio + FFmpeg 9.0 + WASM Overlay",
        `Studio: Prestige Tech (${PRESTIGE_TECH_URL})`,
        `Master Developer: (${MASTER_DEV_URL})`,
        `Timestamp: ${new Date().toISOString()}`,
      ].join("\n")

      await navigator.clipboard.writeText(report)
      toast({
        title: "System report copied",
        description: "Diagnostics and build summary copied to clipboard.",
      })
    } catch (err) {
      toast({
        title: "Failed to copy report",
        description: String(err),
        variant: "error",
      })
    } finally {
      setIsCopying(false)
    }
  }

  return (
    <div className="flex flex-col gap-6 p-6 max-w-6xl mx-auto w-full">
      {/* Brand Hero Card */}
      <div className="relative overflow-hidden rounded-3xl border border-border bg-linear-to-br from-surface via-surface to-surface-dim p-6 sm:p-8 shadow-e2">
        <div className="absolute top-0 right-0 -mr-16 -mt-16 size-64 rounded-full bg-primary/10 blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 left-1/3 -mb-16 size-48 rounded-full bg-secondary/10 blur-2xl pointer-events-none" />

        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-4 sm:gap-5">
            <div className="relative flex size-16 shrink-0 items-center justify-center rounded-2xl border border-border-strong bg-surface-dim shadow-e1">
              <img
                src="/icon.svg"
                alt="RecordForge Logo"
                className="size-10 object-contain select-none"
              />
              <span className="absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full bg-primary text-[9px] font-bold text-white shadow-sm">
                1
              </span>
            </div>

            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="font-serif text-2xl sm:text-3xl font-bold tracking-tight text-foreground">
                  RecordForge
                </h1>
                <Badge variant="accent" className="text-xs px-2.5 py-0.5 font-mono">
                  v1.0.0
                </Badge>
                <Badge variant="outline" className="text-xs px-2 py-0.5 text-subtle-foreground">
                  Windows 11 Native
                </Badge>
              </div>
              <p className="text-xs sm:text-sm text-subtle-foreground max-w-2xl leading-relaxed">
                High-performance, local-first screen recorder and proxy timeline editor engineered
                for precision capture, zero audio-video drift, and modern content workflows.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0 pt-2 lg:pt-0">
            {onReplayOnboarding ? (
              <Button
                variant="outline"
                size="sm"
                onClick={onReplayOnboarding}
                className="h-9 px-3.5 text-xs cursor-pointer gap-1.5"
              >
                <Sparkles className="size-3.5 text-accent" />
                Quick Tour
              </Button>
            ) : null}

            <Button
              variant="outline"
              size="sm"
              onClick={handleCopySystemReport}
              disabled={isCopying}
              className="h-9 px-3.5 text-xs cursor-pointer"
            >
              <Copy className="mr-1.5 size-3.5" />
              Copy Build Info
            </Button>

            {onNavigateToSettings ? (
              <Button
                variant="primary"
                size="sm"
                onClick={onNavigateToSettings}
                className="h-9 px-4 text-xs cursor-pointer"
              >
                <Zap className="mr-1.5 size-3.5" />
                Settings
              </Button>
            ) : null}
          </div>
        </div>

        {/* Feature Pill Tags */}
        <div className="mt-6 flex flex-wrap gap-2 pt-4 border-t border-border/60">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border/80 bg-surface-dim/80 px-2.5 py-1 text-[11px] font-medium text-foreground">
            <Lock className="size-3 text-primary" /> Free & Proprietary
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border/80 bg-surface-dim/80 px-2.5 py-1 text-[11px] font-medium text-foreground">
            <ShieldCheck className="size-3 text-emerald-400" /> 100% Local-First
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border/80 bg-surface-dim/80 px-2.5 py-1 text-[11px] font-medium text-foreground">
            <Cpu className="size-3 text-sky-400" /> Hardware Accelerated
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border/80 bg-surface-dim/80 px-2.5 py-1 text-[11px] font-medium text-foreground">
            <Sparkles className="size-3 text-amber-400" /> Smart Zoom Telemetry
          </span>
        </div>
      </div>

      {/* Grid: Licensing & V2 Roadmap */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Licensing & Distribution Notice */}
        <Card className="rounded-2xl border border-border bg-surface shadow-e1">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldCheck className="size-5 text-primary" />
                <CardTitle className="text-base font-semibold text-foreground">
                  Licensing & Distribution
                </CardTitle>
              </div>
              <Badge variant="accent" className="text-[10px] uppercase font-semibold">
                Free Edition
              </Badge>
            </div>
            <CardDescription className="text-xs text-subtle-foreground">
              Software license terms and ownership model.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4 text-xs">
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 space-y-2">
              <div className="flex items-center gap-2 font-semibold text-foreground">
                <Info className="size-4 text-primary shrink-0" />
                <span>Free to Use — Not Open-Source</span>
              </div>
              <p className="text-subtle-foreground leading-relaxed">
                RecordForge is completely free to download, install, and use for personal,
                commercial, and educational screen recordings. The software is proprietary and is{" "}
                <strong className="text-foreground font-semibold">not open-source</strong>. All
                intellectual property, source code, and assets are owned by Prestige Tech.
              </p>
            </div>

            <div className="space-y-2.5">
              <h4 className="font-semibold text-foreground">Usage Rights:</h4>
              <ul className="space-y-2 text-subtle-foreground">
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="size-4 text-emerald-400 shrink-0 mt-0.5" />
                  <span>Unlimited recording duration with zero export watermarks.</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="size-4 text-emerald-400 shrink-0 mt-0.5" />
                  <span>Commercial and professional use permitted at no cost.</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="size-4 text-emerald-400 shrink-0 mt-0.5" />
                  <span>
                    Offline-capable: no mandatory online account or cloud sign-in required.
                  </span>
                </li>
              </ul>
            </div>
          </CardContent>
        </Card>

        {/* Version 2 Roadmap & Premium Tiers */}
        <Card className="rounded-2xl border border-border bg-surface shadow-e1">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Wand2 className="size-5 text-accent" />
                <CardTitle className="text-base font-semibold text-foreground">
                  Version 2 Roadmap & Premium
                </CardTitle>
              </div>
              <Badge variant="warning" className="text-[10px] uppercase font-semibold">
                In Development
              </Badge>
            </div>
            <CardDescription className="text-xs text-subtle-foreground">
              Our transparent monetization and evolution plan.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4 text-xs">
            <p className="text-subtle-foreground leading-relaxed">
              We believe in honest, predictable software. Most of RecordForge will always remain
              free. <strong className="text-foreground font-semibold">Version 2.0</strong> will ship
              with optional paid premium features designed for power creators and teams.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <div className="rounded-xl border border-border bg-surface-dim p-3.5 space-y-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  <CheckCircle2 className="size-3.5 text-emerald-400" />
                  <span>Always Free</span>
                </div>
                <ul className="space-y-1.5 text-[11px] text-subtle-foreground">
                  <li>• Unlimited 4K 60FPS screen capture</li>
                  <li>• WASAPI precision audio mixing</li>
                  <li>• Proxy timeline editor & cuts</li>
                  <li>• Local MP4 hardware export</li>
                  <li>• Vector cursor smoothing</li>
                </ul>
              </div>

              <div className="rounded-xl border border-secondary/30 bg-secondary/5 p-3.5 space-y-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-secondary">
                  <Flame className="size-3.5 text-secondary" />
                  <span>Version 2 Premium</span>
                </div>
                <ul className="space-y-1.5 text-[11px] text-subtle-foreground">
                  <li>• AI smart-zoom auto-framing</li>
                  <li>• Multi-track studio audio isolation</li>
                  <li>• Cloud team sync & instant share</li>
                  <li>• Custom brand kits & intro cards</li>
                  <li>• Automatic speech captions & search</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Grid: Developers & Creators */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {/* Developed by Prestige Tech */}
        <Card className="rounded-2xl border border-border bg-surface shadow-e1 flex flex-col justify-between">
          <div>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 border border-primary/20 text-primary">
                    <Globe className="size-5" />
                  </div>
                  <div>
                    <CardTitle className="text-base font-semibold text-foreground">
                      Prestige Tech
                    </CardTitle>
                    <CardDescription className="text-xs text-subtle-foreground">
                      Software Engineering Studio
                    </CardDescription>
                  </div>
                </div>
                <Badge variant="outline" className="text-[11px] font-mono text-primary">
                  Creator
                </Badge>
              </div>
            </CardHeader>

            <CardContent className="space-y-3 text-xs">
              <p className="text-subtle-foreground leading-relaxed">
                Prestige Tech builds modern, privacy-respecting, high-performance desktop and web
                applications. Engineered with precision architecture, native performance, and
                uncompromising reliability.
              </p>

              <div className="rounded-lg border border-border bg-surface-dim p-2.5 font-mono text-[11px] text-foreground flex items-center justify-between">
                <span className="truncate">{PRESTIGE_TECH_URL}</span>
                <button
                  type="button"
                  onClick={() => handleCopyText(PRESTIGE_TECH_URL, "Prestige Tech URL")}
                  className="text-subtle-foreground hover:text-foreground p-1 cursor-pointer"
                  aria-label="Copy website URL"
                >
                  <Copy className="size-3.5" />
                </button>
              </div>
            </CardContent>
          </div>

          <div className="p-6 pt-0 flex gap-2">
            <Button
              variant="primary"
              className="w-full text-xs h-9 cursor-pointer"
              onClick={() => handleOpenUrl(PRESTIGE_TECH_URL, "Prestige Tech")}
            >
              <ExternalLink className="mr-1.5 size-3.5" />
              Visit prestigetech.dev
            </Button>
          </div>
        </Card>

        {/* Master Developer Profile */}
        <Card className="rounded-2xl border border-border bg-surface shadow-e1 flex flex-col justify-between">
          <div>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="flex size-9 items-center justify-center rounded-xl bg-secondary/10 border border-secondary/20 text-secondary">
                    <Code2 className="size-5" />
                  </div>
                  <div>
                    <CardTitle className="text-base font-semibold text-foreground">
                      Master Developer
                    </CardTitle>
                    <CardDescription className="text-xs text-subtle-foreground">
                      Lead Architect & Engineer
                    </CardDescription>
                  </div>
                </div>
                <Badge variant="outline" className="text-[11px] font-mono text-secondary">
                  Architect
                </Badge>
              </div>
            </CardHeader>

            <CardContent className="space-y-3 text-xs">
              <p className="text-subtle-foreground leading-relaxed">
                Designed and engineered from the ground up to deliver a low-latency,
                memory-efficient desktop recording suite on modern Windows environments.
              </p>

              <div className="rounded-lg border border-border bg-surface-dim p-2.5 font-mono text-[11px] text-foreground flex items-center justify-between">
                <span className="truncate">{MASTER_DEV_URL}</span>
                <button
                  type="button"
                  onClick={() => handleCopyText(MASTER_DEV_URL, "Master Developer URL")}
                  className="text-subtle-foreground hover:text-foreground p-1 cursor-pointer"
                  aria-label="Copy Master Developer URL"
                >
                  <Copy className="size-3.5" />
                </button>
              </div>
            </CardContent>
          </div>

          <div className="p-6 pt-0 flex gap-2">
            <Button
              variant="outline"
              className="w-full text-xs h-9 cursor-pointer border-secondary/30 hover:border-secondary hover:bg-secondary/10 hover:text-foreground"
              onClick={() => handleOpenUrl(MASTER_DEV_URL, "Master Developer")}
            >
              <ExternalLink className="mr-1.5 size-3.5" />
              Visit me.prestigetech.dev
            </Button>
          </div>
        </Card>
      </div>

      {/* Technical Architecture & Stack Card */}
      <Card className="rounded-2xl border border-border bg-surface shadow-e1">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Layers className="size-5 text-primary" />
            <CardTitle className="text-base font-semibold text-foreground">
              Engineering & Native Architecture
            </CardTitle>
          </div>
          <CardDescription className="text-xs text-subtle-foreground">
            Native subsystems powering RecordForge.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
            <div className="rounded-xl border border-border bg-surface-dim p-3.5 space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                <AppWindow className="size-4 text-sky-400" />
                <span>Tauri v2 & Rust Core</span>
              </div>
              <p className="text-[11px] text-subtle-foreground leading-relaxed">
                Native OS window management, high-throughput memory buffers, and minimal system
                overhead.
              </p>
            </div>

            <div className="rounded-xl border border-border bg-surface-dim p-3.5 space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                <Radio className="size-4 text-emerald-400" />
                <span>WASAPI Audio</span>
              </div>
              <p className="text-[11px] text-subtle-foreground leading-relaxed">
                Direct Windows Audio Session API integration for sub-millisecond hardware-clock
                sync.
              </p>
            </div>

            <div className="rounded-xl border border-border bg-surface-dim p-3.5 space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                <Video className="size-4 text-amber-400" />
                <span>FFmpeg 9.0 Sidecar</span>
              </div>
              <p className="text-[11px] text-subtle-foreground leading-relaxed">
                Hardware-accelerated encoding pipelines targeting NVENC, QuickSync, AMF, and Media
                Foundation.
              </p>
            </div>

            <div className="rounded-xl border border-border bg-surface-dim p-3.5 space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                <Cpu className="size-4 text-purple-400" />
                <span>WASM Overlay Engine</span>
              </div>
              <p className="text-[11px] text-subtle-foreground leading-relaxed">
                WebAssembly vector rasterizer rendering smooth cursor highlights and dynamic camera
                overlays.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Footer info & Copyright */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 py-4 text-xs text-subtle-foreground border-t border-border">
        <div className="flex items-center gap-2">
          <span>© {new Date().getFullYear()} Prestige Tech. All rights reserved.</span>
        </div>

        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => handleOpenUrl(PRESTIGE_TECH_URL, "Prestige Tech")}
            className="hover:text-foreground transition-colors cursor-pointer"
          >
            Prestige Tech
          </button>
          <span>•</span>
          <button
            type="button"
            onClick={() => handleOpenUrl(MASTER_DEV_URL, "Master Developer")}
            className="hover:text-foreground transition-colors cursor-pointer"
          >
            Master Developer
          </button>
          {onNavigateToDiagnostics ? (
            <>
              <span>•</span>
              <button
                type="button"
                onClick={onNavigateToDiagnostics}
                className="hover:text-foreground transition-colors cursor-pointer"
              >
                Hardware Diagnostics
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
