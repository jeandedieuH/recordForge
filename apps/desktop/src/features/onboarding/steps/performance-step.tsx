import { useEffect, useMemo, useState } from "react"
import { Check, Cpu, Sparkles, Zap } from "lucide-react"
import { Badge, cn } from "@recordforge/ui"
import type { RecordingConfig } from "@recordforge/contracts"
import { useRecorderStore } from "../../../hooks/use-recorder"
import { getDiagnosticsReport } from "../../../lib/recorder"
import { isTauri } from "../../../lib/settings"

interface ProfileOption {
  id: RecordingConfig["profile"]
  name: string
  resolution: string
  fps: string
  description: string
  tag: string
  minCores: number
}

const PROFILES: ProfileOption[] = [
  {
    id: "low-impact",
    name: "Low Impact",
    resolution: "720p / 480p",
    fps: "30 FPS",
    description: "Lowest CPU usage & small file sizes. Prevents frame drops on budget laptops.",
    tag: "Lightweight",
    minCores: 1,
  },
  {
    id: "balanced",
    name: "Balanced HD",
    resolution: "1080p Full HD",
    fps: "30 FPS",
    description: "Crisp standard HD with high encoding efficiency and universal playback.",
    tag: "Standard",
    minCores: 4,
  },
  {
    id: "smooth-60fps",
    name: "Smooth 60 FPS",
    resolution: "1080p Full HD",
    fps: "60 FPS",
    description: "Ultra-fluid motion for UI walkthroughs, rapid scrolling, and gaming.",
    tag: "Fluid",
    minCores: 6,
  },
  {
    id: "ultra-4k",
    name: "Studio 4K",
    resolution: "2160p Ultra HD",
    fps: "60 FPS",
    description: "Pixel-perfect text sharpness and maximum clarity on high-DPI displays.",
    tag: "Studio",
    minCores: 8,
  },
]

export function PerformanceStep() {
  const {
    selectedProfileId,
    setSelectedProfileId,
    savePreferences,
    encoders,
    loadEncoders,
    loadDiagnostics,
  } = useRecorderStore()

  const [cores, setCores] = useState<number>(4)
  const [cpuName, setCpuName] = useState<string>("Detecting CPU…")

  useEffect(() => {
    if (!isTauri()) {
      setCores(navigator.hardwareConcurrency ?? 4)
      setCpuName("Host Platform CPU")
      return
    }

    void loadEncoders()

    async function probeHardware() {
      try {
        const report = await getDiagnosticsReport()
        const cpuStr = report?.platform?.cpu ?? ""
        const coreMatch = cpuStr.match(/(\d+)\s*(?:logical\s*)?cores?/i)
        const detectedCores = coreMatch
          ? parseInt(coreMatch[1], 10)
          : (navigator.hardwareConcurrency ?? 4)
        setCores(detectedCores)
        setCpuName(cpuStr.replace(/\s*\(\d+\s*logical\s*cores\)/i, "") || "Windows 11 Processor")
      } catch {
        setCores(navigator.hardwareConcurrency ?? 4)
        setCpuName("Windows 11 Compatible CPU")
      }
    }

    void probeHardware()
  }, [loadDiagnostics, loadEncoders])

  const hardwareEncoder = useMemo(() => {
    const priority = ["h264_nvenc", "h264_qsv", "h264_amf", "h264_mf"]
    const available = new Set(
      (encoders ?? []).filter((encoder) => encoder?.available).map((encoder) => encoder?.id),
    )
    const best = priority.find((id) => available.has(id))
    if (!best) return null
    return encoders?.find((encoder) => encoder?.id === best)?.name ?? null
  }, [encoders])

  const recommendedProfileId = useMemo<RecordingConfig["profile"]>(() => {
    if (cores <= 2) return "low-impact"
    if (cores >= 8 && hardwareEncoder) return "smooth-60fps"
    if (cores >= 6) return "smooth-60fps"
    return "balanced"
  }, [cores, hardwareEncoder])

  useEffect(() => {
    if (recommendedProfileId) {
      setSelectedProfileId(recommendedProfileId)
      void savePreferences({ profile: recommendedProfileId })
    }
  }, [recommendedProfileId, setSelectedProfileId, savePreferences])

  function handleSelectProfile(profileId: RecordingConfig["profile"]) {
    setSelectedProfileId(profileId)
    void savePreferences({ profile: profileId })
  }

  return (
    <div className="flex flex-col gap-5 text-foreground">
      {/* Hardware Benchmark Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3.5 rounded-xl border border-primary/30 bg-primary/10 p-4 shadow-e1">
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-white shadow-sm">
            <Cpu className="size-5" />
          </div>
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-primary uppercase tracking-wider">
                Hardware Autodetect
              </span>
              <Badge variant="accent" className="text-[10px] px-1.5 py-0">
                {cores} Cores
              </Badge>
            </div>
            <p className="text-sm font-medium text-foreground truncate max-w-md">{cpuName}</p>
          </div>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-center pl-2 border-l border-primary/20">
          <Zap className="size-4 text-warning shrink-0" />
          <div className="text-xs">
            <span className="text-subtle-foreground block">Encoder:</span>
            <span className="font-semibold text-foreground">
              {hardwareEncoder ? `${hardwareEncoder} (Hardware)` : "libx264 (Software CPU)"}
            </span>
          </div>
        </div>
      </div>

      {/* Profile Selector Grid */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground">
            Choose Default Recording Profile
          </label>
          <span className="text-xs text-subtle-foreground">
            Can be adjusted per-recording anytime
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {PROFILES.map((prof) => {
            const isSelected = selectedProfileId === prof.id
            const isRecommended = prof.id === recommendedProfileId

            return (
              <div
                key={prof.id}
                onClick={() => handleSelectProfile(prof.id)}
                className={cn(
                  "relative flex flex-col justify-between rounded-xl border p-4 cursor-pointer transition-all duration-fast ease-forge select-none",
                  isSelected
                    ? "border-primary bg-primary/15 shadow-e2 ring-1 ring-primary"
                    : "border-border bg-surface/70 hover:border-border-strong hover:bg-surface",
                )}
              >
                {isRecommended && (
                  <div className="absolute -top-2.5 right-3">
                    <Badge
                      variant="accent"
                      className="text-[10px] px-2 py-0.5 font-semibold bg-accent text-accent-foreground shadow-sm flex items-center gap-1"
                    >
                      <Sparkles className="size-3" />
                      Recommended
                    </Badge>
                  </div>
                )}

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div
                        className={cn(
                          "size-4 rounded-full border flex items-center justify-center transition-colors",
                          isSelected
                            ? "border-primary bg-primary text-white"
                            : "border-border-strong",
                        )}
                      >
                        {isSelected && <Check className="size-2.5 stroke-3" />}
                      </div>
                      <span className="font-semibold text-sm text-foreground">{prof.name}</span>
                    </div>

                    <span className="text-xs font-mono font-medium text-subtle-foreground">
                      {prof.resolution}
                    </span>
                  </div>

                  <p className="text-xs text-subtle-foreground leading-relaxed">
                    {prof.description}
                  </p>
                </div>

                <div className="mt-3.5 flex items-center justify-between pt-2.5 border-t border-border/50 text-[11px] text-subtle-foreground">
                  <span className="font-mono">{prof.fps}</span>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                    {prof.tag}
                  </Badge>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
