import { getTotalDuration } from "@recordforge/editor-core"
import { FileOutput } from "lucide-react"
import { Badge, Button, EmptyState } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"
import { useEditorStore } from "../../../stores/editor-store"

interface ExportPanelProps {
  onOpenExport?: () => void
}

export function ExportPanel({ onOpenExport }: ExportPanelProps) {
  const timeline = useTimelineStore((state) => state.engine?.history.present)
  const recording = useTimelineStore((state) => state.recording)
  const missingAssets = useTimelineStore((state) => state.missingAssets)
  const activeExportJob = useTimelineStore((state) => state.activeExportJob)
  const saveStatus = useEditorStore((state) => state.saveStatus)

  const durationMs = timeline ? getTotalDuration(timeline) : 0
  const isExporting = activeExportJob?.status === "running" || activeExportJob?.status === "pending"

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <div className="flex items-center gap-2 border-b border-border pb-2 text-sm font-semibold text-foreground">
        <FileOutput className="size-4 text-primary" aria-hidden />
        <h2>Export</h2>
      </div>

      {timeline ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-dim p-3 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-subtle-foreground">Project</span>
            <span className="truncate text-right font-medium text-foreground">
              {recording?.name ?? timeline.name}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-subtle-foreground">Duration</span>
            <span className="font-mono tabular-nums text-foreground">
              {formatDuration(durationMs)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-subtle-foreground">Preset</span>
            <Badge variant="outline">Default MP4</Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-subtle-foreground">Save state</span>
            <Badge
              variant={
                saveStatus === "error"
                  ? "recording"
                  : saveStatus === "saved"
                    ? "success"
                    : "warning"
              }
            >
              {saveStatusText(saveStatus)}
            </Badge>
          </div>
        </div>
      ) : (
        <EmptyState
          icon={FileOutput}
          title="Nothing to export"
          description="Open a recording and save your edits before exporting."
          className="border border-dashed border-border bg-surface-dim p-4"
        />
      )}

      {missingAssets.length > 0 ? (
        <div
          className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-[11px] text-warning"
          role="status"
        >
          Relink {missingAssets.length} missing asset{missingAssets.length === 1 ? "" : "s"} before
          export.
        </div>
      ) : null}

      {activeExportJob ? (
        <div
          className="rounded-lg border border-primary/30 bg-primary/10 p-3 text-[11px] text-foreground"
          role="status"
        >
          <div className="flex items-center justify-between">
            <span>Export {activeExportJob.status}</span>
            <span className="font-mono text-subtle-foreground">
              {Math.round((activeExportJob.progress ?? 0) * 100)}%
            </span>
          </div>
        </div>
      ) : null}

      <Button
        variant="secondary"
        size="sm"
        className="mt-auto h-9"
        disabled={!timeline || missingAssets.length > 0 || isExporting}
        onClick={onOpenExport}
      >
        <FileOutput data-icon="inline-start" />
        Open export settings
      </Button>
    </div>
  )
}

function saveStatusText(status: "idle" | "saving" | "saved" | "error"): string {
  switch (status) {
    case "saving":
      return "Saving"
    case "saved":
      return "Saved"
    case "error":
      return "Save failed"
    case "idle":
    default:
      return "Unsaved"
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}
