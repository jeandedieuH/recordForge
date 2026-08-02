import { useEffect, useState } from "react"
import { EditorView } from "../features/editor"
import { LibraryView } from "../features/library"
import { RecorderPanel } from "../features/recorder"
import { SettingsView } from "../features/settings"
import { useEditorStore } from "../stores/editor-store"

type Tab = "recorder" | "library" | "editor" | "settings"

// Root application shell. It provides a tabbed navigation for Recorder, Library,
// Editor, and Settings so each feature stays isolated and the layout remains consistent.
export function AppShell() {
  const [activeTab, setActiveTab] = useState<Tab>("recorder")
  const editorRecordingId = useEditorStore((state) => state.recordingId)
  const closeEditor = useEditorStore((state) => state.close)

  // Switch to the editor tab when a recording is opened from the library.
  useEffect(() => {
    if (editorRecordingId) {
      setActiveTab("editor")
    }
  }, [editorRecordingId])

  return (
    <main className="mx-auto flex h-screen w-full max-w-5xl flex-col gap-4 overflow-y-auto p-4 sm:p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">recordForge</h1>
          <p className="text-sm text-foreground/70">Phase 3 capture, library, and editor</p>
        </div>

        <nav className="flex gap-1 rounded-lg border border-border bg-muted p-1">
          {(["recorder", "library", "editor", "settings"] as Tab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              disabled={tab === "editor" && !editorRecordingId}
              className={`rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors disabled:opacity-40 ${
                activeTab === tab
                  ? "bg-primary text-primary-foreground"
                  : "text-foreground hover:bg-background"
              }`}
            >
              {tab}
            </button>
          ))}
        </nav>
      </header>

      {activeTab === "recorder" ? <RecorderPanel /> : null}
      {activeTab === "library" ? <LibraryView /> : null}
      {activeTab === "editor" && editorRecordingId ? (
        <EditorView recordingId={editorRecordingId} onClose={closeEditor} />
      ) : null}
      {activeTab === "settings" ? <SettingsView /> : null}
    </main>
  )
}
