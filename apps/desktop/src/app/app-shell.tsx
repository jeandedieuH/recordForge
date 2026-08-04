import { useEffect, useState } from "react"
import { save } from "@tauri-apps/plugin-dialog"
import { ToastViewport, TooltipProvider } from "@recordforge/ui"
import { EditorView } from "../features/editor"
import { ExportView } from "../features/export"
import { LibraryView } from "../features/library"
import { NewRecordingModal } from "../features/recorder"
import { SettingsView } from "../features/settings"
import { toErrorMessage } from "../lib/errors"
import { getSetting, isTauri, setSetting } from "../lib/settings"
import { useEditorStore } from "../stores/editor-store"
import { useThemeStore } from "../stores/theme-store"
import { useTimelineStore } from "../stores/timeline-store"
import { useRecorderStore } from "../hooks/use-recorder"
import { Sidebar, type View } from "./sidebar"
import { Titlebar } from "./titlebar"

const VIEW_TITLES: Record<View, string> = {
  library: "Library",
  projects: "Projects",
  storage: "Storage",
  editor: "Editor",
  export: "Export",
  settings: "Settings",
}

export function AppShell() {
  const [activeView, setActiveView] = useState<View>("library")
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [isNewRecordingOpen, setIsNewRecordingOpen] = useState(false)

  const editorRecordingId = useEditorStore((state) => state.recordingId)
  const openEditor = useEditorStore((state) => state.open)
  const closeEditor = useEditorStore((state) => state.close)
  const loadTheme = useThemeStore((state) => state.load)
  const startRecording = useRecorderStore((state) => state.start)
  const completedRecordingId = useRecorderStore((state) => state.completedRecordingId)
  const queuePreparation = useRecorderStore((state) => state.queuePreparation)
  const clearCompletedRecording = useRecorderStore((state) => state.clearCompletedRecording)
  const saveMessage = useRecorderStore((state) => state.saveMessage)
  const clearSaveMessage = useRecorderStore((state) => state.clearSaveMessage)
  const timelineRecording = useTimelineStore((state) => state.recording)
  const timelineCanvas = useTimelineStore((state) => state.engine?.history.present.canvas)
  const timelineExport = useTimelineStore((state) => state.export)
  const timelineError = useTimelineStore((state) => state.error)
  const clearTimelineError = useTimelineStore((state) => state.clearError)
  const activeExportJob = useTimelineStore((state) => state.activeExportJob)
  const startTimelineListening = useTimelineStore((state) => state.startListening)
  const stopTimelineListening = useTimelineStore((state) => state.stopListening)

  // Load persisted theme/transparency preferences once at startup.
  useEffect(() => {
    void loadTheme()
  }, [loadTheme])

  // Restore the sidebar collapsed preference.
  useEffect(() => {
    if (!isTauri()) return
    void getSetting("sidebarCollapsed").then((value) => {
      if (value === "true") setSidebarCollapsed(true)
    })
  }, [])

  // Open the editor view when a recording is opened from the library.
  useEffect(() => {
    if (editorRecordingId) {
      setActiveView("editor")
    }
  }, [editorRecordingId])

  // Keep media-job progress alive while moving between the editor and export views.
  useEffect(() => {
    if (!editorRecordingId) return
    void startTimelineListening()
    return () => stopTimelineListening()
  }, [editorRecordingId, startTimelineListening, stopTimelineListening])

  // A successful stop publishes the exact library ID after persistence. Queue
  // derivatives here so opening the editor never owns or blocks preparation.
  useEffect(() => {
    if (!completedRecordingId) return
    void queuePreparation(completedRecordingId)
    openEditor(completedRecordingId)
    setActiveView("editor")
    clearCompletedRecording()
  }, [clearCompletedRecording, completedRecordingId, openEditor, queuePreparation])

  function toggleSidebar() {
    setSidebarCollapsed((prev) => {
      if (isTauri()) void setSetting("sidebarCollapsed", String(!prev))
      return !prev
    })
  }

  function handleStartRecording() {
    setActiveView("library")
    void startRecording()
  }

  function handleCloseEditor() {
    closeEditor()
    setActiveView("library")
  }

  async function handleStartExport() {
    if (!timelineRecording) return
    try {
      const outputPath = await save({
        title: "Export edited recording",
        defaultPath: `${timelineRecording.name}-edited.mp4`,
        filters: [{ name: "MP4 video", extensions: ["mp4"] }],
      })
      if (!outputPath) return
      await timelineExport(outputPath)
    } catch (error) {
      useTimelineStore.setState({ error: toErrorMessage(error) })
    }
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen flex-col bg-background text-foreground font-sans antialiased">
        <Titlebar view={VIEW_TITLES[activeView]} onOpenRecord={() => setIsNewRecordingOpen(true)} />

        <div className="flex min-h-0 flex-1">
          <Sidebar
            activeView={activeView}
            onNavigate={setActiveView}
            editorOpen={editorRecordingId !== null}
            collapsed={sidebarCollapsed}
            onToggleCollapsed={toggleSidebar}
          />

          <main className="min-w-0 flex-1 overflow-y-auto bg-background">
            {saveMessage ? (
              <div
                role="status"
                className="mx-6 mt-4 flex items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-foreground"
              >
                <span>{saveMessage}</span>
                <button
                  type="button"
                  className="shrink-0 text-subtle-foreground underline"
                  onClick={clearSaveMessage}
                >
                  Dismiss
                </button>
              </div>
            ) : null}
            {activeView === "library" ? <LibraryView /> : null}
            {activeView === "projects" ? (
              <div className="p-8 text-center text-subtle-foreground">
                <h3 className="font-serif text-lg font-bold text-foreground mb-2">Projects View</h3>
                <p className="text-sm">Manage your recording projects and series.</p>
              </div>
            ) : null}
            {activeView === "storage" ? (
              <div className="p-8 text-center text-subtle-foreground">
                <h3 className="font-serif text-lg font-bold text-foreground mb-2">Storage View</h3>
                <p className="text-sm">Manage disk space and S3/Google Drive cloud providers.</p>
              </div>
            ) : null}
            {activeView === "editor" ? (
              <EditorView
                recordingId={editorRecordingId ?? "rec-1"}
                onClose={handleCloseEditor}
                onOpenExport={() => setActiveView("export")}
              />
            ) : null}
            {activeView === "export" ? (
              <ExportView
                projectName={timelineRecording?.name}
                canvas={timelineCanvas}
                exportJob={activeExportJob}
                error={timelineError}
                onDismissError={clearTimelineError}
                onBack={() => setActiveView("editor")}
                onStartExport={handleStartExport}
              />
            ) : null}
            {activeView === "settings" ? <SettingsView /> : null}
          </main>
        </div>

        {/* New Recording Modal Overlay */}
        <NewRecordingModal
          open={isNewRecordingOpen}
          onClose={() => setIsNewRecordingOpen(false)}
          onStart={handleStartRecording}
          onNavigateToSettings={() => setActiveView("settings")}
        />
      </div>
      <ToastViewport />
    </TooltipProvider>
  )
}
