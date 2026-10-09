import { useEffect, useState } from "react"
import { Sparkles } from "lucide-react"
import { createImportCaptionCuesCommand } from "@recordforge/editor-core"
import type {
  AiCaptionsSetupProgress,
  AiCaptionsStatus,
  CaptionCue,
  CaptionPlacement,
  CaptionStylePreset,
} from "@recordforge/contracts"
import { Button, NativeSelect, Progress, useToast } from "@recordforge/ui"
import { useLicenseStore } from "../../../stores/license-store"
import { useTimelineStore } from "../../../stores/timeline-store"
import { ProBadge } from "../../licensing/pro-badge"
import {
  deleteAiCaptionsModel,
  downloadAiCaptionsEngine,
  getAiCaptionsStatus,
  onAiCaptionsSetupProgress,
  transcribeCaptions,
} from "../../../lib/captions"
import { formatFileSize } from "../../../lib/format"

// Remember the last model the user picked so repeat sessions keep their
// quality preference; falls back to Base on first run.
const MODEL_STORAGE_KEY = "recordforge.aiCaptions.model"

interface AiCaptionsCardProps {
  style: CaptionStylePreset
  placement: CaptionPlacement
}

export function AiCaptionsCard({ style, placement }: AiCaptionsCardProps) {
  const recording = useTimelineStore((state) => state.recording)
  const execute = useTimelineStore((state) => state.execute)
  const isPro = useLicenseStore((state) => state.status.tier === "pro")
  const openUpgradeDialog = useLicenseStore((state) => state.openUpgradeDialog)
  const { toast } = useToast()

  const [status, setStatus] = useState<AiCaptionsStatus | null>(null)
  const [modelId, setModelId] = useState(() => localStorage.getItem(MODEL_STORAGE_KEY) ?? "base")
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState<AiCaptionsSetupProgress | null>(null)
  const [transcribing, setTranscribing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getAiCaptionsStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [])

  useEffect(() => {
    if (!downloading) return
    let unlisten: (() => void) | undefined
    onAiCaptionsSetupProgress((next) => setProgress(next)).then((fn) => {
      unlisten = fn
    })
    return () => unlisten?.()
  }, [downloading])

  if (!status) return null
  // No engine download exists for this platform yet (macOS, Windows ARM64) —
  // show a quiet note instead of a gate until we ship binaries there.
  if (!status.supported) {
    return (
      <p className="rounded-lg border border-dashed border-border bg-surface-dim p-3 text-[11px] leading-relaxed text-subtle-foreground">
        AI Captions — on-device transcription — is coming to this platform soon.
      </p>
    )
  }

  const model = status.models.find((m) => m.id === modelId) ?? status.models[0]
  const modelReady = model.downloaded

  function selectModel(id: string) {
    setModelId(id)
    localStorage.setItem(MODEL_STORAGE_KEY, id)
  }

  function gate(): boolean {
    if (isPro) return false
    openUpgradeDialog(["ai-captions"])
    return true
  }

  async function handleDownload() {
    if (gate()) return
    setDownloading(true)
    setError(null)
    setProgress(null)
    try {
      await downloadAiCaptionsEngine(model.id)
      setStatus(await getAiCaptionsStatus())
      toast({ title: "Speech engine ready", variant: "success" })
    } catch (err) {
      setError(err instanceof Error ? err.message : "The engine download failed.")
    } finally {
      setDownloading(false)
    }
  }

  async function handleDeleteModel() {
    if (gate()) return
    setError(null)
    try {
      await deleteAiCaptionsModel(model.id)
      setStatus(await getAiCaptionsStatus())
      toast({ title: `${model.label.split(" ")[0]} model removed` })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove the model.")
    }
  }

  async function handleTranscribe() {
    if (gate() || !recording) return
    setTranscribing(true)
    setError(null)
    try {
      const cues: CaptionCue[] = await transcribeCaptions(recording.id, model.id)
      if (cues.length === 0) {
        toast({
          title: "No speech detected",
          description: "The recording's audio produced no captions.",
        })
        return
      }
      const applied = execute(
        createImportCaptionCuesCommand(cues, { style, placement, trackName: "AI Captions" }),
      )
      toast(
        applied
          ? {
              title: "Captions generated",
              description: `${cues.length} cues added to the captions track.`,
              variant: "success",
            }
          : {
              title: "Captions could not be imported",
              description: "Unlock the captions track, then try again.",
              variant: "error",
            },
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transcription failed.")
    } finally {
      setTranscribing(false)
    }
  }

  const percent =
    progress && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))
      : null
  const needsBinary = !status.binaryReady
  const busy = downloading || transcribing

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface p-3">
      <span className="flex items-center gap-2 text-xs font-semibold text-foreground">
        <Sparkles className="size-3.5 text-primary" aria-hidden />
        AI Captions
        {!isPro ? <ProBadge /> : null}
      </span>
      <p className="text-[11px] leading-relaxed text-subtle-foreground">
        Transcribe the recording&apos;s audio on-device — nothing is uploaded.
      </p>

      <NativeSelect
        size="sm"
        aria-label="Speech model"
        value={model.id}
        disabled={busy}
        onChange={(event) => selectModel(event.target.value)}
      >
        {status.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label} — {formatFileSize(m.sizeBytes)}
            {m.downloaded ? " (downloaded)" : ""}
          </option>
        ))}
      </NativeSelect>

      {error ? (
        <p className="text-[11px] font-medium text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {downloading ? (
        <div className="flex flex-col gap-1.5">
          <Progress value={percent ?? 0} />
          <span className="text-[11px] text-subtle-foreground">
            Downloading {progress?.stage === "model" ? "speech model" : "engine"}…
            {progress && progress.downloadedBytes > 0
              ? ` ${formatFileSize(progress.downloadedBytes)}`
              : ""}
          </span>
        </div>
      ) : needsBinary || !modelReady ? (
        <Button variant="outline" size="sm" onClick={handleDownload}>
          {needsBinary
            ? `Download engine + ${model.label.split(" ")[0]} (~${formatFileSize(model.sizeBytes)})`
            : `Download ${model.label.split(" ")[0]} model (${formatFileSize(model.sizeBytes)})`}
        </Button>
      ) : (
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={handleTranscribe} disabled={transcribing || !recording}>
            {transcribing ? "Transcribing…" : "Transcribe audio"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-subtle-foreground"
            onClick={handleDeleteModel}
            disabled={busy}
          >
            Remove model
          </Button>
        </div>
      )}
    </div>
  )
}
