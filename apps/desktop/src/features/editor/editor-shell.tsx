import { useEffect } from "react"
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  CircleHelp,
  FileOutput,
  Redo2,
  Save,
  ShieldCheck,
  Undo2,
  X,
} from "lucide-react"
import { getRedoLabel, getUndoLabel } from "@recordforge/editor-core"
import { Badge, Button, IconButton, Separator } from "@recordforge/ui"
import { EditorSidebar } from "./editor-sidebar"
import { TimelineView } from "./timeline"
import { useThumbnailManifest, useWaveformResources } from "./media/derivative-resources"
import { isTauri } from "../../lib/settings"
import { useEditorStore, type SaveStatus } from "../../stores/editor-store"
import { useRecorderStore } from "../../stores/recorder-store"
import { useTimelineStore } from "../../stores/timeline-store"

interface EditorShellProps {
  recordingId: string
  onClose: () => void
  onOpenExport?: () => void
}

function saveStatusText(status: SaveStatus): string {
  switch (status) {
    case "saving":
      return "Saving"
    case "saved":
      return "Saved"
    case "error":
      return "Save failed"
    case "idle":
    default:
      return "Unsaved changes"
  }
}

export function EditorShell({ recordingId, onClose, onOpenExport }: EditorShellProps) {
  const engine = useTimelineStore((state) => state.engine)
  const timeline = engine?.history.present ?? null
  const recording = useTimelineStore((state) => state.recording)
  const metadata = useTimelineStore((state) => state.metadata)
  const activeJob = useTimelineStore((state) => state.activeJob)
  const saveProject = useTimelineStore((state) => state.save)
  const undo = useTimelineStore((state) => state.undo)
  const redo = useTimelineStore((state) => state.redo)
  const missingAssets = useTimelineStore((state) => state.missingAssets)
  const activeExportJob = useTimelineStore((state) => state.activeExportJob)
  const saveStatus = useEditorStore((state) => state.saveStatus)
  const saveError = useEditorStore((state) => state.saveError)
  const isDirty = useEditorStore((state) => state.isDirty)
  const recovery = useRecorderStore((state) => state.recovery)
  const diagnostics = useRecorderStore((state) => state.diagnostics)
  const loadRecovery = useRecorderStore((state) => state.loadRecovery)
  const loadDiagnostics = useRecorderStore((state) => state.loadDiagnostics)

  const thumbnailResource = useThumbnailManifest(activeJob?.outputs?.thumbnailManifestPath ?? null)
  const waveformResources = useWaveformResources(activeJob?.outputs?.audioTracks ?? [])
  const undoLabel = engine ? getUndoLabel(engine) : null
  const redoLabel = engine ? getRedoLabel(engine) : null

  useEffect(() => {
    if (!isTauri()) return
    void Promise.all([loadRecovery(), loadDiagnostics()])
  }, [loadDiagnostics, loadRecovery])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <EditorTopBar
        timelineName={timeline?.name ?? recording?.name ?? "Editor"}
        saveStatus={saveStatus}
        saveError={saveError}
        isDirty={isDirty}
        missingAssets={missingAssets}
        recoveryCount={recovery.length}
        diagnosticsReady={diagnostics !== null}
        activeExportJob={activeExportJob}
        undoLabel={undoLabel}
        redoLabel={redoLabel}
        onSave={() => void saveProject()}
        onUndo={undo}
        onRedo={redo}
        onClose={onClose}
        onOpenExport={onOpenExport}
      />
      <div className="flex min-h-0 flex-1">
        <EditorSidebar
          timeline={timeline}
          recording={recording}
          metadata={metadata}
          thumbnailResource={thumbnailResource}
          waveformResources={waveformResources}
          onOpenExport={onOpenExport}
          onReturnToLibrary={onClose}
        />
        <section className="min-w-0 flex-1" aria-label="Editor workspace">
          <TimelineView
            recordingId={recordingId}
            thumbnailResource={thumbnailResource}
            waveformResources={waveformResources}
          />
        </section>
      </div>
    </div>
  )
}

function EditorTopBar({
  timelineName,
  saveStatus,
  saveError,
  isDirty,
  missingAssets,
  recoveryCount,
  diagnosticsReady,
  activeExportJob,
  undoLabel,
  redoLabel,
  onSave,
  onUndo,
  onRedo,
  onClose,
  onOpenExport,
}: {
  timelineName: string
  saveStatus: SaveStatus
  saveError: string | null
  isDirty: boolean
  missingAssets: string[]
  recoveryCount: number
  diagnosticsReady: boolean
  activeExportJob: import("@recordforge/contracts").MediaJob | null
  undoLabel: string | null
  redoLabel: string | null
  onSave: () => void
  onUndo: () => void
  onRedo: () => void
  onClose: () => void
  onOpenExport?: () => void
}) {
  const isExporting = activeExportJob?.status === "running" || activeExportJob?.status === "pending"
  return (
    <header className="flex min-h-12 shrink-0 items-center gap-3 border-b border-border bg-surface px-3 select-none">
      <IconButton label="Return to library" tooltipSide="bottom" onClick={onClose}>
        <ArrowLeft />
      </IconButton>
      <Separator orientation="vertical" className="h-5" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-sm font-semibold text-foreground">{timelineName}</h1>
          <Badge
            variant={
              saveStatus === "error" ? "recording" : saveStatus === "saved" ? "success" : "warning"
            }
            title={saveError ?? saveStatusText(saveStatus)}
          >
            {saveStatusText(saveStatus)}
          </Badge>
          {isDirty ? <span className="sr-only">There are unsaved changes</span> : null}
        </div>
        <div className="hidden items-center gap-2 text-[10px] text-subtle-foreground md:flex">
          <span>Project editor</span>
          {isExporting ? <span className="text-primary">Export in progress</span> : null}
        </div>
      </div>

      <div className="hidden items-center gap-1 lg:flex" aria-label="Editor health status">
        <Badge variant={recoveryCount > 0 ? "warning" : "success"} title="Recovery session status">
          {recoveryCount > 0 ? <AlertCircle aria-hidden /> : <ShieldCheck aria-hidden />}
          {recoveryCount > 0 ? `${recoveryCount} recovery` : "Recovery clear"}
        </Badge>
        <Badge variant={diagnosticsReady ? "info" : "outline"} title="Diagnostic status">
          {diagnosticsReady ? <CheckCircle2 aria-hidden /> : <CircleHelp aria-hidden />}
          {diagnosticsReady ? "Diagnostics ready" : "Diagnostics pending"}
        </Badge>
      </div>

      {missingAssets.length > 0 ? (
        <Badge variant="recording" title={`Missing assets: ${missingAssets.join(", ")}`}>
          <AlertCircle aria-hidden />
          {missingAssets.length} missing
        </Badge>
      ) : null}

      <div className="flex shrink-0 items-center gap-1">
        <IconButton
          label={undoLabel ? `Undo ${undoLabel}` : "Undo"}
          shortcut="Ctrl Z"
          disabled={!undoLabel}
          onClick={onUndo}
        >
          <Undo2 />
        </IconButton>
        <IconButton
          label={redoLabel ? `Redo ${redoLabel}` : "Redo"}
          shortcut="Ctrl Shift Z"
          disabled={!redoLabel}
          onClick={onRedo}
        >
          <Redo2 />
        </IconButton>
        <IconButton label="Save project" shortcut="Ctrl S" onClick={onSave}>
          <Save />
        </IconButton>
        {onOpenExport ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={missingAssets.length > 0 || isExporting}
            onClick={onOpenExport}
            title={
              missingAssets.length > 0
                ? "Relink missing assets before exporting"
                : "Open export settings"
            }
          >
            <FileOutput data-icon="inline-start" />
            <span className="hidden sm:inline">Export</span>
          </Button>
        ) : null}
        <IconButton label="Close editor" tooltipSide="bottom" onClick={onClose}>
          <X />
        </IconButton>
      </div>
    </header>
  )
}
