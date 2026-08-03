import { useEffect, useState } from "react"
import { ToastViewport, TooltipProvider } from "@recordforge/ui"
import { EditorView } from "../features/editor"
import { LibraryView } from "../features/library"
import { RecorderPanel } from "../features/recorder"
import { SettingsView } from "../features/settings"
import { getSetting, isTauri, setSetting } from "../lib/settings"
import { useEditorStore } from "../stores/editor-store"
import { useThemeStore } from "../stores/theme-store"
import { Sidebar, type View } from "./sidebar"
import { Titlebar } from "./titlebar"

const VIEW_TITLES: Record<View, string> = {
  record: "Record",
  library: "Library",
  editor: "Editor",
  settings: "Settings",
}

// Studio shell: custom titlebar on top, icon sidebar rail on the left, feature
// views in the content area. Navigation state stays in React — this is a
// single-window Tauri app, no router needed.
export function AppShell() {
  const [activeView, setActiveView] = useState<View>("record")
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const editorRecordingId = useEditorStore((state) => state.recordingId)
  const closeEditor = useEditorStore((state) => state.close)
  const loadTheme = useThemeStore((state) => state.load)

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

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <Titlebar view={VIEW_TITLES[activeView]} />
        <div className="flex min-h-0 flex-1">
          <Sidebar
            activeView={activeView}
            onNavigate={setActiveView}
            editorOpen={editorRecordingId !== null}
            collapsed={sidebarCollapsed}
            onToggleCollapsed={toggleSidebar}
          />
          <main className="min-w-0 flex-1 overflow-y-auto">
            {activeView === "record" ? <RecorderPanel /> : null}
            {activeView === "library" ? <LibraryView /> : null}
            {activeView === "editor" && editorRecordingId ? (
              <EditorView recordingId={editorRecordingId} onClose={closeEditor} />
            ) : null}
            {activeView === "settings" ? <SettingsView /> : null}
          </main>
        </div>
      </div>
      <ToastViewport />
    </TooltipProvider>
  )
}
