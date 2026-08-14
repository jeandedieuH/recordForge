import { useEffect, useMemo, useState } from "react"
import { LayoutGrid, List, Plus, Search, Layers } from "lucide-react"
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@recordforge/ui"
import type { ProjectSummary } from "@recordforge/contracts"
import { ProjectCard } from "./project-card"
import { ProjectRow } from "./project-row"
import { useProjectsStore, type ProjectSort } from "./use-projects"

function matchesSearch(project: ProjectSummary, query: string) {
  if (!query) return true
  const lower = query.toLowerCase()
  return (
    project.name.toLowerCase().includes(lower) ||
    project.recordingId.toLowerCase().includes(lower) ||
    project.id.toLowerCase().includes(lower)
  )
}

function sortProjects(projects: ProjectSummary[], sort: ProjectSort) {
  const copy = [...projects]
  switch (sort) {
    case "updated":
      return copy.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    case "newest":
      return copy.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    case "name":
      return copy.sort((a, b) => a.name.localeCompare(b.name))
    case "duration":
      return copy.sort((a, b) => b.durationMs - a.durationMs)
    default:
      return copy
  }
}

interface ProjectsViewProps {
  onOpenProject: (recordingId: string) => void
  onNavigateToLibrary?: () => void
}

export function ProjectsView({ onOpenProject, onNavigateToLibrary }: ProjectsViewProps) {
  const store = useProjectsStore()
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid")

  useEffect(() => {
    void useProjectsStore.getState().load()
  }, [])

  const filtered = useMemo(() => {
    const searched = store.projects.filter((p) => matchesSearch(p, store.search))
    return sortProjects(searched, store.sort)
  }, [store.projects, store.search, store.sort])

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto w-full">
      {/* Header & Controls */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-serif text-2xl font-bold tracking-tight text-foreground">
            Timeline Projects
          </h2>
          <p className="text-xs text-subtle-foreground mt-0.5">
            Manage your editable recording sessions, timeline cuts, and project snapshots.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="relative w-48 sm:w-64">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle-foreground" />
            <Input
              type="text"
              placeholder="Search projects…"
              value={store.search}
              onChange={(e) => store.setSearch(e.target.value)}
              className="h-8 pl-8 text-xs"
            />
          </div>

          {/* Sort */}
          <Select value={store.sort} onValueChange={(val) => store.setSort(val as ProjectSort)}>
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="updated">Recently Edited</SelectItem>
              <SelectItem value="newest">Newest Created</SelectItem>
              <SelectItem value="name">Name (A-Z)</SelectItem>
              <SelectItem value="duration">Duration</SelectItem>
            </SelectContent>
          </Select>

          {/* View Mode Toggle */}
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
              aria-label="Grid View"
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
              aria-label="List View"
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

      {/* Grid or List of Projects */}
      {!store.isLoading && filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-surface p-12 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-surface-dim border border-border/80 text-muted-foreground mb-3">
            <Layers className="size-6 text-subtle-foreground" />
          </div>
          <h3 className="text-sm font-semibold text-foreground">No timeline projects found</h3>
          <p className="mt-1 text-xs text-subtle-foreground max-w-sm mx-auto">
            {store.search
              ? "No projects match your search query."
              : "Open any recording from your Library to create an editable timeline project."}
          </p>
          {onNavigateToLibrary && !store.search ? (
            <Button onClick={onNavigateToLibrary} className="mt-4 h-8 px-4 text-xs font-semibold">
              <Plus className="mr-1.5 size-3.5" /> Go to Library
            </Button>
          ) : null}
        </div>
      ) : null}

      {filtered.length > 0 && viewMode === "grid" ? (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onOpen={onOpenProject}
              onRename={store.rename}
              onDuplicate={store.duplicate}
              onDelete={store.delete}
              onReveal={store.reveal}
            />
          ))}
        </div>
      ) : filtered.length > 0 ? (
        <div className="space-y-3">
          {filtered.map((project) => (
            <ProjectRow
              key={project.id}
              project={project}
              onOpen={onOpenProject}
              onRename={store.rename}
              onDuplicate={store.duplicate}
              onDelete={store.delete}
              onReveal={store.reveal}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
