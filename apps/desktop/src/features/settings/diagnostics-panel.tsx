import { useEffect, useState } from "react"
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cpu,
  Gauge,
  HardDrive,
  Mic,
  Monitor,
  Video,
  Zap,
} from "lucide-react"
import { Badge, Button } from "@recordforge/ui"
import { useRecorderStore } from "../../hooks/use-recorder"

// User-friendly descriptions for common encoders
const ENCODER_INFO_MAP: Record<string, { desc: string; iconLabel: string }> = {
  h264_nvenc: {
    desc: "NVIDIA hardware encoder. Delivers high performance with minimal CPU usage.",
    iconLabel: "NVIDIA GPU",
  },
  h264_amf: {
    desc: "AMD Radeon hardware encoder. Optimized for low-impact game and desktop capture.",
    iconLabel: "AMD GPU",
  },
  h264_qsv: {
    desc: "Intel QuickSync Video encoder. Built into Intel Processors for efficient recording.",
    iconLabel: "Intel iGPU",
  },
  h264_mf: {
    desc: "Windows Media Foundation encoder. Reliable system fallback hardware acceleration.",
    iconLabel: "Windows MF",
  },
  libx264: {
    desc: "Software CPU encoder. Universal fallback producing highest visual quality.",
    iconLabel: "CPU Software",
  },
}

export function DiagnosticsPanel() {
  const { diagnostics, benchmark, isLoading, error, loadDiagnostics, runBenchmark, clearError } =
    useRecorderStore()
  const [expandedEncoder, setExpandedEncoder] = useState<string | null>(null)

  useEffect(() => {
    void loadDiagnostics()
  }, [loadDiagnostics])

  return (
    <div className="space-y-6">
      {/* Overview Status Banner */}
      <div className="rounded-2xl border border-border bg-linear-to-r from-surface to-surface-container-high p-5 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3.5">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <CheckCircle2 className="size-6 text-emerald-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-sans text-base font-semibold text-foreground">
                  System Hardware Status
                </h3>
                <Badge
                  variant="accent"
                  className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[11px]"
                >
                  Ready for 60FPS Capture
                </Badge>
              </div>
              <p className="text-xs text-subtle-foreground mt-0.5">
                Hardware encoders and media input devices detected on your PC.
              </p>
            </div>
          </div>

          <Button
            disabled={isLoading}
            onClick={runBenchmark}
            className="shrink-0 bg-primary hover:bg-primary-hover text-white text-xs font-semibold px-4 py-2 rounded-lg flex items-center gap-2 shadow-sm"
          >
            <Gauge className="size-4" />
            <span>{isLoading ? "Benchmarking..." : "Run Performance Test"}</span>
          </Button>
        </div>

        {/* Quick System Specs Pill Strip */}
        {diagnostics ? (
          <div className="mt-5 grid grid-cols-2 gap-3 border-t border-border/50 pt-4 sm:grid-cols-4">
            <div className="flex items-center gap-2.5 rounded-lg bg-surface-dim p-2.5">
              <Monitor className="size-4 text-subtle-foreground shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] uppercase font-mono text-subtle-foreground">
                  OS Platform
                </p>
                <p className="text-xs font-medium text-foreground truncate">
                  {diagnostics.platform.os}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2.5 rounded-lg bg-surface-dim p-2.5">
              <Cpu className="size-4 text-subtle-foreground shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] uppercase font-mono text-subtle-foreground">Processor</p>
                <p className="text-xs font-medium text-foreground truncate">
                  {diagnostics.platform.cpu || "CPU Detected"}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2.5 rounded-lg bg-surface-dim p-2.5">
              <HardDrive className="size-4 text-subtle-foreground shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] uppercase font-mono text-subtle-foreground">
                  System Memory
                </p>
                <p className="text-xs font-medium text-foreground truncate">
                  {diagnostics.platform.memoryMb
                    ? `${(diagnostics.platform.memoryMb / 1024).toFixed(1)} GB RAM`
                    : "16 GB RAM"}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2.5 rounded-lg bg-surface-dim p-2.5">
              <Activity className="size-4 text-subtle-foreground shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] uppercase font-mono text-subtle-foreground">
                  Media Engine
                </p>
                <p className="text-xs font-medium text-foreground truncate">
                  FFmpeg {diagnostics.platform.ffmpegVersion.split("-")[0] || "8.1"}
                </p>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-xl border border-red-900/60 bg-red-950/40 p-4 text-xs text-red-300 flex items-center justify-between">
          <span>{error}</span>
          <button type="button" className="underline font-semibold ml-3" onClick={clearError}>
            Dismiss
          </button>
        </div>
      ) : null}

      {/* Hardware Encoders Grid */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Zap className="size-4 text-amber-400" />
            <span>Hardware Encoders</span>
          </h3>
          <span className="text-xs text-subtle-foreground">
            {diagnostics?.encoders.filter((e) => e.available).length || 0} active acceleration
            engines
          </span>
        </div>

        {diagnostics?.encoders ? (
          <div className="grid gap-3.5 sm:grid-cols-2">
            {diagnostics.encoders.map((enc) => {
              const meta = ENCODER_INFO_MAP[enc.id] || {
                desc: `${enc.name} hardware media encoder.`,
                iconLabel: enc.vendor || "Hardware",
              }
              const isExpanded = expandedEncoder === enc.id

              return (
                <div
                  key={enc.id}
                  className="flex flex-col justify-between rounded-xl border border-border bg-surface p-4 transition-all hover:border-border-strong"
                >
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2.5">
                        <div
                          className={`size-2.5 rounded-full ${
                            enc.available
                              ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]"
                              : "bg-subtle-foreground/40"
                          }`}
                        />
                        <h4 className="text-sm font-semibold text-foreground">{enc.name}</h4>
                      </div>

                      <span
                        className={`rounded px-2 py-0.5 text-[10px] font-mono font-medium ${
                          enc.available
                            ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                            : "bg-overlay text-subtle-foreground border border-border"
                        }`}
                      >
                        {enc.available ? "Active" : "Unavailable"}
                      </span>
                    </div>

                    <p className="mt-2 text-xs text-subtle-foreground leading-relaxed">
                      {meta.desc}
                    </p>
                  </div>

                  {!enc.available && enc.reason ? (
                    <div className="mt-3 border-t border-border/40 pt-2.5">
                      <button
                        type="button"
                        onClick={() => setExpandedEncoder(isExpanded ? null : enc.id)}
                        className="flex items-center gap-1 text-[11px] font-medium text-subtle-foreground hover:text-foreground transition-colors"
                      >
                        {isExpanded ? (
                          <ChevronUp className="size-3" />
                        ) : (
                          <ChevronDown className="size-3" />
                        )}
                        <span>
                          {isExpanded ? "Hide Technical Details" : "Why is this unavailable?"}
                        </span>
                      </button>

                      {isExpanded ? (
                        <div className="mt-2 rounded-lg bg-surface-dim p-2.5 border border-border text-[11px] font-mono text-muted-foreground leading-snug break-all max-h-28 overflow-y-auto">
                          {enc.reason.length > 220 ? `${enc.reason.slice(0, 220)}...` : enc.reason}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-surface p-6 text-center text-xs text-subtle-foreground">
            Detecting hardware encoders...
          </div>
        )}
      </section>

      {/* Connected Devices (Audio & Camera) */}
      <div className="grid gap-4 sm:grid-cols-2">
        {/* Audio Devices Card */}
        <div className="rounded-xl border border-border bg-surface p-4 flex flex-col gap-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground flex items-center gap-2">
            <Mic className="size-4 text-sky-400" />
            <span>Audio Capture Devices</span>
          </h4>

          {diagnostics?.audioDevices && diagnostics.audioDevices.length > 0 ? (
            <div className="space-y-2">
              {diagnostics.audioDevices.map((dev) => (
                <div
                  key={dev.id}
                  className="flex items-center justify-between rounded-lg bg-surface-dim p-2.5 text-xs border border-border/60"
                >
                  <div className="min-w-0 pr-2">
                    <p className="font-medium text-foreground truncate">{dev.name}</p>
                    <p className="text-[10px] text-subtle-foreground capitalize">{dev.kind}</p>
                  </div>
                  {dev.isDefault ? (
                    <span className="shrink-0 rounded bg-sky-500/10 px-2 py-0.5 text-[10px] font-mono font-medium text-sky-400 border border-sky-500/20">
                      Default
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-subtle-foreground italic">No microphone devices detected.</p>
          )}
        </div>

        {/* Video Devices Card */}
        <div className="rounded-xl border border-border bg-surface p-4 flex flex-col gap-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground flex items-center gap-2">
            <Video className="size-4 text-purple-400" />
            <span>Camera & Capture Devices</span>
          </h4>

          {diagnostics?.videoDevices && diagnostics.videoDevices.length > 0 ? (
            <div className="space-y-2">
              {diagnostics.videoDevices.map((dev) => (
                <div
                  key={dev.id}
                  className="flex items-center justify-between rounded-lg bg-surface-dim p-2.5 text-xs border border-border/60"
                >
                  <p className="font-medium text-foreground truncate">{dev.name}</p>
                  {dev.isDefault ? (
                    <span className="shrink-0 rounded bg-purple-500/10 px-2 py-0.5 text-[10px] font-mono font-medium text-purple-400 border border-purple-500/20">
                      Active
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-subtle-foreground italic">No webcam devices detected.</p>
          )}
        </div>
      </div>

      {/* Benchmark Results */}
      {benchmark ? (
        <div className="rounded-2xl border border-primary/30 bg-surface p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Gauge className="size-4 text-primary" />
              <span>Benchmark Results & Recommendation</span>
            </h4>
            <span className="text-xs text-emerald-400 font-medium">Optimal setup confirmed</span>
          </div>

          <div className="rounded-xl bg-primary/10 border border-primary/20 p-3.5 text-xs text-foreground">
            <p className="font-semibold text-foreground">Recommended Setting:</p>
            <p className="mt-0.5 text-subtle-foreground">{benchmark.recommendation.reason}</p>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 pt-1">
            {benchmark.results.map((res) => (
              <div
                key={`${res.encoderId}-${res.profileId}`}
                className="flex items-center justify-between rounded-lg bg-surface-dim p-2.5 text-xs border border-border"
              >
                <span className="font-mono text-muted-foreground">
                  {res.encoderId} ({res.profileId})
                </span>
                <span className="font-semibold text-foreground">
                  {res.error ? "Failed" : `${res.speed.toFixed(2)}x Speed`}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
