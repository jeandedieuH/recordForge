import { useState } from "react"
import {
  Copy,
  Film,
  FolderOpen as FolderIcon,
  Layers,
  MoreVertical,
  Pencil,
  Scissors,
  Trash2,
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

interface ProjectRowProps {
  project: ProjectSummary
  onOpen: (recordingId: string) => void
  onRename: (recordingId: string, newName: string) => void
  onDuplicate: (recordingId: string, newName?: string) => void
  onDelete: (recordingId: string) => void
  onReveal: (recordingId: string) => void
}

export function ProjectRow({
  project,
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
  onReveal,
}: ProjectRowProps) {
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
    <div className="group flex flex-col gap-3 rounded-xl border border-border bg-surface p-3.5 transition-all duration-200 hover:border-border-strong hover:shadow-md sm:flex-row sm:items-center sm:justify-between">
      {/* Thumbnail + Details */}
      <div className="flex flex-1 items-center gap-3.5 min-w-0">
        <div className="relative flex h-14 w-20 shrink-0 items-center justify-center rounded-lg bg-surface-dim border border-border/60 text-muted-foreground overflow-hidden">
          {thumbnailSrc ? (
            <img
              src={thumbnailSrc}
              alt={project.name}
              onError={() => setImageError(true)}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <Film className="size-6 text-subtle-foreground" aria-hidden />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {isRenaming ? (
              <div className="flex items-center gap-1.5 max-w-sm">
                <Input
                  className="h-6 px-1.5 text-xs font-semibold"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveRename()
                    if (e.key === "Escape") setIsRenaming(false)
                  }}
                />
                <Button size="sm" className="h-6 px-2 text-[10px]" onClick={handleSaveRename}>
                  Save
                </Button>
              </div>
            ) : (
              <h3
                className="truncate font-sans text-sm font-semibold text-foreground cursor-pointer hover:text-primary transition-colors"
                title={project.name}
                onClick={() => onOpen(project.recordingId)}
              >
                {project.name}
              </h3>
            )}
            {project.durationMs > 0 ? (
              <span className="shrink-0 rounded bg-overlay px-1.5 py-0.5 font-mono text-[10px] font-medium text-subtle-foreground">
                {formatDuration(project.durationMs)}
              </span>
            ) : null}
          </div>

          <div className="mt-1 flex items-center gap-3 text-xs text-subtle-foreground">
            <span>Updated {formatDate(project.updatedAt)}</span>
            <span>·</span>
            <span className="inline-flex items-center gap-1">
              <Layers className="size-3" />
              {project.trackCount} {project.trackCount === 1 ? "track" : "tracks"} · {project.clipCount} {project.clipCount === 1 ? "clip" : "clips"}
            </span>
            {project.width && project.height ? (
              <>
                <span>·</span>
                <span className="font-mono text-[10px]">
                  {project.width}x{project.height}
                </span>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 shrink-0 border-t border-border/40 pt-2 sm:border-t-0 sm:pt-0">
        <Button
          onClick={() => onOpen(project.recordingId)}
          className="h-8 px-3.5 text-xs font-semibold bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm"
        >
          <Scissors className="mr-1.5 size-3.5" /> Editor
        </Button>

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
    </div>
  )
}
