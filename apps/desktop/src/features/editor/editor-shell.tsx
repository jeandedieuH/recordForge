import { useEffect, useState } from "react"
import { X } from "lucide-react"
import { Sheet, SheetContent, SheetTitle } from "@recordforge/ui"
import { useTimelineStore } from "../../stores/timeline-store"
import { useThumbnailManifest, useVideoTrackThumbnailResources, useWaveformResources } from "./media/derivative-resources"
import { TimelineView } from "./timeline"
import { InspectorShell } from "./inspector/inspector-shell"
import { ActivePanel } from "./shell/active-panel"
import { EditorTopBar } from "./shell/editor-top-bar"
import { ResizableHandle } from "./shell/resizable-handle"
import { TaskRail, type EditorTask, EDITOR_TASKS } from "./shell/task-rail"
import { useResizableDimension } from "./shell/use-resizable-dimension"
import { useNarrowViewport } from "./shell/use-narrow-viewport"

interface EditorShellProps {
  recordingId: string
  onClose: () => void
  onOpenExport?: () => void
}

const ACTIVE_TASK_STORAGE_KEY = "recordforge:editor:activeTask"
const ACTIVE_PANEL_WIDTH_KEY = "recordforge:editor:activePanelWidth"
const INSPECTOR_WIDTH_KEY = "recordforge:editor:inspectorWidth"

function loadActiveTask(): EditorTask {
  try {
    const stored = localStorage.getItem(ACTIVE_TASK_STORAGE_KEY)
    if (stored && EDITOR_TASKS.some((task) => task.value === stored)) {
      return stored as EditorTask
    }
  } catch {
    // Ignore storage errors.
  }
  return "media"
}

export function EditorShell({ recordingId, onClose, onOpenExport }: EditorShellProps) {
  const [activeTask, setActiveTask] = useState(loadActiveTask)
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false)
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false)

  const [activePanelWidth, setActivePanelWidth] = useResizableDimension({
    defaultValue: 260,
    min: 200,
    max: 380,
    storageKey: ACTIVE_PANEL_WIDTH_KEY,
  })

  const [inspectorWidth, setInspectorWidth] = useResizableDimension({
    defaultValue: 320,
    min: 240,
    max: 420,
    storageKey: INSPECTOR_WIDTH_KEY,
  })

  const isNarrow = useNarrowViewport()

  const activeJob = useTimelineStore((state) => state.activeJob)
  const recording = useTimelineStore((state) => state.recording)
  const metadata = useTimelineStore((state) => state.metadata)
  const timeline = useTimelineStore((state) => state.engine?.history.present ?? null)
  const view = useTimelineStore((state) => state.view)

  const thumbnailResource = useThumbnailManifest(activeJob?.outputs?.thumbnailManifestPath ?? null)
  const videoThumbnailResources = useVideoTrackThumbnailResources(activeJob?.outputs?.videoTracks ?? [])
  const waveformResources = useWaveformResources(activeJob?.outputs?.audioTracks ?? [])

  // Persist the active task whenever it changes.
  useEffect(() => {
    try {
      localStorage.setItem(ACTIVE_TASK_STORAGE_KEY, activeTask)
    } catch {
      // Ignore storage errors.
    }
  }, [activeTask])

  // Close the mobile inspector when a selection is made so the user can see the workspace.
  useEffect(() => {
    if (view.selection && mobileInspectorOpen) {
      setMobileInspectorOpen(false)
    }
  }, [view.selection, mobileInspectorOpen])

  function handleSelectTask(task: EditorTask) {
    setActiveTask(task)
    if (isNarrow) setMobilePanelOpen(true)
  }

  const activePanel = (
    <ActivePanel
      activeTask={activeTask}
      timeline={timeline}
      recording={recording}
      metadata={metadata}
      thumbnailResource={thumbnailResource}
      waveformResources={waveformResources}
      onOpenExport={onOpenExport}
    />
  )

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <EditorTopBar onClose={onClose} onOpenExport={onOpenExport} />

      <div className="flex min-h-0 flex-1">
        <TaskRail
          activeTask={activeTask}
          onSelect={handleSelectTask}
          onToggleInspector={() => setMobileInspectorOpen(true)}
          showInspectorToggle={isNarrow}
        />

        {!isNarrow ? (
          <>
            <div
              className="flex h-full shrink-0 flex-col overflow-hidden border-r border-border bg-surface"
              style={{ width: activePanelWidth }}
            >
              {activePanel}
            </div>
            <ResizableHandle
              direction="horizontal"
              value={activePanelWidth}
              min={200}
              max={380}
              onChange={setActivePanelWidth}
            />
          </>
        ) : null}

        <section className="flex min-w-0 flex-1 flex-col" aria-label="Editor workspace">
          <TimelineView
            recordingId={recordingId}
            thumbnailResource={thumbnailResource}
            videoThumbnailResources={videoThumbnailResources}
            waveformResources={waveformResources}
          />
        </section>

        {!isNarrow ? (
          <>
            <ResizableHandle
              direction="horizontal"
              value={inspectorWidth}
              min={240}
              max={420}
              onChange={setInspectorWidth}
            />
            <div
              className="flex h-full shrink-0 flex-col overflow-hidden"
              style={{ width: inspectorWidth }}
            >
              <InspectorShell metadata={metadata} />
            </div>
          </>
        ) : null}
      </div>

      {/* Narrow-viewport active panel drawer */}
      {isNarrow ? (
        <Sheet open={mobilePanelOpen} onOpenChange={setMobilePanelOpen}>
          <SheetContent side="left" className="w-[min(80vw,360px)] p-0">
            <SheetTitle className="sr-only">{activeTask} panel</SheetTitle>
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-end border-b border-border px-3 py-2">
                <button
                  type="button"
                  onClick={() => setMobilePanelOpen(false)}
                  className="rounded p-1 text-subtle-foreground transition-colors duration-fast hover:text-foreground"
                  aria-label="Close panel"
                >
                  <X className="size-4" aria-hidden />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto">{activePanel}</div>
            </div>
          </SheetContent>
        </Sheet>
      ) : null}

      {/* Narrow-viewport inspector drawer */}
      {isNarrow ? (
        <Sheet open={mobileInspectorOpen} onOpenChange={setMobileInspectorOpen}>
          <SheetContent side="right" className="w-[min(80vw,360px)] p-0">
            <SheetTitle className="sr-only">Inspector</SheetTitle>
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-end border-b border-border px-3 py-2">
                <button
                  type="button"
                  onClick={() => setMobileInspectorOpen(false)}
                  className="rounded p-1 text-subtle-foreground transition-colors duration-fast hover:text-foreground"
                  aria-label="Close inspector"
                >
                  <X className="size-4" aria-hidden />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto">
                <InspectorShell metadata={metadata} />
              </div>
            </div>
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  )
}
