import { useEffect, useMemo, useState } from "react"
import type {
  ExportPreset,
  MediaJob,
  ProjectExportSettings,
  TimelineCanvas,
} from "@recordforge/contracts"
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Clock,
  Cloud,
  FolderOpen,
  Gauge,
  RotateCcw,
  Sparkles,
  Square,
  Timer,
} from "lucide-react"
import { Badge, Button } from "@recordforge/ui"

export interface ExportProgressCardProps {
  job: MediaJob
  projectName?: string
  canvas?: TimelineCanvas
  durationMs?: number
  exportSettings?: ProjectExportSettings
  hardwareEncoderName?: string | null
  selectedPreset?: ExportPreset
  onCancel?: () => void
  onRetry?: () => void
  onReveal?: () => void
  onUploadCloud?: () => void
  onDismiss?: () => void
}

type PipelineStageId = "prepare" | "render" | "finalize" | "ready"

interface PipelineStageConfig {
  id: PipelineStageId
  label: string
  description: string
}

const PIPELINE_STAGES: PipelineStageConfig[] = [
  { id: "prepare", label: "Prepare", description: "Resolving assets & probing encoder" },
  { id: "render", label: "Render", description: "Compositing video, audio & effects" },
  { id: "finalize", label: "Finalize", description: "Writing metadata & verifying output" },
  { id: "ready", label: "Ready", description: "Validated & published" },
]

// Map the granular backend stage strings to high-level pipeline stages
export function resolvePipelineStage(status: string, stage: string): PipelineStageId {
  if (status === "completed") return "ready"
  if (stage === "starting" || stage === "queued" || stage === "resolving-assets") {
    return "prepare"
  }
  if (stage === "captions" || stage === "chapters" || stage === "validating") {
    return "finalize"
  }
  return "render"
}

// Stage descriptive titles for the live header
export const STAGE_TITLES: Record<string, string> = {
  starting: "Initializing export pipeline",
  queued: "Preparing export",
  "resolving-assets": "Resolving project assets",
  rendering: "Rendering & encoding timeline",
  cursor: "Rasterizing cursor overlays",
  captions: "Generating caption sidecar",
  chapters: "Writing YouTube chapter markers",
  validating: "Validating output with FFprobe",
  completed: "Export completed successfully",
  failed: "Export process failed",
  cancelled: "Export cancelled",
}

export function formatTime(totalSeconds: number): string {
  const rounded = Math.max(0, Math.floor(totalSeconds))
  const minutes = Math.floor(rounded / 60)
  const seconds = rounded % 60
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
}

export function formatEta(remainingSeconds: number | null): string {
  if (remainingSeconds === null) return "Estimating…"
  if (remainingSeconds <= 0) return "Finishing…"
  if (remainingSeconds < 60) return `~${remainingSeconds}s left`
  const mins = Math.floor(remainingSeconds / 60)
  const secs = remainingSeconds % 60
  return secs > 0 ? `~${mins}m ${secs}s left` : `~${mins}m left`
}

export function formatPresetLabel(preset?: ExportPreset): string | null {
  if (!preset) return null
  return preset
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

export function ExportProgressCard({
  job,
  projectName = "Recording",
  canvas,
  durationMs = 0,
  exportSettings,
  hardwareEncoderName,
  selectedPreset,
  onCancel,
  onRetry,
  onReveal,
  onUploadCloud,
  onDismiss,
}: ExportProgressCardProps) {
  const isRunning = job.status === "running" || job.status === "pending"
  const isCompleted = job.status === "completed"
  const isFailed = job.status === "failed"

  // Live timer ticking state (in seconds)
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(() => {
    if (!job.startedAt) return 0
    const start = new Date(job.startedAt).getTime()
    return Math.max(0, Math.floor((Date.now() - start) / 1000))
  })

  useEffect(() => {
    if (!isRunning) {
      if (job.startedAt && job.completedAt) {
        const start = new Date(job.startedAt).getTime()
        const end = new Date(job.completedAt).getTime()
        if (end >= start) {
          setElapsedSeconds(Math.max(1, Math.round((end - start) / 1000)))
        }
      }
      return
    }

    const startTimestamp = job.startedAt ? new Date(job.startedAt).getTime() : Date.now()
    const updateElapsed = () => {
      const now = Date.now()
      setElapsedSeconds(Math.max(0, Math.floor((now - startTimestamp) / 1000)))
    }

    updateElapsed()
    const interval = window.setInterval(updateElapsed, 1000)
    return () => window.clearInterval(interval)
  }, [isRunning, job.startedAt, job.completedAt])

  // Progress percentage (clamped 0 to 100)
  const rawProgress = isCompleted ? 1 : (job.progress ?? 0)
  const percent = Math.min(100, Math.max(0, Math.round(rawProgress * 100)))
  const currentPipelineStage = resolvePipelineStage(job.status, job.stage)

  // Estimated Time Remaining (ETA)
  const etaSeconds = useMemo<number | null>(() => {
    if (!isRunning) return null
    // Avoid erratic ETA spikes during initial startup
    if (elapsedSeconds < 3 || rawProgress < 0.05) return null
    if (rawProgress >= 0.99) return 0

    // Remaining seconds = (elapsed / progress) - elapsed
    const estimatedTotal = elapsedSeconds / rawProgress
    const remaining = Math.max(0, Math.round(estimatedTotal - elapsedSeconds))
    return remaining
  }, [isRunning, elapsedSeconds, rawProgress])

  // Real-time render speed multiplier (e.g. 2.1x real-time)
  const speedMultiplier = useMemo<string | null>(() => {
    if (!durationMs || durationMs <= 0 || elapsedSeconds < 2 || rawProgress <= 0.02) {
      return null
    }
    const renderedTimelineSeconds = (durationMs * rawProgress) / 1000
    const speed = renderedTimelineSeconds / elapsedSeconds
    if (!Number.isFinite(speed) || speed <= 0) return null
    return `${speed.toFixed(1)}×`
  }, [durationMs, elapsedSeconds, rawProgress])

  // Active stage display description
  const stageHeader =
    STAGE_TITLES[job.stage] ??
    (isRunning ? "Rendering timeline" : isCompleted ? "Export complete" : job.stage)

  // Target format and encoder summary
  const containerBadge = (exportSettings?.container ?? "mp4").toUpperCase()
  const encoderSummary = hardwareEncoderName
    ? `${hardwareEncoderName} (Hardware)`
    : exportSettings?.encoder === "software"
      ? "Software (libx264)"
      : "Auto Encoder"

  return (
    <div
      className="mb-8 overflow-hidden rounded-xl border border-border bg-surface shadow-e2 transition-all"
      role="status"
      aria-live="polite"
    >
      {/* Top Header Row */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border/60 bg-surface-dim/70 px-5 py-3.5">
        <div className="flex items-center gap-3">
          {/* Status Indicator Badge */}
          {isRunning ? (
            <div className="flex items-center gap-2 rounded-full border border-primary/40 bg-primary/15 px-3 py-1 text-xs font-semibold text-primary">
              <span className="relative flex size-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-primary" />
              </span>
              <span>Exporting</span>
            </div>
          ) : isCompleted ? (
            <div className="flex items-center gap-1.5 rounded-full border border-success/40 bg-success/15 px-3 py-1 text-xs font-semibold text-success">
              <CheckCircle2 className="size-3.5" aria-hidden />
              <span>Complete</span>
            </div>
          ) : isFailed ? (
            <div className="flex items-center gap-1.5 rounded-full border border-recording/40 bg-recording/15 px-3 py-1 text-xs font-semibold text-recording">
              <AlertCircle className="size-3.5" aria-hidden />
              <span>Failed</span>
            </div>
          ) : (
            <Badge variant="outline">Cancelled</Badge>
          )}

          <div>
            <h2 className="text-sm font-semibold tracking-tight text-foreground font-display">
              {stageHeader}
            </h2>
            <p className="text-xs text-subtle-foreground">
              {job.message ||
                (isCompleted ? `Saved as ${containerBadge} video` : `Exporting ${projectName}`)}
            </p>
          </div>
        </div>

        {/* Large Monospace Percentage & Metrics */}
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="font-mono text-3xl font-bold tracking-tight text-foreground">
              {percent}
              <span className="text-lg font-normal text-subtle-foreground">%</span>
            </div>
            <div className="flex items-center justify-end gap-1.5 text-[11px] text-muted-foreground font-mono">
              {isRunning && etaSeconds !== null ? (
                <span>{formatEta(etaSeconds)}</span>
              ) : isCompleted ? (
                <span className="text-success">Finished</span>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {/* Main Body */}
      <div className="p-5">
        {/* Modern Progress Bar */}
        <div className="relative mb-5">
          <div
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            className="relative h-3 w-full overflow-hidden rounded-full bg-overlay border border-border/60"
          >
            <div
              className={`h-full rounded-full transition-[width] duration-300 ease-forge relative ${
                isCompleted
                  ? "bg-gradient-to-r from-emerald-500 to-success shadow-[0_0_12px_rgba(16,185,129,0.3)]"
                  : isFailed
                    ? "bg-recording"
                    : "bg-gradient-to-r from-primary via-blue-500 to-accent shadow-[0_0_12px_rgba(217,119,6,0.3)]"
              }`}
              style={{ width: `${percent}%` }}
            >
              {/* Shimmer sweep animation overlay during active render */}
              {isRunning ? (
                <div
                  className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-pulse"
                  aria-hidden
                />
              ) : null}
            </div>
          </div>
        </div>

        {/* Live Metrics Grid */}
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {/* Elapsed Time */}
          <div className="flex items-center gap-2.5 rounded-lg border border-border/60 bg-surface-dim/40 px-3 py-2 text-xs">
            <Clock className="size-4 shrink-0 text-subtle-foreground" aria-hidden />
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-subtle-foreground font-label">
                Elapsed
              </div>
              <div className="font-mono font-medium text-foreground">
                {formatTime(elapsedSeconds)}
              </div>
            </div>
          </div>

          {/* Remaining ETA */}
          <div className="flex items-center gap-2.5 rounded-lg border border-border/60 bg-surface-dim/40 px-3 py-2 text-xs">
            <Timer className="size-4 shrink-0 text-subtle-foreground" aria-hidden />
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-subtle-foreground font-label">
                Remaining
              </div>
              <div className="font-mono font-medium text-foreground">
                {isCompleted ? "00:00" : formatEta(etaSeconds)}
              </div>
            </div>
          </div>

          {/* Render Speed Multiplier */}
          <div className="flex items-center gap-2.5 rounded-lg border border-border/60 bg-surface-dim/40 px-3 py-2 text-xs">
            <Gauge className="size-4 shrink-0 text-subtle-foreground" aria-hidden />
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-subtle-foreground font-label">
                Render Speed
              </div>
              <div className="font-mono font-medium text-foreground">
                {speedMultiplier ?? (isRunning ? "Calculating…" : "—")}
              </div>
            </div>
          </div>

          {/* Encoder Specs */}
          <div className="flex items-center gap-2.5 rounded-lg border border-border/60 bg-surface-dim/40 px-3 py-2 text-xs">
            <Sparkles className="size-4 shrink-0 text-accent" aria-hidden />
            <div className="min-w-0 truncate">
              <div className="text-[10px] uppercase tracking-wider text-subtle-foreground font-label truncate">
                Encoder
              </div>
              <div className="truncate font-medium text-foreground" title={encoderSummary}>
                {hardwareEncoderName ?? "Software"}
              </div>
            </div>
          </div>
        </div>

        {/* 4-Stage Pipeline Stepper */}
        <div className="mb-5 rounded-lg border border-border/50 bg-surface-dim/30 p-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-subtle-foreground font-label">
            Pipeline Progress
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {PIPELINE_STAGES.map((stageItem, index) => {
              const stageOrder: PipelineStageId[] = ["prepare", "render", "finalize", "ready"]
              const currentIndex = stageOrder.indexOf(currentPipelineStage)
              const stageItemIndex = stageOrder.indexOf(stageItem.id)

              const isStageDone = isCompleted || stageItemIndex < currentIndex
              const isStageActive = isRunning && stageItem.id === currentPipelineStage

              return (
                <div
                  key={stageItem.id}
                  className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors ${
                    isStageActive
                      ? "border border-accent/40 bg-accent/10 text-foreground font-medium"
                      : isStageDone
                        ? "text-muted-foreground"
                        : "text-subtle-foreground/60 opacity-60"
                  }`}
                >
                  <div
                    className={`flex size-4 shrink-0 items-center justify-center rounded-full text-[10px] ${
                      isStageDone
                        ? "bg-success text-background font-bold"
                        : isStageActive
                          ? "bg-accent text-accent-foreground animate-pulse font-bold"
                          : "border border-border bg-overlay text-subtle-foreground"
                    }`}
                  >
                    {isStageDone ? (
                      <Check className="size-2.5 stroke-[3]" aria-hidden />
                    ) : (
                      index + 1
                    )}
                  </div>
                  <div className="min-w-0 truncate">
                    <span className="truncate">{stageItem.label}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Target Format & Specs Badges */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-3 text-xs text-subtle-foreground">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="font-mono text-[11px] leading-none">
              {containerBadge}
            </Badge>
            {canvas ? (
              <Badge variant="outline" className="font-mono text-[11px] leading-none">
                {canvas.width}×{canvas.height} @ {canvas.fps}fps
              </Badge>
            ) : null}
            {selectedPreset ? (
              <Badge variant="outline" className="text-[11px] leading-none">
                {formatPresetLabel(selectedPreset)}
              </Badge>
            ) : null}
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-2">
            {isRunning && onCancel ? (
              <Button
                variant="secondary"
                size="sm"
                className="gap-1.5 hover:border-recording/50 hover:text-recording"
                onClick={onCancel}
              >
                <Square className="size-3.5 fill-current" aria-hidden />
                Cancel export
              </Button>
            ) : null}

            {isCompleted ? (
              <>
                {onReveal ? (
                  <Button variant="ghost" size="sm" className="gap-1.5" onClick={onReveal}>
                    <FolderOpen className="size-4" aria-hidden />
                    Reveal file
                  </Button>
                ) : null}
                {onUploadCloud ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 border-primary/40 text-primary hover:bg-primary/10"
                    onClick={onUploadCloud}
                  >
                    <Cloud className="size-4" aria-hidden />
                    Upload to Cloud
                  </Button>
                ) : null}
                {onDismiss ? (
                  <Button variant="secondary" size="sm" onClick={onDismiss}>
                    Done
                  </Button>
                ) : null}
              </>
            ) : null}

            {isFailed && onRetry ? (
              <Button variant="secondary" size="sm" className="gap-1.5" onClick={onRetry}>
                <RotateCcw className="size-3.5" aria-hidden />
                Retry export
              </Button>
            ) : null}
          </div>
        </div>

        {/* Failure Error Message Details */}
        {isFailed && job.error ? (
          <div
            className="mt-3 flex items-start gap-2.5 rounded-lg border border-recording/30 bg-recording/10 p-3 text-xs text-recording"
            role="alert"
          >
            <AlertCircle className="size-4 shrink-0 mt-0.5" aria-hidden />
            <div className="min-w-0 flex-1">
              <span className="font-semibold">Export error: </span>
              <span>{job.error}</span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
