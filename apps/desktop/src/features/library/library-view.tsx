import { useEffect, useMemo, useState } from "react"
import { save } from "@tauri-apps/plugin-dialog"
import { Button, Input } from "@recordforge/ui"
import type { LibraryRecording } from "@recordforge/contracts"
import { useEditorStore } from "../../stores/editor-store"
import { useJobsStore } from "../../stores/jobs-store"
import { LibraryItemCard } from "./library-item-card"
import { LibraryItemRow } from "./library-item-row"
import { MediaJobsPanel } from "./media-jobs-panel"
import { MediaPrepareDialog } from "./media-prepare-dialog"
import { useLibraryStore, type LibrarySort } from "./use-library"

// Filter, sort, and search helpers for the library list.
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

// Main library view. Supports searching, sorting, tag filtering, grid/list
// layout, and inline trim/export actions.
export function LibraryView() {
  const store = useLibraryStore()
  const jobsStore = useJobsStore()
  const editorStore = useEditorStore()
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid")
  const [trimTarget, setTrimTarget] = useState<LibraryRecording | null>(null)
  const [trimStart, setTrimStart] = useState("")
  const [trimEnd, setTrimEnd] = useState("")
  const [trimError, setTrimError] = useState<string | null>(null)
  const [prepareTarget, setPrepareTarget] = useState<LibraryRecording | null>(null)

  useEffect(() => {
    // Load the library once on mount. We call getState() directly to avoid
    // re-running this effect when the store reference changes.
    void useLibraryStore.getState().load()
  }, [])

  const filtered = useMemo(() => {
    const searched = store.recordings.filter(
      (r) => matchesSearch(r, store.search) && matchesTag(r, store.tagFilter),
    )
    return sortRecordings(searched, store.sort)
  }, [store.recordings, store.search, store.sort, store.tagFilter])

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
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label className="mb-1 block text-sm font-medium" htmlFor="library-search">
            Search
          </label>
          <Input
            id="library-search"
            placeholder="Search by name, tag, or session"
            value={store.search}
            onChange={(e) => store.setSearch(e.target.value)}
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="library-sort">
            Sort by
          </label>
          <select
            id="library-sort"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
            value={store.sort}
            onChange={(e) => store.setSort(e.target.value as LibrarySort)}
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="duration">Longest duration</option>
            <option value="size">Largest size</option>
          </select>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="library-tag-filter">
            Filter by tag
          </label>
          <Input
            id="library-tag-filter"
            placeholder="Tag"
            value={store.tagFilter}
            onChange={(e) => store.setTagFilter(e.target.value)}
          />
        </div>

        <div className="flex gap-2">
          <Button
            variant={viewMode === "grid" ? "primary" : "secondary"}
            onClick={() => setViewMode("grid")}
          >
            Grid
          </Button>
          <Button
            variant={viewMode === "list" ? "primary" : "secondary"}
            onClick={() => setViewMode("list")}
          >
            List
          </Button>
        </div>
      </div>

      {store.error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-900 dark:bg-red-950">
          {store.error}
          <button type="button" className="ml-2 underline" onClick={store.clearError}>
            Dismiss
          </button>
        </div>
      ) : null}

      {trimTarget ? (
        <div className="rounded-lg border border-border bg-muted p-4">
          <h3 className="mb-2 text-sm font-medium">Trim {trimTarget.name}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium" htmlFor="trim-start">
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
              <label className="mb-1 block text-xs font-medium" htmlFor="trim-end">
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
          {trimError ? <p className="mt-2 text-sm text-red-600">{trimError}</p> : null}
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

      {store.isLoading && store.recordings.length === 0 ? (
        <p className="text-sm text-foreground/70">Loading recordings...</p>
      ) : null}

      {filtered.length === 0 && !store.isLoading ? (
        <p className="text-sm text-foreground/70">No recordings found.</p>
      ) : null}

      {viewMode === "grid" ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
    </section>
  )
}
