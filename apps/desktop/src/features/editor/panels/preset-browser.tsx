import { useMemo, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  IconButton,
  Input,
  Skeleton,
  cn,
  useToast,
} from "@recordforge/ui"
import { Grid2X2, List, Search, Shapes, Sparkles, Star, Trash2, Type } from "lucide-react"
import { type AnnotationPresetRecord, type TextPresetRecord } from "@recordforge/editor-core"
import { useAnnotationPresetRegistry, useTextPresetRegistry } from "../presets/preset-store"
import { PresetThumbnail } from "../presets/preset-thumbnail"

export type BrowserPreset = AnnotationPresetRecord | TextPresetRecord

interface PresetBrowserProps {
  kind: "annotation" | "text"
  selectedPresetId?: string
  onSelect: (preset: BrowserPreset) => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
}

export function PresetBrowser({
  kind,
  selectedPresetId,
  onSelect,
  open,
  onOpenChange,
  className,
}: PresetBrowserProps) {
  const content = (
    <PresetBrowserContent
      kind={kind}
      selectedPresetId={selectedPresetId}
      onSelect={(preset) => {
        onSelect(preset)
        if (open !== undefined) onOpenChange?.(false)
      }}
      className={className}
    />
  )

  if (open === undefined) return content

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(760px,90vh)] max-w-3xl flex-col gap-3 overflow-hidden p-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {kind === "annotation" ? (
              <Shapes className="size-4 text-secondary" aria-hidden />
            ) : (
              <Type className="size-4 text-warning" aria-hidden />
            )}
            Browse {kind === "annotation" ? "annotation" : "title"} presets
          </DialogTitle>
          <DialogDescription>
            Search, favorite, and apply a style without leaving the inspector.
          </DialogDescription>
        </DialogHeader>
        {content}
      </DialogContent>
    </Dialog>
  )
}

interface PresetBrowserContentProps {
  kind: "annotation" | "text"
  selectedPresetId?: string
  onSelect: (preset: BrowserPreset) => void
  className?: string
}

function PresetBrowserContent({
  kind,
  selectedPresetId,
  onSelect,
  className,
}: PresetBrowserContentProps) {
  const annotation = useAnnotationPresetRegistry()
  const text = useTextPresetRegistry()
  const active = kind === "annotation" ? annotation : text
  const { toast } = useToast()
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState("all")
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid")
  const listRef = useRef<HTMLDivElement>(null)

  const presets = useMemo(() => {
    return active.registry.list({
      query,
      category: category === "all" || category === "favorites" ? undefined : category,
      favoritesOnly: category === "favorites",
    }) as BrowserPreset[]
  }, [active.registry, category, query])

  const columnCount = viewMode === "grid" ? 2 : 1
  const rowCount = Math.ceil(presets.length / columnCount)
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => listRef.current,
    estimateSize: () => (viewMode === "grid" ? 230 : 124),
    overscan: 4,
  })

  async function toggleFavorite(preset: BrowserPreset) {
    try {
      await active.registry.toggleFavorite(preset.id)
    } catch (error) {
      toast({
        title: "Favorite could not be saved",
        description: error instanceof Error ? error.message : "Try again.",
        variant: "error",
      })
    }
  }

  async function deletePreset(preset: BrowserPreset) {
    if (!active.registry.isCustomPreset(preset.id)) return
    try {
      await active.registry.deleteCustomPreset(preset.id)
      toast({ title: "Preset deleted", description: `${preset.name} was removed.` })
    } catch (error) {
      toast({
        title: "Preset could not be deleted",
        description: error instanceof Error ? error.message : "Try again.",
        variant: "error",
      })
    }
  }

  if (active.isLoading) {
    return (
      <div className={cn("space-y-2", className)} aria-label="Loading presets">
        <Skeleton className="h-8 w-full" />
        <div className="grid grid-cols-2 gap-2">
          <Skeleton className="h-44" />
          <Skeleton className="h-44" />
        </div>
      </div>
    )
  }

  if (active.error) {
    return (
      <EmptyState
        className={className}
        icon={Shapes}
        title="Presets unavailable"
        description={active.error}
        action={<Button onClick={() => window.location.reload()}>Retry</Button>}
      />
    )
  }

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-2", className)}>
      <div className="flex items-center gap-2">
        <Input
          icon={Search}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Search ${kind === "annotation" ? "shape" : "title"} presets...`}
          aria-label="Search presets"
          className="h-8 text-xs"
        />
        <IconButton
          label={viewMode === "grid" ? "Use list view" : "Use grid view"}
          onClick={() => setViewMode(viewMode === "grid" ? "list" : "grid")}
          className="size-8 shrink-0"
        >
          {viewMode === "grid" ? <List className="size-4" /> : <Grid2X2 className="size-4" />}
        </IconButton>
      </div>

      <div
        className="flex gap-1 overflow-x-auto pb-1"
        role="tablist"
        aria-label="Preset categories"
      >
        <CategoryButton
          active={category === "all"}
          label="All"
          onClick={() => setCategory("all")}
        />
        <CategoryButton
          active={category === "favorites"}
          label="Favorites"
          icon={Star}
          onClick={() => setCategory("favorites")}
        />
        {active.snapshot.categories.map((item) => (
          <CategoryButton
            key={item}
            active={category === item}
            label={formatCategory(item)}
            onClick={() => setCategory(item)}
          />
        ))}
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto pr-1">
        {presets.length === 0 ? (
          <EmptyState
            className="mt-2"
            icon={Sparkles}
            title={category === "favorites" ? "No favorite presets" : "No matching presets"}
            description={
              category === "favorites"
                ? "Favorite a preset to keep it close at hand."
                : "Try a different search or category."
            }
          />
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const rowPresets = presets.slice(
                item.index * columnCount,
                (item.index + 1) * columnCount,
              )
              return (
                <div
                  key={item.key}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  className={cn(
                    "absolute top-0 left-0 grid w-full gap-2 pb-2",
                    columnCount === 2 ? "grid-cols-2" : "grid-cols-1",
                  )}
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {rowPresets.map((preset) => (
                    <PresetCard
                      key={preset.id}
                      kind={kind}
                      preset={preset}
                      selected={preset.id === selectedPresetId}
                      isFavorite={active.registry.isFavorite(preset.id)}
                      isCustom={active.registry.isCustomPreset(preset.id)}
                      viewMode={viewMode}
                      onSelect={() => onSelect(preset)}
                      onToggleFavorite={() => void toggleFavorite(preset)}
                      onDelete={() => void deletePreset(preset)}
                    />
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

interface PresetCardProps {
  kind: "annotation" | "text"
  preset: BrowserPreset
  selected: boolean
  isFavorite: boolean
  isCustom: boolean
  viewMode: "grid" | "list"
  onSelect: () => void
  onToggleFavorite: () => void
  onDelete: () => void
}

function PresetCard({
  kind,
  preset,
  selected,
  isFavorite,
  isCustom,
  viewMode,
  onSelect,
  onToggleFavorite,
  onDelete,
}: PresetCardProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        "group relative cursor-pointer rounded-lg border border-border bg-surface-container p-2 text-left transition-colors hover:border-primary/60 hover:bg-surface-container-high focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:outline-none",
        selected && "border-primary ring-2 ring-primary/40",
        viewMode === "list" && "flex items-center gap-3",
      )}
    >
      <PresetThumbnail
        kind={kind}
        preset={preset}
        className={cn(viewMode === "list" && "aspect-video w-32 shrink-0")}
      />
      <div className={cn("min-w-0", viewMode === "grid" ? "mt-2" : "flex-1")}>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold text-foreground">{preset.name}</p>
            <p className="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground">
              {preset.description}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <IconButton
              label={isFavorite ? "Remove from favorites" : "Add to favorites"}
              onClick={(event) => {
                event.stopPropagation()
                onToggleFavorite()
              }}
              className={cn("size-7", isFavorite && "text-warning")}
            >
              <Star className={cn("size-3.5", isFavorite && "fill-current")} aria-hidden />
            </IconButton>
            {isCustom ? (
              <IconButton
                label="Delete custom preset"
                onClick={(event) => {
                  event.stopPropagation()
                  onDelete()
                }}
                className="size-7 text-muted-foreground hover:text-recording"
              >
                <Trash2 className="size-3.5" aria-hidden />
              </IconButton>
            ) : null}
          </div>
        </div>
        <p className="mt-1 text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
          {formatCategory(preset.category)}
          {isCustom ? " · Custom" : ""}
        </p>
      </div>
    </div>
  )
}

interface CategoryButtonProps {
  active: boolean
  label: string
  icon?: typeof Star
  onClick: () => void
}

function CategoryButton({ active, label, icon: Icon, onClick }: CategoryButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2.5 text-[10px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:outline-none",
        active
          ? "border-primary/60 bg-primary/15 text-primary"
          : "border-border bg-surface-dim text-muted-foreground hover:text-foreground",
      )}
    >
      {Icon ? <Icon className="size-3" aria-hidden /> : null}
      {label}
    </button>
  )
}

function formatCategory(category: string): string {
  return category
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}
