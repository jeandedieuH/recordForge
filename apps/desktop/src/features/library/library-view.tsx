import { useEffect, useMemo, useState } from "react"
import { save } from "@tauri-apps/plugin-dialog"
import { AlertTriangle, LayoutGrid, List, RotateCcw } from "lucide-react"
import { Button, Input } from "@recordforge/ui"
import type { LibraryRecording } from "@recordforge/contracts"
import { useEditorStore } from "../../stores/editor-store"
import { useJobsStore } from "../../stores/jobs-store"
import { LibraryItemCard } from "./library-item-card"
import { LibraryItemRow } from "./library-item-row"
import { MediaJobsPanel } from "./media-jobs-panel"
import { MediaPrepareDialog } from "./media-prepare-dialog"
import { useLibraryStore, type LibrarySort } from "./use-library"

// Fallback recordings to match reference mockup when local DB is empty
const dummySource = {
  kind: "display" as const,
  id: "disp-1",
  name: "Display 1",
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
}

const MOCK_RECORDINGS: LibraryRecording[] = [
  {
    id: "rec-1",
    sessionId: "sess-1",
    name: "API Endpoint Walkthrough...",
    durationMs: 2712000, // 45:12
    createdAt: "2024-05-20T10:30:00Z",
    updatedAt: "2024-05-20T10:30:00Z",
    status: "completed",
    width: 2560,
    height: 1440,
    fps: 60,
    sizeBytes: 1540000000,
    source: dummySource,
    profileName: "balanced",
    workDir: "/recordings/rec-1",
    tags: ["api"],
    markers: [],
  },
  {
    id: "rec-2",
    sessionId: "sess-2",
    name: "Q3 Architecture Review",
    durationMs: 724000, // 12:04
    createdAt: "2024-05-18T14:15:00Z",
    updatedAt: "2024-05-18T14:15:00Z",
    status: "completed",
    width: 2560,
    height: 1440,
    fps: 60,
    sizeBytes: 680000000,
    source: dummySource,
    profileName: "balanced",
    workDir: "/recordings/rec-2",
    tags: ["uploaded"],
    markers: [],
  },
  {
    id: "rec-3",
    sessionId: "sess-3",
    name: "Voiceover - Intro Scene",
    durationMs: 225000, // 03:45
    createdAt: "2024-05-15T09:00:00Z",
    updatedAt: "2024-05-15T09:00:00Z",
    status: "completed",
    width: 1920,
    height: 1080,
    fps: 30,
    sizeBytes: 45000000,
    source: dummySource,
    profileName: "balanced",
    workDir: "/recordings/rec-3",
    tags: ["audio"],
    markers: [],
  },
  {
    id: "rec-4",
    sessionId: "sess-4",
    name: "Client Onboarding Session...",
    durationMs: 3502000, // 58:22
    createdAt: "2024-05-12T16:45:00Z",
    updatedAt: "2024-05-12T16:45:00Z",
    status: "completed",
    width: 2560,
    height: 1440,
    fps: 60,
    sizeBytes: 2100000000,
    source: dummySource,
    profileName: "balanced",
    workDir: "/recordings/rec-4",
    tags: ["uploaded"],
    markers: [],
  },
]

function matchesSearch(recording: LibraryRecording, query: string) {
  if (!query) return true
  const lower = query.toLowerCase()
  return (
    recording.name.toLowerCase().includes(lower) ||
    recording.tags.some((tag) => tag.toLowerCase().includes(lower)) ||
    recording.sessionId.toLowerCase().includes(lower)
  )
}

function matchesTag(recording: LibraryRecording, tagFilter: string) {
  if (!tagFilter) return true
  const lower = tagFilter.toLowerCase()
  return recording.tags.some((tag) => tag.toLowerCase().includes(lower))
}

function sortRecordings(recordings: LibraryRecording[], sort: LibrarySort) {
  const copy = [...recordings]
  switch (sort) {
    case "newest":
      return copy.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    case "oldest":
      return copy.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    case "duration":
      return copy.sort((a, b) => b.durationMs - a.durationMs)
    case "size":
      return copy.sort((a, b) => b.sizeBytes - a.sizeBytes)
    default:
      return copy
  }
}

export function LibraryView() {
  const store = useLibraryStore()
  const jobsStore = useJobsStore()
  const editorStore = useEditorStore()
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid")
  const [showRecoveryBanner, setShowRecoveryBanner] = useState(true)
  const [trimTarget, setTrimTarget] = useState<LibraryRecording | null>(null)
  const [trimStart, setTrimStart] = useState("")
  const [trimEnd, setTrimEnd] = useState("")
  const [trimError, setTrimError] = useState<string | null>(null)
  const [prepareTarget, setPrepareTarget] = useState<LibraryRecording | null>(null)

  useEffect(() => {
    void useLibraryStore.getState().load()
  }, [])

  const recordingsToDisplay = store.recordings.length > 0 ? store.recordings : MOCK_RECORDINGS

  const filtered = useMemo(() => {
    const searched = recordingsToDisplay.filter(
      (r) => matchesSearch(r, store.search) && matchesTag(r, store.tagFilter),
    )
    return sortRecordings(searched, store.sort)
  }, [recordingsToDisplay, store.search, store.sort, store.tagFilter])

  async function handleExport(recording: LibraryRecording) {
    try {
      const outputPath = await save({
        title: "Export recording",
        defaultPath: recording.name,
        filters: [{ name: "MP4", extensions: ["mp4"] }],
      })
      if (!outputPath) return
      await store.export({ recordingId: recording.id, outputPath })
    } catch (err) {
      console.error("Export failed:", err)
    }
  }

  function handleStartTrim(recording: LibraryRecording) {
    setTrimTarget(recording)
    setTrimStart("0")
    setTrimEnd(String(recording.durationMs))
    setTrimError(null)
  }

  function handleCancelTrim() {
    setTrimTarget(null)
    setTrimStart("")
    setTrimEnd("")
    setTrimError(null)
  }

  async function handleApplyTrim() {
    if (!trimTarget) return
    const startMs = Number.parseInt(trimStart, 10)
    const endMs = Number.parseInt(trimEnd, 10)

    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
      setTrimError("Start and end must be numbers")
      return
    }
    if (startMs < 0 || endMs < 0) {
      setTrimError("Start and end must be 0 or greater")
      return
    }
    if (startMs >= endMs) {
      setTrimError("End must be greater than start")
      return
    }

    try {
      await store.trim({ recordingId: trimTarget.id, startMs, endMs })
      setTrimTarget(null)
      setTrimStart("")
      setTrimEnd("")
      setTrimError(null)
    } catch (err) {
      setTrimError(String(err))
    }
  }

  function handleOpenPrepare(recording: LibraryRecording) {
    setPrepareTarget(recording)
  }

  async function handlePrepare(
    recording: LibraryRecording,
    options: { force: boolean; thumbnailIntervalSec: number },
  ) {
    try {
      await jobsStore.prepareWithOptions(recording.id, options)
    } catch (err) {
      useLibraryStore.setState({ error: String(err) })
    }
  }

  async function handleCleanup(recordingId: string) {
    try {
      await jobsStore.cleanup(recordingId)
    } catch (err) {
      useLibraryStore.setState({ error: String(err) })
    }
  }

  function handleOpenEditor(recording: LibraryRecording) {
    editorStore.open(recording.id)
  }

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto w-full">
      {/* Incomplete / Recoverable Alert Banner */}
      {showRecoveryBanner ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-warning uppercase tracking-wider font-label">
            <AlertTriangle className="size-4" />
            <span>Incomplete / Recoverable</span>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-xl border border-border bg-surface p-4 shadow-sm">
            <div className="flex items-center gap-3.5">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-overlay text-amber-400">
                <RotateCcw className="size-5" />
              </div>
              <div className="flex flex-col">
                <h3 className="font-mono text-sm font-semibold text-foreground">
                  Untitled_Recording_2024-05-20.tmp
                </h3>
                <p className="text-xs text-subtle-foreground mt-0.5">
                  Interrupted 2 hours ago • ~14:22 duration
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2.5 self-end sm:self-center">
              <Button
                variant="outline"
                onClick={() => setShowRecoveryBanner(false)}
                className="text-xs font-medium px-4 py-1.5"
              >
                Discard
              </Button>
              <Button
                onClick={() => setShowRecoveryBanner(false)}
                className="bg-tertiary hover:bg-tertiary-hover text-white text-xs font-medium px-4 py-1.5 rounded-lg border-0 shadow-sm"
              >
                Recover
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Recent Recordings Section Header & Controls */}
      <div className="flex items-center justify-between">
        <h2 className="font-label text-xs font-bold uppercase tracking-wider text-subtle-foreground">
          Recent Recordings
        </h2>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 rounded-lg border border-border bg-surface p-1">
            <button
              type="button"
              onClick={() => setViewMode("grid")}
              className={`rounded p-1 transition-colors ${
                viewMode === "grid"
                  ? "bg-overlay text-foreground"
                  : "text-subtle-foreground hover:text-foreground"
              }`}
              title="Grid View"
            >
              <LayoutGrid className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode("list")}
              className={`rounded p-1 transition-colors ${
                viewMode === "list"
                  ? "bg-overlay text-foreground"
                  : "text-subtle-foreground hover:text-foreground"
              }`}
              title="List View"
            >
              <List className="size-4" />
            </button>
          </div>
        </div>
      </div>

      {store.error ? (
        <div className="rounded-lg border border-red-900 bg-red-950 p-3 text-sm text-red-400">
          {store.error}
          <button type="button" className="ml-2 underline" onClick={store.clearError}>
            Dismiss
          </button>
        </div>
      ) : null}

      {trimTarget ? (
        <div className="rounded-lg border border-border bg-surface p-4">
          <h3 className="mb-2 text-sm font-medium text-foreground">Trim {trimTarget.name}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label
                className="mb-1 block text-xs font-medium text-subtle-foreground"
                htmlFor="trim-start"
              >
                Start (ms)
              </label>
              <Input
                id="trim-start"
                type="number"
                min={0}
                value={trimStart}
                onChange={(e) => setTrimStart(e.target.value)}
              />
            </div>
            <div>
              <label
                className="mb-1 block text-xs font-medium text-subtle-foreground"
                htmlFor="trim-end"
              >
                End (ms)
              </label>
              <Input
                id="trim-end"
                type="number"
                min={0}
                value={trimEnd}
                onChange={(e) => setTrimEnd(e.target.value)}
              />
            </div>
          </div>
          {trimError ? <p className="mt-2 text-sm text-red-500">{trimError}</p> : null}
          <div className="mt-3 flex gap-2">
            <Button onClick={handleApplyTrim}>Apply trim</Button>
            <Button variant="secondary" onClick={handleCancelTrim}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      <MediaPrepareDialog
        recording={prepareTarget}
        onClose={() => setPrepareTarget(null)}
        onPrepare={handlePrepare}
        onCleanup={handleCleanup}
      />

      <MediaJobsPanel />

      {/* Grid or List of Recordings */}
      {viewMode === "grid" ? (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {filtered.map((recording) => (
            <LibraryItemCard
              key={recording.id}
              recording={recording}
              onDelete={store.delete}
              onReveal={store.reveal}
              onTrim={handleStartTrim}
              onExport={handleExport}
              onPrepare={handleOpenPrepare}
              onOpenEditor={handleOpenEditor}
              onAddTag={store.addTag}
              onRemoveTag={store.removeTag}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((recording) => (
            <LibraryItemRow
              key={recording.id}
              recording={recording}
              onDelete={store.delete}
              onReveal={store.reveal}
              onTrim={handleStartTrim}
              onExport={handleExport}
              onPrepare={handleOpenPrepare}
              onOpenEditor={handleOpenEditor}
              onAddTag={store.addTag}
              onRemoveTag={store.removeTag}
            />
          ))}
        </div>
      )}
    </div>
  )
}
