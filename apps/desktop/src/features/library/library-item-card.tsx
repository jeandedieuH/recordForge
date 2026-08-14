import { useState } from "react"
import {
  CloudCheck,
  Download,
  Film,
  FolderOpen as FolderIcon,
  MoreVertical,
  Music,
  Play,
  Scissors,
  Sparkles,
  Trash2,
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@recordforge/ui"
import type { LibraryRecording } from "@recordforge/contracts"
import { formatDate, formatDuration } from "../../lib/format"
import { toAssetUrl } from "../editor/media/derivative-resources"

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

export function LibraryItemCard({
  recording,
  onDelete,
  onReveal,
  onTrim,
  onExport,
  onPrepare,
  onOpenEditor,
}: LibraryItemCardProps) {
  const [imageError, setImageError] = useState(false)
  const isAudio =
    recording.tags.includes("audio") ||
    recording.name.toLowerCase().includes("voiceover") ||
    recording.name.toLowerCase().includes("audio")
  const isUploaded =
    recording.tags.includes("uploaded") ||
    recording.tags.includes("s3") ||
    recording.tags.includes("gdrive")

  const thumbnailSrc =
    !imageError && recording.thumbnailPath ? toAssetUrl(recording.thumbnailPath) : null

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-xl border border-border bg-surface transition-all duration-200 hover:border-border-strong hover:shadow-xl">
      {/* Thumbnail Container */}
      <div className="relative aspect-video w-full overflow-hidden bg-background">
        {isAudio ? (
          <div className="flex h-full w-full items-center justify-center bg-surface-dim text-muted-foreground">
            <Music className="size-10 text-subtle-foreground" />
          </div>
        ) : thumbnailSrc ? (
          <img
            src={thumbnailSrc}
            alt={recording.name}
            onError={() => setImageError(true)}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className="relative flex h-full w-full items-center justify-center bg-linear-to-br from-surface to-background p-4 text-muted-foreground">
            {/* Tech preview background grid pattern */}
            <div className="absolute inset-0 opacity-15 bg-[radial-gradient(var(--color-primary)_1px,transparent_1px)] bg-size-[12px_12px]" />
            <div className="z-10 flex flex-col items-center gap-1.5 rounded-lg border border-border bg-surface/80 px-4 py-2 text-center backdrop-blur">
              <Film className="size-5 text-primary/70" />
              <span className="text-xs font-semibold text-foreground truncate max-w-45">
                {recording.name}
              </span>
              <span className="text-[10px] font-mono text-muted-foreground">
                {recording.width}x{recording.height} • {recording.fps}fps
              </span>
            </div>
          </div>
        )}

        {/* Duration Overlay Pill */}
        <div className="absolute bottom-2 right-2 rounded bg-black/85 px-2 py-0.5 text-xs font-mono font-medium text-white shadow">
          {formatDuration(recording.durationMs)}
        </div>

        {/* Hover Play / Editor Overlay */}
        <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/60 opacity-0 transition-opacity group-hover:opacity-100 backdrop-blur-[2px]">
          <button
            type="button"
            onClick={() => onOpenEditor(recording)}
            className="flex size-10 items-center justify-center rounded-full bg-primary text-white transition-transform hover:scale-105"
            title="Open in Editor"
            aria-label="Open in Editor"
          >
            <Play className="size-5 ml-0.5 fill-white" />
          </button>
        </div>
      </div>

      {/* Card Details */}
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h3
              className="truncate font-sans text-sm font-semibold text-foreground"
              title={recording.name}
            >
              {recording.name}
            </h3>
            <p className="mt-0.5 text-xs font-medium text-subtle-foreground">
              {formatDate(recording.createdAt)}
            </p>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="rounded p-1 text-muted-foreground hover:bg-overlay hover:text-foreground"
                aria-label="More recording options"
              >
                <MoreVertical className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="border-border-strong bg-surface text-foreground"
            >
              <DropdownMenuItem onClick={() => onOpenEditor(recording)}>
                <Scissors className="mr-2 size-4 text-primary" /> Open Editor
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onReveal(recording.id)}>
                <FolderIcon className="mr-2 size-4 text-subtle-foreground" /> Reveal File
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onTrim(recording)}>
                <Scissors className="mr-2 size-4 text-subtle-foreground" /> Quick Trim
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onExport(recording)}>
                <Download className="mr-2 size-4 text-subtle-foreground" /> Export MP4
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onPrepare(recording)}>
                <Sparkles className="mr-2 size-4 text-sky-400" /> Prepare Media
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => onDelete(recording.id)}
                className="text-red-400 focus:text-red-400 focus:bg-red-950/30"
              >
                <Trash2 className="mr-2 size-4" /> Delete Recording
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Status Badge Tag */}
        <div className="mt-1 flex items-center">
          {isUploaded ? (
            <div className="inline-flex items-center gap-1.5 rounded border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] font-mono font-semibold tracking-wider text-success uppercase">
              <CloudCheck className="size-3" />
              <span>Uploaded</span>
            </div>
          ) : (
            <div className="inline-flex items-center gap-1 rounded border border-border bg-surface-container-high px-2 py-0.5 text-[10px] font-mono font-semibold tracking-wider text-muted-foreground uppercase">
              <span>Local-Only</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
