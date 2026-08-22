import { useEffect, useMemo, useState } from "react"
import type {
  ExportEncoderPreference,
  ExportPreset,
  ExportRange,
  MediaJob,
  ProjectExportSettings,
  RenderCaptionMode,
  RenderChapterMode,
  TimelineCanvas,
  TimelineMarker,
} from "@recordforge/contracts"
import { formatYouTubeChapters } from "@recordforge/editor-core"
import {
  ArrowLeft,
  Bookmark,
  Check,
  ChevronDown,
  ChevronUp,
  Cloud,
  Copy,
  Film,
  FolderOpen,
  Pause,
  Play,
  RotateCcw,
  Square,
  Zap,
} from "lucide-react"
import {
  Badge,
  Button,
  Input,
  Progress,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@recordforge/ui"
import { UploadDialog } from "../storage/components/upload-dialog"

interface ExportViewProps {
  projectName?: string
  canvas?: TimelineCanvas
  durationMs?: number
  exportSettings?: ProjectExportSettings
  captionMode?: RenderCaptionMode
  onCaptionModeChange?: (mode: RenderCaptionMode) => void
  chapterMode?: RenderChapterMode
  onChapterModeChange?: (mode: RenderChapterMode) => void
  markers?: TimelineMarker[]
  onPresetChange?: (preset: ExportPreset) => void
  onCodecChange?: (codec: "h264" | "hevc") => void
  onEncoderChange?: (encoder: ExportEncoderPreference) => void
  /** Display name of the detected hardware encoder, or null when none was found. */
  hardwareEncoderName?: string | null
  onRangeChange?: (range: ExportRange | undefined) => void
  exportJob?: MediaJob | null
  error?: string | null
  onDismissError?: () => void
  onCancelExport?: () => void | Promise<void>
  onRetryExport?: () => void | Promise<void>
  onRevealExport?: () => void | Promise<void>
  onBack: () => void
  onStartExport?: () => void | Promise<void>
}

const PRESETS: Array<{
  id: ExportPreset
  label: string
  description: string
  details: string
}> = [
  {
    id: "fast-share",
    label: "Fast share",
    description: "Small MP4 for quick review",
    details: "H.264 · project fps · fast",
  },
  {
    id: "balanced",
    label: "Balanced",
    description: "Recommended quality and size",
    details: "H.264 · efficient",
  },
  {
    id: "smooth-60fps",
    label: "Smooth 60 fps",
    description: "High framerate for fluid motion",
    details: "H.264 · 60 fps · fluid",
  },
  {
    id: "high-quality",
    label: "High quality",
    description: "More detail for final delivery",
    details: "H.264 · CRF 18 · AAC 192k",
  },
  {
    id: "ultra-4k",
    label: "Ultra 4K",
    description: "Crisp 3840×2160 UHD output",
    details: "H.264/HEVC · 4K · pristine",
  },
  {
    id: "ultra-4k-60",
    label: "Ultra 4K 60 fps",
    description: "Ultimate high-framerate UHD presentation",
    details: "H.264/HEVC · 4K60 · broadcast",
  },
  {
    id: "vertical",
    label: "Vertical",
    description: "Use a 9:16 project canvas",
    details: "MP4 · social framing",
  },
  {
    id: "square",
    label: "Square",
    description: "Use a 1:1 project canvas",
    details: "MP4 · social framing",
  },
  {
    id: "selected-range",
    label: "Selected range",
    description: "Export only the chosen timeline range",
    details: "Non-destructive · remapped time",
  },
]

function isPresetSupported(
  preset: ExportPreset,
  canvas: TimelineCanvas | undefined,
  range: ExportRange | null | undefined,
): boolean {
  if (preset === "vertical") return Boolean(canvas && canvas.height > canvas.width)
  if (preset === "square") return Boolean(canvas && canvas.width === canvas.height)
  if (preset === "selected-range") return Boolean(range && range.endMs > range.startMs)
  return true
}

function normalizePreset(preset: ExportPreset | undefined): ExportPreset {
  return preset === "default-mp4" || !preset ? "balanced" : preset
}

// Internal pipeline stage slugs surfaced by the backend job; mapped here so
// users see a label instead of an identifier like "cursor".
const STAGE_LABELS: Record<string, string> = {
  queued: "Preparing export",
  "resolving-assets": "Resolving assets",
  rendering: "Rendering timeline",
  cursor: "Rendering cursor",
  captions: "Writing captions",
  validating: "Validating output",
}

function stageLabel(stage: string | null | undefined): string {
  if (!stage) return "Preparing export"
  return STAGE_LABELS[stage] ?? stage
}

export function ExportView({
  projectName = "Recording",
  canvas,
  durationMs = 0,
  exportSettings,
  captionMode = "burn-in",
  onCaptionModeChange,
  chapterMode = "embed",
  onChapterModeChange,
  markers = [],
  onPresetChange,
  onCodecChange,
  onEncoderChange,
  hardwareEncoderName = null,
  onRangeChange,
  exportJob = null,
  error = null,
  onDismissError,
  onCancelExport,
  onRetryExport,
  onRevealExport,
  onBack,
  onStartExport,
}: ExportViewProps) {
  const [selectedPreset, setSelectedPreset] = useState<ExportPreset>(
    normalizePreset(exportSettings?.preset),
  )
  const [isStarting, setIsStarting] = useState(false)
  const [videoAccordionOpen, setVideoAccordionOpen] = useState(true)
  const [chaptersAccordionOpen, setChaptersAccordionOpen] = useState(true)
  const [audioAccordionOpen, setAudioAccordionOpen] = useState(false)
  const [copiedTimestamps, setCopiedTimestamps] = useState(false)
  const [rangeStart, setRangeStart] = useState(exportSettings?.range?.startMs ?? 0)
  const [rangeEnd, setRangeEnd] = useState(exportSettings?.range?.endMs ?? durationMs)
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false)

  const youtubeChapterText = useMemo(() => {
    return formatYouTubeChapters(markers, durationMs, projectName || "Intro")
  }, [markers, durationMs, projectName])

  async function handleCopyYouTubeChapters() {
    if (!youtubeChapterText) return
    try {
      await navigator.clipboard.writeText(youtubeChapterText)
      setCopiedTimestamps(true)
      setTimeout(() => setCopiedTimestamps(false), 2000)
    } catch {
      // Ignore clipboard write failure
    }
  }

  useEffect(() => {
    const nextPreset = normalizePreset(exportSettings?.preset)
    setSelectedPreset(nextPreset)
    setRangeStart(exportSettings?.range?.startMs ?? 0)
    setRangeEnd(exportSettings?.range?.endMs ?? durationMs)
  }, [
    durationMs,
    exportSettings?.preset,
    exportSettings?.range?.endMs,
    exportSettings?.range?.startMs,
  ])

  const selectedRange = useMemo<ExportRange | undefined>(() => {
    if (rangeEnd <= rangeStart) return undefined
    return { startMs: Math.max(0, rangeStart), endMs: Math.min(durationMs, rangeEnd) }
  }, [durationMs, rangeEnd, rangeStart])
  const isRunning = exportJob?.status === "running" || exportJob?.status === "pending"
  const canStart = isPresetSupported(selectedPreset, canvas, selectedRange)
  const progress = Math.round((exportJob?.progress ?? 0) * 100)

  function selectPreset(preset: ExportPreset) {
    if (!isPresetSupported(preset, canvas, selectedRange)) return
    setSelectedPreset(preset)
    onPresetChange?.(preset)
    if (preset === "selected-range") onRangeChange?.(selectedRange)
  }

  function updateRange(startMs: number, endMs: number) {
    setRangeStart(startMs)
    setRangeEnd(endMs)
    const nextRange = endMs > startMs ? { startMs: Math.max(0, startMs), endMs } : undefined
    onRangeChange?.(nextRange)
  }

  async function handleStartExport() {
    if (!onStartExport || isStarting || isRunning || !canStart) return
    setIsStarting(true)
    try {
      await onStartExport()
    } finally {
      setIsStarting(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground select-none">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-6 text-xs text-subtle-foreground">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-2 font-medium transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
          <span>Editor</span>
          <span aria-hidden>&gt;</span>
          <span className="font-semibold text-foreground">{projectName}</span>
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col p-8 pb-12">
          <h1 className="mb-1 font-serif text-3xl font-bold tracking-tight text-foreground">
            Export project
          </h1>
          <p className="mb-8 text-sm text-subtle-foreground">
            Render the saved project with the same timeline semantics used by preview.
          </p>

          {error ? (
            <div
              className="mb-6 flex items-center justify-between gap-3 rounded-lg border border-recording/30 bg-recording/10 px-3 py-2 text-sm"
              role="alert"
            >
              <span>{error}</span>
              {onDismissError ? (
                <Button variant="ghost" size="sm" onClick={onDismissError}>
                  Dismiss
                </Button>
              ) : null}
            </div>
          ) : null}

          {exportJob?.status === "completed" ? (
            <div
              className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm"
              role="status"
            >
              <span className="flex items-center gap-2">
                <Check className="size-4 text-success" aria-hidden />
                Export complete. The validated MP4 is ready.
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setUploadDialogOpen(true)}
                >
                  <Cloud className="size-4 text-primary" aria-hidden />
                  Upload to Cloud
                </Button>
                {onRevealExport ? (
                  <Button variant="ghost" size="sm" onClick={() => void onRevealExport()}>
                    <FolderOpen className="mr-2 size-4" aria-hidden />
                    Reveal file
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {isRunning ? (
            <div
              className="mb-6 rounded-xl border border-primary/30 bg-primary/10 p-4"
              role="status"
              aria-live="polite"
            >
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="font-semibold">{stageLabel(exportJob?.stage)}</span>
                <span className="font-mono text-subtle-foreground">{progress}%</span>
              </div>
              <Progress value={progress} aria-label={`Export progress ${progress}%`} />
              <div className="mt-3 flex items-center justify-between gap-3 text-xs text-subtle-foreground">
                <span>{exportJob?.message ?? "Rendering project"}</span>
                {onCancelExport ? (
                  <Button variant="secondary" size="sm" onClick={() => void onCancelExport()}>
                    <Square className="mr-2 size-3.5 fill-current" aria-hidden />
                    Cancel export
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {exportJob?.status === "failed" ? (
            <div
              className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-recording/30 bg-recording/10 p-4"
              role="alert"
            >
              <div>
                <p className="font-semibold">Export failed</p>
                <p className="mt-1 text-xs text-subtle-foreground">
                  {exportJob.error ?? "The output was not published. You can retry this same job."}
                </p>
              </div>
              {onRetryExport ? (
                <Button variant="secondary" size="sm" onClick={() => void onRetryExport()}>
                  <RotateCcw className="mr-2 size-3.5" aria-hidden />
                  Retry job
                </Button>
              ) : null}
            </div>
          ) : null}

          <div className="mb-8 flex flex-col gap-3">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-subtle-foreground font-label">
              <Zap className="size-4 text-track-screen" aria-hidden />
              <span>Render preset</span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {PRESETS.map((preset) => {
                const supported = isPresetSupported(preset.id, canvas, selectedRange)
                const selected = selectedPreset === preset.id
                return (
                  <button
                    key={preset.id}
                    type="button"
                    disabled={!supported || isRunning}
                    aria-pressed={selected}
                    onClick={() => selectPreset(preset.id)}
                    className={`flex flex-col gap-3 rounded-xl border p-4 text-left transition-colors ${
                      selected
                        ? "border-primary bg-primary/20"
                        : "border-border bg-surface hover:border-border-strong"
                    } ${!supported ? "cursor-not-allowed opacity-45" : ""}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-semibold text-foreground">{preset.label}</span>
                      {preset.id === "balanced" ? (
                        <Badge variant="accent">Recommended</Badge>
                      ) : null}
                    </div>
                    <span className="text-xs text-subtle-foreground">{preset.description}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {preset.details}
                    </span>
                  </button>
                )
              })}
            </div>
            {!canStart ? (
              <p className="text-xs text-warning">
                Choose a compatible canvas or a positive range before starting this preset.
              </p>
            ) : null}
          </div>

          {selectedPreset === "selected-range" ? (
            <div className="mb-4 grid grid-cols-1 gap-4 rounded-xl border border-border bg-surface p-5 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-xs text-subtle-foreground">
                Range start (ms)
                <Input
                  type="number"
                  min={0}
                  max={Math.max(0, durationMs - 1)}
                  value={rangeStart}
                  onChange={(event) => updateRange(Number(event.target.value), rangeEnd)}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-xs text-subtle-foreground">
                Range end (ms)
                <Input
                  type="number"
                  min={1}
                  max={durationMs}
                  value={rangeEnd}
                  onChange={(event) => updateRange(rangeStart, Number(event.target.value))}
                />
              </label>
            </div>
          ) : null}

          <div className="mb-4 overflow-hidden rounded-xl border border-border bg-surface">
            <button
              type="button"
              onClick={() => setVideoAccordionOpen((previous) => !previous)}
              className="flex w-full items-center justify-between p-4 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:bg-overlay"
            >
              <span className="flex items-center gap-2 font-label">
                <Film className="size-4 text-track-screen" aria-hidden />
                Video and captions
              </span>
              {videoAccordionOpen ? (
                <ChevronUp className="size-4" />
              ) : (
                <ChevronDown className="size-4" />
              )}
            </button>
            {videoAccordionOpen ? (
              <div className="flex flex-col gap-5 border-t border-border p-5">
                <label className="flex flex-col gap-1.5 text-xs text-subtle-foreground">
                  Codec
                  <Select
                    value={exportSettings?.codec ?? "h264"}
                    onValueChange={(value) => onCodecChange?.(value as "h264" | "hevc")}
                    disabled={isRunning}
                  >
                    <SelectTrigger
                      aria-label="Export codec"
                      className="border-border bg-background text-xs text-foreground"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="h264">H.264 (AVC)</SelectItem>
                      <SelectItem value="hevc">H.265 (HEVC)</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                <label className="flex flex-col gap-1.5 text-xs text-subtle-foreground">
                  Encoder
                  <Select
                    value={exportSettings?.encoder ?? "auto"}
                    onValueChange={(value) => onEncoderChange?.(value as ExportEncoderPreference)}
                    disabled={isRunning}
                  >
                    <SelectTrigger
                      aria-label="Export encoder"
                      className="border-border bg-background text-xs text-foreground"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">Auto (hardware when available)</SelectItem>
                      <SelectItem value="software">Software (x264/x265)</SelectItem>
                    </SelectContent>
                  </Select>
                  {hardwareEncoderName ? (
                    <span className="flex items-center gap-1.5 text-[11px] text-subtle-foreground">
                      <Zap className="size-3 text-track-screen" aria-hidden />
                      {hardwareEncoderName} detected and will be used by Auto
                    </span>
                  ) : null}
                </label>
                <label className="flex flex-col gap-1.5 text-xs text-subtle-foreground">
                  Caption delivery
                  <Select
                    value={captionMode}
                    onValueChange={(value) => onCaptionModeChange?.(value as RenderCaptionMode)}
                    disabled={isRunning}
                  >
                    <SelectTrigger
                      aria-label="Caption output mode"
                      className="border-border bg-background text-xs text-foreground"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="burn-in">Burn into video</SelectItem>
                      <SelectItem value="sidecar">Write SRT sidecar</SelectItem>
                      <SelectItem value="none">Do not export captions</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                <p className="text-[11px] leading-relaxed text-subtle-foreground">
                  Canvas transforms, camera, cursor, captions, masks, audio fades, speed, and
                  timeline gaps are resolved from the saved project.
                </p>
              </div>
            ) : null}
          </div>

          <div className="overflow-hidden rounded-xl border border-border bg-surface">
            <button
              type="button"
              onClick={() => setChaptersAccordionOpen((previous) => !previous)}
              className="flex w-full items-center justify-between p-4 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:bg-overlay"
            >
              <span className="flex items-center gap-2 font-label">
                <Bookmark className="size-4 text-primary" aria-hidden />
                Chapters and Markers
              </span>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px] font-normal">
                  {markers.length} {markers.length === 1 ? "marker" : "markers"}
                </Badge>
                {chaptersAccordionOpen ? (
                  <ChevronUp className="size-4" />
                ) : (
                  <ChevronDown className="size-4" />
                )}
              </div>
            </button>
            {chaptersAccordionOpen ? (
              <div className="flex flex-col gap-5 border-t border-border p-5">
                <label className="flex flex-col gap-1.5 text-xs text-subtle-foreground">
                  Chapter delivery
                  <Select
                    value={chapterMode}
                    onValueChange={(value) => onChapterModeChange?.(value as RenderChapterMode)}
                    disabled={isRunning}
                  >
                    <SelectTrigger
                      aria-label="Chapter export mode"
                      className="border-border bg-background text-xs text-foreground"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="embed">Embed in MP4 metadata (Recommended)</SelectItem>
                      <SelectItem value="sidecar">
                        Write YouTube chapter file (.chapters.txt)
                      </SelectItem>
                      <SelectItem value="both">Embed MP4 & write YouTube chapter file</SelectItem>
                      <SelectItem value="none">Do not export chapters</SelectItem>
                    </SelectContent>
                  </Select>
                </label>

                {youtubeChapterText ? (
                  <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-dim p-3.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-foreground">
                        YouTube Timestamps
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1.5 text-xs"
                        onClick={() => void handleCopyYouTubeChapters()}
                      >
                        {copiedTimestamps ? (
                          <>
                            <Check className="size-3.5 text-success" />
                            <span>Copied</span>
                          </>
                        ) : (
                          <>
                            <Copy className="size-3.5" />
                            <span>Copy timestamps</span>
                          </>
                        )}
                      </Button>
                    </div>
                    <pre className="max-h-36 overflow-y-auto whitespace-pre-wrap rounded border border-border/60 bg-background p-2.5 font-mono text-[11px] text-subtle-foreground select-text">
                      {youtubeChapterText}
                    </pre>
                    <p className="text-[11px] text-muted-foreground">
                      Paste these timestamps into your YouTube video description to enable YouTube
                      video chapters.
                    </p>
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-border bg-surface-dim p-3.5 text-xs text-subtle-foreground">
                    No markers found on timeline. Add markers (using the Marker tool or
                    &quot;M&quot; shortcut) to generate chapter marks and YouTube timestamps.
                  </div>
                )}
              </div>
            ) : null}
          </div>

          <div className="overflow-hidden rounded-xl border border-border bg-surface">
            <button
              type="button"
              onClick={() => setAudioAccordionOpen((previous) => !previous)}
              className="flex w-full items-center justify-between p-4 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:bg-overlay"
            >
              <span className="flex items-center gap-2 font-label">
                <Pause className="size-4 text-track-mic" aria-hidden />
                Audio
              </span>
              {audioAccordionOpen ? (
                <ChevronUp className="size-4" />
              ) : (
                <ChevronDown className="size-4" />
              )}
            </button>
            {audioAccordionOpen ? (
              <div className="border-t border-border p-5 text-xs text-subtle-foreground">
                Audio tracks use the saved mute, solo, gain, fade, role, and speed settings.
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="shrink-0 border-t border-border bg-background/95 px-8 py-3 shadow-2xl backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
          <div className="flex min-w-0 flex-col">
            <span className="text-[10px] font-label font-bold uppercase tracking-wider text-subtle-foreground">
              Summary
            </span>
            <span className="truncate font-mono text-xs font-semibold text-foreground">
              {projectName} ·{" "}
              {canvas ? `${canvas.width}×${canvas.height} · ${canvas.fps}fps` : "Source canvas"} ·{" "}
              {exportSettings?.codec?.toUpperCase() ?? "H264"}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <Button variant="secondary" onClick={onBack} disabled={isRunning}>
              Back to editor
            </Button>
            <Button
              onClick={() => void handleStartExport()}
              disabled={isStarting || isRunning || !canStart}
            >
              <Play className="mr-2 size-3.5 fill-current" aria-hidden />
              {isStarting
                ? "Choosing destination…"
                : isRunning
                  ? `Exporting ${progress}%`
                  : "Choose destination"}
            </Button>
          </div>
        </div>
      </div>

      <UploadDialog
        open={uploadDialogOpen}
        onOpenChange={setUploadDialogOpen}
        localPath={exportJob?.outputs?.outputPath ?? ""}
        exportId={exportJob?.id}
        defaultName={`${projectName ?? "export"}.mp4`}
      />
    </div>
  )
}
