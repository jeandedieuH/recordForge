import { useState } from "react"
import {
  Copy,
  FolderOpen as FolderIcon,
  Layers,
  MoreVertical,
  Pencil,
  Play,
  Scissors,
  Trash2,
  Film,
} from "lucide-react"
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
} from "@recordforge/ui"
import type { ProjectSummary } from "@recordforge/contracts"
import { formatDate, formatDuration } from "../../lib/format"
import { toAssetUrl } from "../editor/media/derivative-resources"

interface ProjectCardProps {
  project: ProjectSummary
  onOpen: (recordingId: string) => void
  onRename: (recordingId: string, newName: string) => void
  onDuplicate: (recordingId: string, newName?: string) => void
  onDelete: (recordingId: string) => void
  onReveal: (recordingId: string) => void
}

export function ProjectCard({
  project,
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
  onReveal,
}: ProjectCardProps) {
  const [imageError, setImageError] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(project.name)

  const thumbnailSrc =
    !imageError && project.thumbnailPath ? toAssetUrl(project.thumbnailPath) : null

  function handleSaveRename() {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== project.name) {
      onRename(project.recordingId, trimmed)
    }
    setIsRenaming(false)
  }

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-xl border border-border bg-surface transition-all duration-200 hover:border-border-strong hover:shadow-xl">
      {/* Thumbnail Container */}
      <div className="relative aspect-video w-full overflow-hidden bg-background">
        {thumbnailSrc ? (
          <img
            src={thumbnailSrc}
            alt={project.name}
            onError={() => setImageError(true)}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className="relative flex h-full w-full items-center justify-center bg-linear-to-br from-surface to-background p-4 text-muted-foreground">
            <div className="absolute inset-0 opacity-15 bg-[radial-gradient(var(--color-primary)_1px,transparent_1px)] bg-size-[12px_12px]" />
            <div className="z-10 flex flex-col items-center gap-1.5 rounded-lg border border-border bg-surface/80 px-4 py-2 text-center backdrop-blur">
              <Film className="size-5 text-primary/70" />
              <span className="text-xs font-semibold text-foreground truncate max-w-45">
                {project.name}
              </span>
              {project.width && project.height ? (
                <span className="text-[10px] font-mono text-muted-foreground">
                  {project.width}x{project.height} • {project.fps ?? 30}fps
                </span>
              ) : null}
            </div>
          </div>
        )}

        {/* Duration Overlay Pill */}
        {project.durationMs > 0 ? (
          <div className="absolute bottom-2 right-2 rounded bg-black/85 px-2 py-0.5 text-xs font-mono font-medium text-white shadow">
            {formatDuration(project.durationMs)}
          </div>
        ) : null}

        {/* Hover Play / Editor Overlay */}
        <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/60 opacity-0 transition-opacity group-hover:opacity-100 backdrop-blur-[2px]">
          <button
            type="button"
            onClick={() => onOpen(project.recordingId)}
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
            {isRenaming ? (
              <div className="flex items-center gap-1.5">
                <Input
                  className="h-7 text-xs font-semibold text-foreground"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveRename()
                    if (e.key === "Escape") setIsRenaming(false)
                  }}
                />
                <Button size="sm" className="h-7 px-2 text-xs" onClick={handleSaveRename}>
                  Save
                </Button>
              </div>
            ) : (
              <>
                <h3
                  className="truncate font-sans text-sm font-semibold text-foreground cursor-pointer hover:text-primary transition-colors"
                  title={project.name}
                  onClick={() => onOpen(project.recordingId)}
                >
                  {project.name}
                </h3>
                <p className="mt-0.5 text-xs font-medium text-subtle-foreground">
                  Updated {formatDate(project.updatedAt)}
                </p>
              </>
            )}
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="rounded p-1 text-muted-foreground hover:bg-overlay hover:text-foreground"
                aria-label="More project options"
              >
                <MoreVertical className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="border-border-strong bg-surface text-foreground"
            >
              <DropdownMenuItem onClick={() => onOpen(project.recordingId)}>
                <Scissors className="mr-2 size-4 text-primary" /> Open Editor
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setIsRenaming(true)}>
                <Pencil className="mr-2 size-4 text-subtle-foreground" /> Rename
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onDuplicate(project.recordingId, `${project.name} (Copy)`)}>
                <Copy className="mr-2 size-4 text-subtle-foreground" /> Duplicate
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onReveal(project.recordingId)}>
                <FolderIcon className="mr-2 size-4 text-subtle-foreground" /> Reveal Files
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => onDelete(project.recordingId)}
                className="text-red-400 focus:text-red-400 focus:bg-red-950/30"
              >
                <Trash2 className="mr-2 size-4" /> Delete Project
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Stats Pill / Track Info */}
        <div className="mt-1 flex items-center gap-2">
          <div className="inline-flex items-center gap-1 rounded border border-border bg-surface-container-high px-2 py-0.5 text-[10px] font-mono font-medium text-subtle-foreground">
            <Layers className="size-3" />
            <span>
              {project.trackCount} {project.trackCount === 1 ? "track" : "tracks"} · {project.clipCount} {project.clipCount === 1 ? "clip" : "clips"}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
