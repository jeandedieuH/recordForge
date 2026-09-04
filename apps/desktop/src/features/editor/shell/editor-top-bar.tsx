import { useMemo, useState } from "react"
import { ArrowLeft, FileOutput, ListTodo, Redo2, Save, Undo2, X } from "lucide-react"
import { getRedoLabel, getUndoLabel } from "@recordforge/editor-core"
import { Badge, Button, IconButton, Separator, SimpleSelect } from "@recordforge/ui"
import { useEditorStore, type SaveStatus } from "../../../stores/editor-store"
import { useTimelineStore } from "../../../stores/timeline-store"
import { HealthPopover } from "./health-popover"
import { JobsDrawer } from "./jobs-drawer"

interface EditorTopBarProps {
  onClose: () => void
  onOpenExport?: () => void
}

export function EditorTopBar({ onClose, onOpenExport }: EditorTopBarProps) {
  const engine = useTimelineStore((state) => state.engine)
  const recording = useTimelineStore((state) => state.recording)
  const timeline = engine?.history.present
  const projectName = timeline?.name ?? recording?.name ?? "Editor"
  const missingAssets = useTimelineStore((state) => state.missingAssets)
  const activeExportJob = useTimelineStore((state) => state.activeExportJob)
  const saveProject = useTimelineStore((state) => state.save)
  const undo = useTimelineStore((state) => state.undo)
  const redo = useTimelineStore((state) => state.redo)

  const saveStatus = useEditorStore((state) => state.saveStatus)
  const saveError = useEditorStore((state) => state.saveError)
  const isDirty = useEditorStore((state) => state.isDirty)

  const previewQuality = useTimelineStore((state) => state.view.previewQuality)
  const setPreviewQuality = useTimelineStore((state) => state.setPreviewQuality)
  const [jobsOpen, setJobsOpen] = useState(false)

  const undoLabel = useMemo(() => (engine ? getUndoLabel(engine) : null), [engine])
  const redoLabel = useMemo(() => (engine ? getRedoLabel(engine) : null), [engine])

  const isExporting = activeExportJob?.status === "running" || activeExportJob?.status === "pending"

  return (
    <>
      <header
        className="flex min-h-12 shrink-0 items-center gap-3 border-b border-border bg-surface px-3 select-none"
        role="banner"
        aria-label="Editor top bar"
      >
        <IconButton label="Return to library" tooltipSide="bottom" onClick={onClose}>
          <ArrowLeft />
        </IconButton>

        <Separator orientation="vertical" className="h-5" />

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1
              className="max-w-56 truncate text-sm font-semibold text-foreground"
              title={projectName}
            >
              {projectName}
            </h1>
            <Badge
              variant={
                saveStatus === "error"
                  ? "recording"
                  : saveStatus === "saved"
                    ? "success"
                    : "warning"
              }
              title={saveError ?? saveStatusText(saveStatus)}
            >
              {saveStatusText(saveStatus)}
            </Badge>
            {isDirty ? <span className="sr-only">There are unsaved changes</span> : null}
          </div>
        </div>

        <div className="hidden items-center gap-1 md:flex" aria-label="History actions">
          <IconButton
            label={undoLabel ? `Undo ${undoLabel}` : "Undo"}
            shortcut="Ctrl Z"
            disabled={!undoLabel}
            onClick={undo}
          >
            <Undo2 />
          </IconButton>
          <IconButton
            label={redoLabel ? `Redo ${redoLabel}` : "Redo"}
            shortcut="Ctrl Shift Z"
            disabled={!redoLabel}
            onClick={redo}
          >
            <Redo2 />
          </IconButton>
          <IconButton label="Save project" shortcut="Ctrl S" onClick={() => void saveProject()}>
            <Save />
          </IconButton>
        </div>

        <Separator orientation="vertical" className="hidden h-5 md:block" />

        <div className="hidden items-center gap-2 lg:flex" aria-label="Preview quality">
          <span className="text-[11px] text-subtle-foreground">Preview</span>
          <SimpleSelect
            aria-label="Preview quality"
            size="sm"
            value={previewQuality}
            onValueChange={(val) =>
              setPreviewQuality(val as "quality" | "performance" | "power")
            }
            className="w-32"
            options={[
              { value: "quality", label: "Quality" },
              { value: "performance", label: "Performance" },
              { value: "power", label: "Power Saving" },
            ]}
          />
        </div>

        <Separator orientation="vertical" className="hidden h-5 lg:block" />

        <div className="flex shrink-0 items-center gap-1">
          <HealthPopover />
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 px-2"
            onClick={() => setJobsOpen(true)}
            aria-label="Open jobs drawer"
          >
            <ListTodo className="size-4" aria-hidden />
            <span className="hidden sm:inline">Jobs</span>
          </Button>
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

      <JobsDrawer open={jobsOpen} onOpenChange={setJobsOpen} />
    </>
  )
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
      return "Unsaved"
  }
}
