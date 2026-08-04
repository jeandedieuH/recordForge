import { useState } from "react"
import type { MediaJob, TimelineCanvas } from "@recordforge/contracts"
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Cpu,
  Database,
  Film,
  Play,
  Sliders,
  Zap,
} from "lucide-react"
import {
  Badge,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@recordforge/ui"

interface ExportViewProps {
  projectName?: string
  canvas?: TimelineCanvas
  exportJob?: MediaJob | null
  error?: string | null
  onDismissError?: () => void
  onBack: () => void
  onStartExport?: () => void | Promise<void>
}

type PresetId = "fast-share" | "balanced" | "smooth-demo" | "archive"

export function ExportView({
  projectName = "Recording",
  canvas,
  exportJob = null,
  error = null,
  onDismissError,
  onBack,
  onStartExport,
}: ExportViewProps) {
  const [selectedPreset, setSelectedPreset] = useState<PresetId>("balanced")
  const [isStarting, setIsStarting] = useState(false)
  const [videoAccordionOpen, setVideoAccordionOpen] = useState(true)
  const [audioAccordionOpen, setAudioAccordionOpen] = useState(false)
  const [useNvenc, setUseNvenc] = useState(true)
  const [codec, setCodec] = useState("hevc")
  const [bitrateControl, setBitrateControl] = useState("vbr-2pass")

  async function handleStartExport() {
    if (!onStartExport || isStarting || exportJob?.status === "running") return
    setIsStarting(true)
    try {
      await onStartExport()
    } finally {
      setIsStarting(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground select-none">
      {/* Top Breadcrumb Navigation Header */}
      <div className="flex h-12 items-center justify-between border-b border-border px-6 text-xs text-subtle-foreground">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-2 font-medium transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          <span>Editor</span>
          <span>&gt;</span>
          <span className="font-semibold text-foreground">{projectName}</span>
        </button>
      </div>

      {/* Main Content Area */}
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col p-8 pb-32">
        {/* Title & Description */}
        <h1 className="font-serif text-3xl font-bold tracking-tight text-foreground mb-1">
          Export Project
        </h1>
        <p className="text-sm text-subtle-foreground mb-8">
          Configure rendering and delivery options for{" "}
          <strong className="text-foreground font-semibold">{projectName}</strong>.
        </p>

        {error ? (
          <div
            className="mb-6 flex items-center justify-between gap-3 rounded-lg border border-recording/30 bg-recording/10 px-3 py-2 text-sm text-foreground"
            role="alert"
          >
            <span>Couldn't start the export. Choose another destination and try again.</span>
            {onDismissError ? (
              <Button variant="ghost" size="sm" onClick={onDismissError}>
                Dismiss
              </Button>
            ) : null}
          </div>
        ) : null}

        {exportJob?.status === "completed" ? (
          <div
            className="mb-6 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-foreground"
            role="status"
          >
            Export complete. Your edited MP4 is ready at the selected destination.
          </div>
        ) : null}

        {/* Section 1: RENDER PRESETS */}
        <div className="flex flex-col gap-3 mb-8">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-subtle-foreground font-label">
            <Zap className="size-4 text-track-screen" />
            <span>Render Presets</span>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* Preset 1: Fast Share */}
            <button
              type="button"
              onClick={() => setSelectedPreset("fast-share")}
              className={`flex flex-col justify-between rounded-xl border p-4 text-left transition-all ${
                selectedPreset === "fast-share"
                  ? "border-primary bg-primary/20 shadow-lg"
                  : "border-border bg-surface hover:border-border-strong"
              }`}
            >
              <div className="flex items-start justify-between w-full">
                <div className="flex flex-col gap-1">
                  <span className="font-sans text-sm font-bold text-foreground">Fast Share</span>
                  <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                    <span className="rounded bg-overlay px-1.5 py-0.5">1080p</span>
                    <span className="rounded bg-overlay px-1.5 py-0.5">30fps</span>
                    <span className="rounded bg-overlay px-1.5 py-0.5">H.264</span>
                  </div>
                </div>
                <Zap className="size-4 text-muted-foreground" />
              </div>
              <div className="mt-6 flex items-center justify-between border-t border-border pt-3 text-[11px] font-mono text-subtle-foreground">
                <span>EST. SIZE</span>
                <span className="font-semibold text-foreground">~45 MB</span>
              </div>
            </button>

            {/* Preset 2: Balanced (DEFAULT) */}
            <button
              type="button"
              onClick={() => setSelectedPreset("balanced")}
              className={`flex flex-col justify-between rounded-xl border p-4 text-left transition-all ${
                selectedPreset === "balanced"
                  ? "border-primary bg-primary/20 shadow-lg"
                  : "border-border bg-surface hover:border-border-strong"
              }`}
            >
              <div className="flex items-start justify-between w-full">
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="font-sans text-sm font-bold text-foreground">Balanced</span>
                    <Badge
                      variant="accent"
                      className="border-border bg-primary/30 text-[9px] text-foreground"
                    >
                      DEFAULT
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                    <span className="rounded bg-overlay px-1.5 py-0.5">1440p</span>
                    <span className="rounded bg-overlay px-1.5 py-0.5">60fps</span>
                    <span className="rounded bg-overlay px-1.5 py-0.5">HEVC</span>
                  </div>
                </div>
                <Sliders className="size-4 text-muted-foreground" />
              </div>
              <div className="mt-6 flex items-center justify-between border-t border-border pt-3 text-[11px] font-mono text-subtle-foreground">
                <span>EST. SIZE</span>
                <span className="font-semibold text-foreground">~120 MB</span>
              </div>
            </button>

            {/* Preset 3: Smooth Demo */}
            <button
              type="button"
              onClick={() => setSelectedPreset("smooth-demo")}
              className={`flex flex-col justify-between rounded-xl border p-4 text-left transition-all ${
                selectedPreset === "smooth-demo"
                  ? "border-primary bg-primary/20 shadow-lg"
                  : "border-border bg-surface hover:border-border-strong"
              }`}
            >
              <div className="flex items-start justify-between w-full">
                <div className="flex flex-col gap-1">
                  <span className="font-sans text-sm font-bold text-foreground">Smooth Demo</span>
                  <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                    <span className="rounded bg-overlay px-1.5 py-0.5">1080p</span>
                    <span className="rounded bg-overlay px-1.5 py-0.5">60fps</span>
                    <span className="rounded bg-overlay px-1.5 py-0.5">H.264</span>
                  </div>
                </div>
                <Film className="size-4 text-muted-foreground" />
              </div>
              <div className="mt-6 flex items-center justify-between border-t border-border pt-3 text-[11px] font-mono text-subtle-foreground">
                <span>EST. SIZE</span>
                <span className="font-semibold text-foreground">~85 MB</span>
              </div>
            </button>

            {/* Preset 4: Archive */}
            <button
              type="button"
              onClick={() => setSelectedPreset("archive")}
              className={`flex flex-col justify-between rounded-xl border p-4 text-left transition-all ${
                selectedPreset === "archive"
                  ? "border-primary bg-primary/20 shadow-lg"
                  : "border-border bg-surface hover:border-border-strong"
              }`}
            >
              <div className="flex items-start justify-between w-full">
                <div className="flex flex-col gap-1">
                  <span className="font-sans text-sm font-bold text-foreground">Archive</span>
                  <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                    <span className="rounded bg-overlay px-1.5 py-0.5">4K Source</span>
                    <span className="rounded bg-overlay px-1.5 py-0.5">60fps</span>
                    <span className="rounded bg-overlay px-1.5 py-0.5">ProRes LT</span>
                  </div>
                </div>
                <Database className="size-4 text-muted-foreground" />
              </div>
              <div className="mt-6 flex items-center justify-between border-t border-border pt-3 text-[11px] font-mono text-subtle-foreground">
                <span>EST. SIZE</span>
                <span className="font-semibold text-foreground">~850 MB</span>
              </div>
            </button>
          </div>
        </div>

        {/* Section 2: Video Configuration Accordion */}
        <div className="flex flex-col rounded-xl border border-border bg-surface overflow-hidden mb-4">
          <button
            type="button"
            onClick={() => setVideoAccordionOpen((prev) => !prev)}
            className="flex items-center justify-between p-4 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:bg-overlay transition-colors"
          >
            <div className="flex items-center gap-2 font-label">
              <Film className="size-4 text-track-screen" />
              <span>Video Configuration</span>
            </div>
            {videoAccordionOpen ? (
              <ChevronUp className="size-4" />
            ) : (
              <ChevronDown className="size-4" />
            )}
          </button>

          {videoAccordionOpen ? (
            <div className="flex flex-col gap-5 border-t border-border p-5">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="export-codec"
                    className="font-label text-xs font-bold tracking-wider uppercase text-subtle-foreground"
                  >
                    Codec
                  </label>
                  <Select value={codec} onValueChange={(val) => setCodec(val)}>
                    <SelectTrigger
                      id="export-codec"
                      className="border-border bg-background text-xs text-foreground"
                    >
                      <SelectValue placeholder="Select codec" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="hevc">H.265 (HEVC)</SelectItem>
                      <SelectItem value="h264">H.264 (AVC)</SelectItem>
                      <SelectItem value="prores">ProRes LT</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="export-bitrate"
                    className="font-label text-xs font-bold tracking-wider uppercase text-subtle-foreground"
                  >
                    Bitrate Control
                  </label>
                  <Select value={bitrateControl} onValueChange={(val) => setBitrateControl(val)}>
                    <SelectTrigger
                      id="export-bitrate"
                      className="border-border bg-background text-xs text-foreground"
                    >
                      <SelectValue placeholder="Select bitrate control" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="vbr-2pass">VBR (Variable) - 2 Pass</SelectItem>
                      <SelectItem value="vbr-1pass">VBR (Variable) - 1 Pass</SelectItem>
                      <SelectItem value="cbr">CBR (Constant)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Hardware Encoding Section */}
              <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-dim p-4">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-subtle-foreground font-label">
                    <Cpu className="size-4 text-success" />
                    <span>Hardware Encoding</span>
                  </div>
                  <div className="inline-flex items-center gap-1.5 rounded border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] font-mono font-semibold text-success">
                    <span className="size-1.5 rounded-full bg-success animate-pulse" />
                    <span>NVENC DETECTED</span>
                  </div>
                </div>

                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useNvenc}
                    onChange={(e) => setUseNvenc(e.target.checked)}
                    className="mt-0.5 size-4 rounded border-border bg-surface text-primary focus:ring-0"
                  />
                  <div className="flex flex-col">
                    <span className="text-xs font-semibold text-foreground">Use NVIDIA NVENC</span>
                    <span className="text-xs text-subtle-foreground">
                      Significantly speeds up export times using GPU acceleration.
                    </span>
                  </div>
                </label>
              </div>
            </div>
          ) : null}
        </div>

        {/* Section 3: Audio Configuration Accordion */}
        <div className="flex flex-col rounded-xl border border-border bg-surface overflow-hidden">
          <button
            type="button"
            onClick={() => setAudioAccordionOpen((prev) => !prev)}
            className="flex items-center justify-between p-4 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:bg-overlay transition-colors"
          >
            <div className="flex items-center gap-2 font-label">
              <Zap className="size-4 text-track-mic" />
              <span>Audio Configuration</span>
            </div>
            {audioAccordionOpen ? (
              <ChevronUp className="size-4" />
            ) : (
              <ChevronDown className="size-4" />
            )}
          </button>
        </div>
      </div>

      {/* Sticky Bottom Export Summary Footer */}
      <div className="fixed bottom-0 inset-x-0 flex h-18 items-center justify-between border-t border-border bg-background/95 px-8 shadow-2xl backdrop-blur">
        <div className="flex flex-col">
          <span className="text-[10px] font-label font-bold uppercase tracking-wider text-subtle-foreground">
            Summary
          </span>
          <span className="font-mono text-xs font-semibold text-foreground">
            {projectName} •{" "}
            {canvas ? `${canvas.width}×${canvas.height} • ${canvas.fps}fps` : "Source canvas"} •
            H.264 • AAC
          </span>
        </div>

        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            className="border-border bg-surface-dim text-xs font-medium text-muted-foreground hover:bg-overlay hover:text-foreground"
          >
            Add to Queue
          </Button>

          <Button
            onClick={() => void handleStartExport()}
            disabled={isStarting || exportJob?.status === "running"}
            className="flex items-center gap-2 rounded-lg bg-tertiary px-5 py-2 text-xs font-semibold text-white shadow-lg transition-all hover:bg-tertiary-hover"
          >
            <Play className="size-3.5 fill-white" />
            <span>
              {isStarting
                ? "Choosing destination…"
                : exportJob?.status === "running"
                  ? `Exporting ${Math.round(exportJob.progress * 100)}%`
                  : "Start Export"}
            </span>
          </Button>
        </div>
      </div>
    </div>
  )
}
