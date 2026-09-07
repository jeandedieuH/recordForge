import { useMemo, useState } from "react"
import { getTitlePresetGroup, type TextClip, type TextPresetRecord } from "@recordforge/editor-core"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  EmptyState,
  IconButton,
  Input,
  NativeSelect,
  Skeleton,
  ToggleGroup,
  ToggleGroupItem,
  cn,
  useToast,
} from "@recordforge/ui"
import { Search, Star, Trash2, Type, X } from "lucide-react"
import { useTimelineStore } from "../../../stores/timeline-store"
import { TitlePreview } from "./title-preview"
import { TitleSelectedPreview } from "./title-selected-preview"
import {
  filterTitlePresets,
  TITLE_GROUPS,
  useTitleLibraryState,
  useTitleRegistry,
  type TitleCollection,
} from "./title-library-state"
import type { TitleReplaceOptions } from "./title-preview-plan"

export interface TitlePresetBrowserProps {
  selectedPresetId?: string
  onAdd?: (preset: TextPresetRecord) => void
  onReplace?: (preset: TextPresetRecord, options?: TitleReplaceOptions) => void
  className?: string
  previewClip?: TextClip
}

/** Browsing is deliberately non-mutating: only the explicit action buttons edit the timeline. */
export function TitlePresetBrowser({
  selectedPresetId,
  onAdd,
  onReplace,
  className,
  previewClip,
}: TitlePresetBrowserProps) {
  const { registry, snapshot, isLoading, error, retry } = useTitleRegistry()
  const { query, group, collection, recentIds, setFilters, forget } = useTitleLibraryState()
  const { toast } = useToast()
  const [previewId, setPreviewId] = useState<string | undefined>(selectedPresetId)
  const [activePreviewId, setActivePreviewId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<TextPresetRecord | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [page, setPage] = useState(1)
  const canvasWidth = useTimelineStore(
    (state) => state.engine?.history.present.canvas.width ?? 1920,
  )
  const canvasHeight = useTimelineStore(
    (state) => state.engine?.history.present.canvas.height ?? 1080,
  )
  const presets = useMemo(
    () => filterTitlePresets({ ...snapshot, query, group, collection, recentIds }),
    [snapshot, query, group, collection, recentIds],
  )
  const selected =
    snapshot.presets.find((preset) => preset.id === (previewId ?? selectedPresetId)) ?? presets[0]
  const displayed = presets.slice(0, page * 24)

  function clearFilters() {
    setFilters({ query: "", group: "all", collection: "all" })
    setPage(1)
  }
  async function toggleFavorite(preset: TextPresetRecord) {
    try {
      await registry.toggleFavorite(preset.id)
    } catch {
      toast({
        title: "Favorite could not be saved",
        description: "Try again before closing the editor.",
        variant: "error",
      })
    }
  }
  async function deletePreset() {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    try {
      await registry.deleteCustomPreset(deleteTarget.id)
      forget(deleteTarget.id)
      if (previewId === deleteTarget.id) setPreviewId(undefined)
      setDeleteTarget(null)
      toast({
        title: "Custom title deleted",
        description: "Titles already on your timeline are unchanged.",
      })
    } catch {
      toast({
        title: "Custom title could not be deleted",
        description: "Your saved presets could not be updated. Try again.",
        variant: "error",
      })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-3 overflow-hidden", className)}>
      <div className="flex shrink-0 flex-col gap-2">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            name="title-search"
            autoComplete="off"
            aria-label="Search text and titles"
            placeholder="Search titles, steps, shortcuts…"
            className="h-8 pl-8 pr-8 text-xs"
            value={query}
            onChange={(event) => {
              setFilters({ query: event.target.value })
              setPage(1)
            }}
          />
          {query ? (
            <IconButton
              label="Clear title search"
              className="absolute right-1 top-1/2 size-6 -translate-y-1/2"
              onClick={() => setFilters({ query: "" })}
            >
              <X className="size-3" aria-hidden />
            </IconButton>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            type="single"
            value={collection}
            onValueChange={(value) => {
              if (value) {
                setFilters({ collection: value as TitleCollection })
                setPage(1)
              }
            }}
            aria-label="Title collection"
            className="flex flex-wrap justify-start gap-1"
          >
            {(["all", "favorites", "recent", "custom"] as const).map((value) => (
              <ToggleGroupItem key={value} value={value} className="h-7 px-2 text-xs">
                {capitalize(value)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <NativeSelect
            aria-label="Title purpose"
            value={group}
            className="h-8 min-w-0 flex-1 text-xs"
            onChange={(event) => {
              setFilters({ group: event.target.value })
              setPage(1)
            }}
          >
            <option value="all">All Purposes</option>
            {TITLE_GROUPS.map((value) => (
              <option key={value} value={value}>
                {capitalize(value)}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain pr-1">
        {isLoading ? (
          <div className="grid grid-cols-2 gap-2" aria-label="Loading titles" aria-busy="true">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="aspect-video rounded-lg" />
            ))}
          </div>
        ) : error ? (
          <EmptyState
            icon={Type}
            title="Titles could not load"
            description={error}
            action={
              <Button size="sm" variant="outline" onClick={retry}>
                Retry Titles
              </Button>
            }
          />
        ) : snapshot.presets.length === 0 ? (
          <EmptyState
            icon={Type}
            title="No titles yet"
            description="Add text to your timeline to get started."
            action={
              <Button size="sm" variant="outline" onClick={retry}>
                Refresh Titles
              </Button>
            }
          />
        ) : presets.length === 0 ? (
          <EmptyState
            icon={Search}
            title={
              collection === "favorites"
                ? "No matching favorites"
                : collection === "recent"
                  ? "No recently used titles"
                  : collection === "custom"
                    ? "No matching custom titles"
                    : "No matching titles"
            }
            description={
              collection === "recent"
                ? "Titles you add or replace appear here. Only preset IDs are stored on this device."
                : collection === "custom"
                  ? "Save a selected title as a custom preset, or try a different search."
                  : "Try a different search or purpose."
            }
            action={
              <Button size="sm" variant="outline" onClick={clearFilters}>
                Clear Filters
              </Button>
            }
          />
        ) : (
          <>
            {selected ? (
              <TitleSelectedPreview
                key={`${selected.id}:${previewClip?.id ?? "sample"}`}
                preset={selected}
                previewClip={previewClip}
                canvasWidth={previewClip ? canvasWidth : 1920}
                canvasHeight={previewClip ? canvasHeight : 1080}
                onAdd={onAdd}
                onReplace={onReplace}
              />
            ) : null}
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span aria-live="polite">
                {presets.length} {presets.length === 1 ? "title" : "titles"}
              </span>
              <span>Select to preview</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {displayed.map((preset) => {
                const favorite = snapshot.favoriteIds.includes(preset.id)
                const custom = snapshot.customPresetIds.includes(preset.id)
                return (
                  <article
                    key={preset.id}
                    className={cn(
                      "min-w-0 overflow-hidden rounded-lg border bg-surface-container-low",
                      selected?.id === preset.id ? "border-primary" : "border-border",
                    )}
                  >
                    <button
                      type="button"
                      aria-label={`Preview ${preset.name}`}
                      aria-pressed={selected?.id === preset.id}
                      className="flex w-full min-w-0 flex-col gap-2 rounded-md p-1.5 text-left outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                      onClick={() => setPreviewId(preset.id)}
                      onPointerEnter={() => setActivePreviewId(preset.id)}
                      onPointerLeave={() => setActivePreviewId(null)}
                      onFocus={() => setActivePreviewId(preset.id)}
                      onBlur={() => setActivePreviewId(null)}
                    >
                      <TitlePreview
                        preset={preset}
                        playing={activePreviewId === preset.id}
                        interactiveRetry={false}
                      />
                      <span className="w-full truncate px-0.5 text-xs font-medium text-foreground">
                        {preset.name}
                      </span>
                    </button>
                    <div className="flex items-center gap-1 px-2 pb-1.5">
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {custom
                          ? "Custom"
                          : capitalize(
                              getTitlePresetGroup(preset.definition.titleDesign?.template),
                            )}
                      </span>
                      <IconButton
                        label={`${favorite ? "Unfavorite" : "Favorite"} ${preset.name}`}
                        aria-pressed={favorite}
                        className="size-6 shrink-0"
                        onClick={() => void toggleFavorite(preset)}
                      >
                        <Star
                          className={cn("size-3", favorite && "fill-warning text-warning")}
                          aria-hidden
                        />
                      </IconButton>
                      {custom ? (
                        <IconButton
                          label={`Delete ${preset.name}`}
                          className="size-6 shrink-0"
                          onClick={() => setDeleteTarget(preset)}
                        >
                          <Trash2 className="size-3" aria-hidden />
                        </IconButton>
                      ) : null}
                    </div>
                  </article>
                )
              })}
            </div>
            {displayed.length < presets.length ? (
              <Button size="sm" variant="outline" onClick={() => setPage((value) => value + 1)}>
                Show More Titles
              </Button>
            ) : null}
          </>
        )}
      </div>
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete custom title?</AlertDialogTitle>
            <AlertDialogDescription>
              Delete “{deleteTarget?.name}” from your library? Existing timeline titles will not
              change. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault()
                void deletePreset()
              }}
            >
              {deleting ? "Deleting…" : "Delete Title"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
