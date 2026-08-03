import { useState } from "react"
import { Video } from "lucide-react"
import { Button, Input } from "@recordforge/ui"
import type { LibraryRecording } from "@recordforge/contracts"
import { formatDate, formatDuration, formatFileSize } from "../../lib/format"

interface LibraryItemCardProps {
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

// Card layout for a library recording. Suitable for the grid view.
export function LibraryItemCard({
  recording,
  onDelete,
  onReveal,
  onTrim,
  onExport,
  onPrepare,
  onOpenEditor,
  onAddTag,
  onRemoveTag,
}: LibraryItemCardProps) {
  const [newTag, setNewTag] = useState("")

  function handleAddTag() {
    const tag = newTag.trim()
    if (!tag) return
    onAddTag(recording.id, tag)
    setNewTag("")
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted p-4">
      <div className="aspect-video rounded bg-background flex items-center justify-center">
        <Video className="size-10 text-foreground/40" aria-hidden />
      </div>

      <div>
        <h3 className="font-semibold" title={recording.name}>
          {recording.name}
        </h3>
        <p className="text-sm text-foreground/70">{formatDate(recording.createdAt)}</p>
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <span className="text-foreground/70">Duration</span>
          <p className="font-medium">{formatDuration(recording.durationMs)}</p>
        </div>
        <div>
          <span className="text-foreground/70">Size</span>
          <p className="font-medium">{formatFileSize(recording.sizeBytes)}</p>
        </div>
        <div>
          <span className="text-foreground/70">Resolution</span>
          <p className="font-medium">
            {recording.width}x{recording.height} @ {recording.fps}fps
          </p>
        </div>
        <div>
          <span className="text-foreground/70">Status</span>
          <p className="font-medium capitalize">{recording.status}</p>
        </div>
      </div>

      {recording.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1">
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

      <div className="flex gap-2">
        <Input
          className="flex-1"
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
        <div>
          <h4 className="mb-1 text-xs font-medium text-foreground/70">Markers</h4>
          <ul className="space-y-1 text-xs">
            {recording.markers.map((marker) => (
              <li key={marker.id} className="flex items-center gap-2">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
                <span className="font-medium">{marker.label}</span>
                <span className="text-foreground/70">@ {formatDuration(marker.timestampMs)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-auto flex flex-wrap gap-2">
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
