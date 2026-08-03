import { useEffect, useState } from "react"
import { ToastViewport, TooltipProvider } from "@recordforge/ui"
import { EditorView } from "../features/editor"
import { ExportView } from "../features/export"
import { LibraryView } from "../features/library"
import { NewRecordingModal, RecorderPanel } from "../features/recorder"
import { SettingsView } from "../features/settings"
import { getSetting, isTauri, setSetting } from "../lib/settings"
import { useEditorStore } from "../stores/editor-store"
import { useThemeStore } from "../stores/theme-store"
import { useRecorderStore } from "../hooks/use-recorder"
import { Sidebar, type View } from "./sidebar"
import { Titlebar } from "./titlebar"

const VIEW_TITLES: Record<View, string> = {
  record: "Record",
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
  const closeEditor = useEditorStore((state) => state.close)
  const loadTheme = useThemeStore((state) => state.load)
  const startRecording = useRecorderStore((state) => state.start)

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

  function toggleSidebar() {
    setSidebarCollapsed((prev) => {
      if (isTauri()) void setSetting("sidebarCollapsed", String(!prev))
      return !prev
    })
  }

  function handleStartRecording() {
    setActiveView("record")
    void startRecording()
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
            {activeView === "record" ? <RecorderPanel /> : null}
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
                onClose={closeEditor}
                onOpenExport={() => setActiveView("export")}
              />
            ) : null}
            {activeView === "export" ? (
              <ExportView
                onBack={() => setActiveView("library")}
                onStartExport={() => setActiveView("library")}
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
