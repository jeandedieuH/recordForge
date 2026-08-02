import { useState } from "react"
import { LibraryView } from "../features/library"
import { RecorderPanel } from "../features/recorder"
import { SettingsView } from "../features/settings"

type Tab = "recorder" | "library" | "settings"

// Root application shell. It provides a tabbed navigation for Recorder, Library,
// and Settings so each feature stays isolated and the layout remains consistent.
export function AppShell() {
  const [activeTab, setActiveTab] = useState<Tab>("recorder")

  return (
    <main className="mx-auto flex h-screen w-full max-w-5xl flex-col gap-4 overflow-y-auto p-4 sm:p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">recordForge</h1>
          <p className="text-sm text-foreground/70">Phase 2 capture and library</p>
        </div>

        <nav className="flex gap-1 rounded-lg border border-border bg-muted p-1">
          {(["recorder", "library", "settings"] as Tab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
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
      {activeTab === "settings" ? <SettingsView /> : null}
    </main>
  )
}
