import { useState } from "react"
import {
  FolderOpen as FolderIcon,
  MoreVertical,
  Music,
  Plus,
  Scissors,
  Trash2,
  Video,
  Cloud,
} from "lucide-react"
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
} from "@recordforge/ui"
import type { LibraryRecording } from "@recordforge/contracts"
import { formatDate, formatDuration, formatFileSize } from "../../lib/format"
import { toAssetUrl } from "../editor/media/derivative-resources"

interface LibraryItemRowProps {
  recording: LibraryRecording
  onDelete: (recordingId: string) => void
  onReveal: (recordingId: string) => void
  onTrim: (recording: LibraryRecording) => void
  onExport: (recording: LibraryRecording) => void
  onPrepare: (recording: LibraryRecording) => void
  onOpenEditor: (recording: LibraryRecording) => void
  onUpload?: (recording: LibraryRecording) => void
  onAddTag: (recordingId: string, tag: string) => void
  onRemoveTag: (recordingId: string, tag: string) => void
}

export function LibraryItemRow({
  recording,
  onDelete,
  onReveal,
  onTrim,
  onExport,
  onPrepare,
  onOpenEditor,
  onUpload,
  onAddTag,
  onRemoveTag,
}: LibraryItemRowProps) {
  const [newTag, setNewTag] = useState("")
  const [showTagInput, setShowTagInput] = useState(false)
  const [imageError, setImageError] = useState(false)

  const isAudio =
    recording.tags.includes("audio") ||
    recording.name.toLowerCase().includes("voiceover") ||
    recording.name.toLowerCase().includes("audio")

  const thumbnailSrc =
    !imageError && recording.thumbnailPath
      ? toAssetUrl(recording.thumbnailPath, recording.workDir)
      : null

  function handleAddTag() {
    const tag = newTag.trim()
    if (!tag) return
    onAddTag(recording.id, tag)
    setNewTag("")
    setShowTagInput(false)
  }

  return (
    <div className="group flex flex-col gap-3 rounded-xl border border-border bg-surface p-3.5 transition-all duration-200 hover:border-border-strong hover:shadow-md sm:flex-row sm:items-center sm:justify-between">
      {/* Thumbnail + Details */}
      <div className="flex flex-1 items-center gap-3.5 min-w-0">
        <div className="relative flex h-14 w-20 shrink-0 items-center justify-center rounded-lg bg-surface-dim border border-border/60 text-muted-foreground overflow-hidden">
          {isAudio ? (
            <Music className="size-6 text-subtle-foreground" />
          ) : thumbnailSrc ? (
            <img
              src={thumbnailSrc}
              alt={recording.name}
              onError={() => setImageError(true)}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <Video className="size-6 text-subtle-foreground" aria-hidden />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3
              className="truncate font-sans text-sm font-semibold text-foreground"
              title={recording.name}
            >
              {recording.name}
            </h3>
            <span className="shrink-0 rounded bg-overlay px-1.5 py-0.5 font-mono text-[10px] font-medium text-subtle-foreground">
              {formatDuration(recording.durationMs)}
            </span>
          </div>

          <p className="mt-0.5 text-xs text-subtle-foreground truncate">
            {formatDate(recording.createdAt)} · {formatFileSize(recording.sizeBytes)} ·{" "}
            {recording.width}x{recording.height} @{recording.fps}fps
          </p>

          {/* Tags & Add Tag Action */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {recording.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 rounded border border-border bg-overlay px-2 py-0.5 text-[10px] font-medium text-foreground"
              >
                {tag}
                <button
                  type="button"
                  className="text-subtle-foreground hover:text-red-400"
                  onClick={() => onRemoveTag(recording.id, tag)}
                  aria-label={`Remove ${tag}`}
                >
                  ×
                </button>
              </span>
            ))}

            {showTagInput ? (
              <div className="flex items-center gap-1">
                <Input
                  className="h-6 w-24 px-1.5 text-[11px]"
                  placeholder="Tag..."
                  value={newTag}
                  autoFocus
                  onChange={(e) => setNewTag(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAddTag()
                    if (e.key === "Escape") setShowTagInput(false)
                  }}
                />
                <Button size="sm" className="h-6 px-2 text-[10px]" onClick={handleAddTag}>
                  Add
                </Button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowTagInput(true)}
                className="inline-flex items-center gap-0.5 text-[10px] font-medium text-subtle-foreground hover:text-foreground"
              >
                <Plus className="size-3" /> Add tag
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Action Toolbar */}
      <div className="flex items-center justify-end gap-2 shrink-0 border-t border-border/40 pt-2 sm:border-t-0 sm:pt-0">
        <Button
          onClick={() => onOpenEditor(recording)}
          className="h-8 px-3.5 text-xs font-semibold bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm"
        >
          <Scissors className="mr-1.5 size-3.5" /> Editor
        </Button>

        <Button
          variant="secondary"
          onClick={() => onExport(recording)}
          className="h-8 px-3 text-xs rounded-lg border-border"
        >
          Export
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex size-8 items-center justify-center rounded-lg border border-border bg-surface hover:bg-overlay text-muted-foreground hover:text-foreground transition-colors"
              aria-label="More options"
            >
              <MoreVertical className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="border-border-strong bg-surface text-foreground"
          >
            <DropdownMenuItem onClick={() => onReveal(recording.id)}>
              <FolderIcon className="mr-2 size-4" /> Reveal File
            </DropdownMenuItem>
            {onUpload ? (
              <DropdownMenuItem onClick={() => onUpload(recording)}>
                <Cloud className="mr-2 size-4 text-primary" /> Upload to Cloud
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onClick={() => onTrim(recording)}>Trim Video</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onPrepare(recording)}>Prepare Media</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onDelete(recording.id)} className="text-red-400">
              <Trash2 className="mr-2 size-4 text-red-400" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
