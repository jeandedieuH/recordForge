import { useState } from "react"
import { Button, Input } from "@recordforge/ui"
import type { LibraryRecording } from "@recordforge/contracts"
import { formatDate, formatDuration, formatFileSize } from "../../lib/format"

interface LibraryItemRowProps {
  recording: LibraryRecording
  onDelete: (recordingId: string) => void
  onReveal: (recordingId: string) => void
  onTrim: (recording: LibraryRecording) => void
  onExport: (recording: LibraryRecording) => void
  onPrepare: (recording: LibraryRecording) => void
  onOpenEditor: (recording: LibraryRecording) => void
  onAddTag: (recordingId: string, tag: string) => void
  onRemoveTag: (recordingId: string, tag: string) => void
}

// Horizontal row layout for a library recording. Suitable for the list view.
export function LibraryItemRow({
  recording,
  onDelete,
  onReveal,
  onTrim,
  onExport,
  onPrepare,
  onOpenEditor,
  onAddTag,
  onRemoveTag,
}: LibraryItemRowProps) {
  const [newTag, setNewTag] = useState("")

  function handleAddTag() {
    const tag = newTag.trim()
    if (!tag) return
    onAddTag(recording.id, tag)
    setNewTag("")
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted p-3 sm:flex-row sm:items-start sm:gap-4">
      <div className="flex h-16 w-24 shrink-0 items-center justify-center rounded bg-background text-2xl">
        🎬
      </div>

      <div className="min-w-0 flex-1">
        <h3 className="truncate font-semibold" title={recording.name}>
          {recording.name}
        </h3>
        <p className="text-sm text-foreground/70">
          {formatDate(recording.createdAt)} · {formatDuration(recording.durationMs)} ·{" "}
          {formatFileSize(recording.sizeBytes)} · {recording.width}x{recording.height} @
          {recording.fps}fps
        </p>

        {recording.tags.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {recording.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 rounded-full bg-background px-2 py-0.5 text-xs"
              >
                {tag}
                <button
                  type="button"
                  className="text-foreground/70 hover:text-red-600"
                  onClick={() => onRemoveTag(recording.id, tag)}
                  aria-label={`Remove ${tag}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="mt-2 flex gap-2">
          <Input
            className="max-w-48"
            placeholder="Add tag"
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddTag()
            }}
          />
          <Button onClick={handleAddTag} disabled={!newTag.trim()}>
            Add
          </Button>
        </div>

        {recording.markers.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-2 text-xs">
            {recording.markers.map((marker) => (
              <li key={marker.id} className="flex items-center gap-1">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
                <span className="font-medium">{marker.label}</span>
                <span className="text-foreground/70">@ {formatDuration(marker.timestampMs)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2 sm:flex-col sm:items-end">
        <Button variant="ghost" onClick={() => onReveal(recording.id)}>
          Reveal
        </Button>
        <Button variant="secondary" onClick={() => onTrim(recording)}>
          Trim
        </Button>
        <Button variant="secondary" onClick={() => onExport(recording)}>
          Export
        </Button>
        <Button variant="secondary" onClick={() => onPrepare(recording)}>
          Prepare
        </Button>
        <Button variant="secondary" onClick={() => onOpenEditor(recording)}>
          Editor
        </Button>
        <Button variant="ghost" onClick={() => onDelete(recording.id)}>
          Delete
        </Button>
      </div>
    </div>
  )
}
