import { useEffect, useMemo, useRef, useState } from "react"
import { Sparkles } from "lucide-react"
import {
  analyzeCaptionSync,
  buildCaptionCuesFromTranscript,
  createImportCaptionCuesCommand,
  listCaptionAudioSources,
  pickDefaultCaptionSource,
  resolveCaptionDesign,
  type CaptionAudioSource,
  type CaptionCueBuildResult,
} from "@recordforge/editor-core"
import {
  DEFAULT_CAPTION_DESIGN,
  type AiCaptionsProgress,
  type AiCaptionsSetupProgress,
  type AiCaptionsStatus,
  type AudioRole,
  type Transcript,
} from "@recordforge/contracts"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  buttonVariants,
  NativeSelect,
  Progress,
  Skeleton,
  useToast,
} from "@recordforge/ui"
import { useLicenseStore } from "../../../stores/license-store"
import { useTimelineStore } from "../../../stores/timeline-store"
import { ProBadge } from "../../licensing/pro-badge"
import {
  cancelTranscription,
  deleteAiCaptionsModel,
  downloadAiCaptionsEngine,
  getAiCaptionsStatus,
  onAiCaptionsProgress,
  onAiCaptionsSetupProgress,
  transcribeAudio,
} from "../../../lib/captions"
import { toErrorMessage } from "../../../lib/errors"
import { formatFileSize } from "../../../lib/format"

// Remember the last model the user picked so repeat sessions keep their
// quality preference; falls back to Base on first run.
const MODEL_STORAGE_KEY = "recordforge.aiCaptions.model"
const LANGUAGE_STORAGE_KEY = "recordforge.aiCaptions.language"

const LANGUAGES: { value: string; label: string }[] = [
  { value: "auto", label: "Auto-detect" },
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "it", label: "Italiano" },
  { value: "pt", label: "Português" },
  { value: "nl", label: "Nederlands" },
  { value: "pl", label: "Polski" },
  { value: "sv", label: "Svenska" },
  { value: "tr", label: "Türkçe" },
  { value: "ru", label: "Русский" },
  { value: "uk", label: "Українська" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "zh", label: "中文" },
  { value: "hi", label: "हिन्दी" },
  { value: "vi", label: "Tiếng Việt" },
  { value: "id", label: "Bahasa Indonesia" },
]

const ROLE_LABELS: Record<AudioRole, string> = {
  microphone: "Microphone",
  system_audio: "System audio",
  music: "Music",
  other: "Audio",
}

/** Stable identity for one audio source across timeline re-renders. */
function captionSourceKey(source: CaptionAudioSource): string {
  return `${source.trackId}:${source.streamIndex ?? "default"}`
}

function captionSourceLabel(source: CaptionAudioSource): string {
  const role = source.role ? ROLE_LABELS[source.role] : "Audio"
  return `${source.trackName} · ${role}${source.muted ? " (muted)" : ""}`
}

/** `transcribe_audio` rejects with this code when cancel wins the race. */
function isCancelledError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "transcription_cancelled"
  )
}

type EngineState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; status: AiCaptionsStatus }

interface PendingImport {
  result: CaptionCueBuildResult
  transcript: Transcript
  existingCount: number
  /** `language` at run start — captured so a mid-dialog select change can't skew the toast. */
  autoDetect: boolean
}

export function AiCaptionsCard() {
  const recording = useTimelineStore((state) => state.recording)
  const timeline = useTimelineStore((state) => state.engine?.history.present)
  const captionTrack = useTimelineStore((state) =>
    state.engine?.history.present.tracks.find((track) => track.kind === "captions"),
  )
  const execute = useTimelineStore((state) => state.execute)
  const isPro = useLicenseStore((state) => state.status.tier === "pro")
  const openUpgradeDialog = useLicenseStore((state) => state.openUpgradeDialog)
  const { toast } = useToast()

  const [engine, setEngine] = useState<EngineState>({ phase: "loading" })
  const [statusNonce, setStatusNonce] = useState(0)
  const [modelId, setModelId] = useState(() => localStorage.getItem(MODEL_STORAGE_KEY) ?? "base")
  const [language, setLanguage] = useState(() => {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY)
    return stored !== null && LANGUAGES.some((entry) => entry.value === stored) ? stored : "auto"
  })
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState<AiCaptionsSetupProgress | null>(null)
  const [transcribing, setTranscribing] = useState(false)
  const [runProgress, setRunProgress] = useState<AiCaptionsProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [emptyResult, setEmptyResult] = useState<{ droppedWords: number } | null>(null)
  // Import payload persists after the dialog closes so the exit animation
  // doesn't re-render with cleared data.
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null)
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [sourceKey, setSourceKey] = useState<string | null>(null)
  // Live job handle so unmount can cancel + unsubscribe mid-run.
  const jobRef = useRef<{ jobId: string; unlisten: () => void; cancelled: boolean } | null>(null)

  // Four-state status fetch — bumping the nonce is how Retry re-arms it.
  useEffect(() => {
    let cancelled = false
    getAiCaptionsStatus()
      .then((status) => {
        if (!cancelled) setEngine({ phase: "ready", status })
      })
      .catch((err) => {
        if (!cancelled) setEngine({ phase: "error", message: toErrorMessage(err) })
      })
    return () => {
      cancelled = true
    }
  }, [statusNonce])

  useEffect(() => {
    if (!downloading) return
    let unlisten: (() => void) | undefined
    onAiCaptionsSetupProgress((next) => setProgress(next)).then((fn) => {
      unlisten = fn
    })
    return () => unlisten?.()
  }, [downloading])

  // Unmount mid-run: stop the whisper job and drop the progress listener.
  useEffect(() => {
    return () => {
      const job = jobRef.current
      jobRef.current = null
      if (job) {
        job.cancelled = true
        job.unlisten()
        void cancelTranscription(job.jobId).catch(() => {})
      }
    }
  }, [])

  const sources = useMemo(
    () => (timeline && recording ? listCaptionAudioSources(timeline, recording.id) : []),
    [timeline, recording],
  )
  // An explicit pick wins; otherwise the audible-mic heuristic, otherwise the
  // first entry (a muted source is still transcribable from the file).
  const source =
    sources.find((entry) => captionSourceKey(entry) === sourceKey) ??
    pickDefaultCaptionSource(sources) ??
    sources[0] ??
    null

  // Staleness signal for the regenerate nudge: displaced/dropped AI cues
  // mean the audio moved under them since the last run. Memoized on the
  // timeline — the analysis is a cheap word-level pass.
  const staleCount = useMemo(() => {
    if (!timeline || !captionTrack) return 0
    const report = analyzeCaptionSync(timeline, captionTrack)
    return report.displaced + report.dropped
  }, [timeline, captionTrack])
  // Cues without container-time provenance are manual — a regenerate
  // replaces them too, so the dialog warns about them explicitly.
  const manualCueCount = useMemo(
    () =>
      captionTrack?.clips.filter((clip) => clip.kind === "caption" && !clip.sourceWords).length ??
      0,
    [captionTrack],
  )

  if (engine.phase === "loading") {
    return (
      <div
        className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface p-3"
        aria-busy="true"
        aria-label="AI Captions is loading"
      >
        <span className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <Sparkles className="size-3.5 text-primary" aria-hidden />
          AI Captions
          {!isPro ? <ProBadge /> : null}
        </span>
        <Skeleton className="h-3 w-4/5" />
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-8 w-36" />
      </div>
    )
  }

  if (engine.phase === "error") {
    return (
      <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface p-3">
        <span className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <Sparkles className="size-3.5 text-primary" aria-hidden />
          AI Captions
          {!isPro ? <ProBadge /> : null}
        </span>
        <p className="text-[11px] font-medium text-destructive" role="alert">
          {engine.message}
        </p>
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setEngine({ phase: "loading" })
              setStatusNonce((nonce) => nonce + 1)
            }}
          >
            Retry
          </Button>
        </div>
      </div>
    )
  }

  const status = engine.status
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
  const canvas = timeline?.canvas

  function selectModel(id: string) {
    setModelId(id)
    localStorage.setItem(MODEL_STORAGE_KEY, id)
  }

  function selectLanguage(value: string) {
    setLanguage(value)
    localStorage.setItem(LANGUAGE_STORAGE_KEY, value)
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
      setEngine({ phase: "ready", status: await getAiCaptionsStatus() })
      toast({ title: "Speech engine ready", variant: "success" })
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setDownloading(false)
    }
  }

  async function handleDeleteModel() {
    if (gate()) return
    setError(null)
    try {
      await deleteAiCaptionsModel(model.id)
      setEngine({ phase: "ready", status: await getAiCaptionsStatus() })
      toast({ title: `${model.label.split(" ")[0]} model removed` })
    } catch (err) {
      setError(toErrorMessage(err))
    }
  }

  function importResult(
    result: CaptionCueBuildResult,
    transcript: Transcript,
    mode: "append" | "replace",
    autoDetect = language === "auto",
  ) {
    // Cue words ride onto the imported clips automatically.
    const applied = execute(
      createImportCaptionCuesCommand(result.cues, { mode, trackName: "AI Captions" }),
    )
    if (!applied) {
      toast({
        title: "Captions could not be imported",
        description: "Unlock the captions track, then try again.",
        variant: "error",
      })
      return
    }
    const notes: string[] = []
    if (result.droppedWords > 0) {
      notes.push(`words outside the timeline skipped: ${result.droppedWords}`)
    }
    if (transcript.cached) notes.push("from cache")
    if (autoDetect) notes.push(`detected: ${result.language}`)
    toast({
      title: `${result.cues.length} captions added`,
      ...(notes.length > 0 ? { description: notes.join(" · ") } : {}),
      variant: "success",
    })
  }

  async function handleTranscribe() {
    if (gate() || !recording || !timeline || !canvas || !source) return
    const jobId = crypto.randomUUID()
    setTranscribing(true)
    setError(null)
    setEmptyResult(null)
    setPendingImport(null)
    setRunProgress(null)
    // The listener must be live BEFORE the invoke — cached transcripts and the
    // preparing phase can complete ahead of the first event otherwise.
    let unlisten: () => void
    try {
      unlisten = await onAiCaptionsProgress((next) => {
        if (next.jobId === jobId) setRunProgress(next)
      })
    } catch (err) {
      setError(toErrorMessage(err))
      setTranscribing(false)
      return
    }
    const job = { jobId, unlisten, cancelled: false }
    jobRef.current = job
    try {
      const transcript = await transcribeAudio({
        jobId,
        recordingId: recording.id,
        model: model.id,
        language,
        streamIndex: source.streamIndex ?? undefined,
        force: false,
      })
      const design = captionTrack ? resolveCaptionDesign(captionTrack) : DEFAULT_CAPTION_DESIGN
      const result = buildCaptionCuesFromTranscript({
        transcript,
        timeline,
        canvas,
        design,
        streamIndex: source.streamIndex ?? undefined,
      })
      if (result.cues.length === 0) {
        setEmptyResult({ droppedWords: result.droppedWords })
        return
      }
      const existingCount =
        captionTrack?.clips.filter((clip) => clip.kind === "caption").length ?? 0
      if (existingCount > 0) {
        setPendingImport({ result, transcript, existingCount, autoDetect: language === "auto" })
        setImportDialogOpen(true)
        return
      }
      importResult(result, transcript, "append")
    } catch (err) {
      if (job.cancelled || isCancelledError(err)) {
        toast({ title: "Transcription cancelled" })
      } else {
        setError(toErrorMessage(err))
      }
    } finally {
      unlisten()
      if (jobRef.current === job) jobRef.current = null
      setTranscribing(false)
      setRunProgress(null)
    }
  }

  function handleCancelTranscribe() {
    const job = jobRef.current
    if (!job) return
    job.cancelled = true
    void cancelTranscription(job.jobId).catch(() => {})
  }

  // Retry re-arms whichever action the current engine state needs.
  function retryLast() {
    if (needsBinary || !modelReady) void handleDownload()
    else void handleTranscribe()
  }

  const percent =
    progress && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))
      : null
  const needsBinary = !status.binaryReady
  const busy = downloading || transcribing
  const phaseLabel =
    !runProgress || runProgress.phase === "preparing"
      ? "Preparing audio…"
      : runProgress.phase === "transcribing"
        ? `Transcribing… ${Math.round(runProgress.percent)}%`
        : "Finalizing…"

  return (
    <>
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

        {sources.length > 1 ? (
          <NativeSelect
            size="sm"
            aria-label="Audio source"
            value={source ? captionSourceKey(source) : ""}
            disabled={busy}
            onChange={(event) => setSourceKey(event.target.value)}
          >
            {sources.map((entry) => (
              <option key={captionSourceKey(entry)} value={captionSourceKey(entry)}>
                {captionSourceLabel(entry)}
              </option>
            ))}
          </NativeSelect>
        ) : null}

        <NativeSelect
          size="sm"
          aria-label="Caption language"
          value={language}
          disabled={busy}
          onChange={(event) => selectLanguage(event.target.value)}
        >
          {LANGUAGES.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </NativeSelect>

        {error ? (
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 text-[11px] font-medium text-destructive" role="alert">
              {error}
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 text-subtle-foreground"
              onClick={retryLast}
              disabled={busy}
            >
              Retry
            </Button>
          </div>
        ) : null}

        {emptyResult ? (
          <div
            className="rounded-md border border-dashed border-border bg-surface-dim px-2.5 py-2"
            role="status"
          >
            <p className="text-[11px] font-medium text-foreground">No speech detected</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-subtle-foreground">
              {emptyResult.droppedWords > 0
                ? `${emptyResult.droppedWords} transcribed words fall outside the timeline's audio clips — check the audio source.`
                : "The selected source produced no words — try another track or check the recording."}
            </p>
          </div>
        ) : null}

        {transcribing ? (
          <div className="flex flex-col gap-1.5">
            <Progress value={runProgress?.percent ?? 0} />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-subtle-foreground">{phaseLabel}</span>
              <Button variant="outline" size="sm" onClick={handleCancelTranscribe}>
                Cancel
              </Button>
            </div>
          </div>
        ) : downloading ? (
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
          <>
            {sources.length === 0 ? (
              <p className="rounded-md border border-dashed border-border bg-surface-dim px-2.5 py-2 text-[11px] leading-relaxed text-subtle-foreground">
                No audio on the timeline — add audio first.
              </p>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={handleTranscribe} disabled={!recording || !source}>
                    {staleCount > 0 ? "Regenerate captions" : "Transcribe audio"}
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
                {/* The transcript cache is keyed by the recording file, not
                    the timeline — edited audio re-runs are instant. */}
                <p className="text-[11px] text-subtle-foreground">
                  Re-runs use the cached transcript until the recording file changes.
                </p>
              </>
            )}
            {/* VAD is best-effort — its absence never blocks transcription. */}
            <p className="text-[11px] text-subtle-foreground">
              {status.vadReady ? "Word-level timing model ready" : "Word timing will be estimated"}
            </p>
          </>
        )}
      </div>

      <AlertDialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Replace {pendingImport?.existingCount} existing caption
              {pendingImport?.existingCount === 1 ? "" : "s"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Replace removes them and imports the {pendingImport?.result.cues.length} generated
              captions; Append keeps both.
              {manualCueCount > 0
                ? " This rebuilds captions from scratch — captions you edited or imported manually will be replaced too."
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "secondary" })}
              onClick={() =>
                pendingImport &&
                importResult(
                  pendingImport.result,
                  pendingImport.transcript,
                  "append",
                  pendingImport.autoDetect,
                )
              }
            >
              Append
            </AlertDialogAction>
            <AlertDialogAction
              onClick={() =>
                pendingImport &&
                importResult(
                  pendingImport.result,
                  pendingImport.transcript,
                  "replace",
                  pendingImport.autoDetect,
                )
              }
            >
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
