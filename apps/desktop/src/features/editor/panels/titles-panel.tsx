import { useMemo, useState } from "react"
import {
  applyPresetToTextClip,
  createTextClipFromPreset,
  createAddTextClipCommand,
  createUpdateTextClipCommand,
  listTextPresetsByCategory,
  type TextPresetDefinition,
} from "@recordforge/editor-core"
import type { TextClip, TitlePresetCategory } from "@recordforge/contracts"
import { useTimelineStore } from "../../../stores/timeline-store"
import {
  Button,
  Card,
  CardContent,
  Input,
  ScrollArea,
  Tabs,
  TabsList,
  TabsTrigger,
  cn,
} from "@recordforge/ui"
import { Plus, Search, Sparkles, Type } from "lucide-react"

export function TitlesPanel() {
  const [selectedCategory, setSelectedCategory] = useState<string>("all")
  const [searchQuery, setSearchQuery] = useState("")

  const engine = useTimelineStore((state) => state.engine)
  const view = useTimelineStore((state) => state.view)
  const execute = useTimelineStore((state) => state.execute)
  const setSelection = useTimelineStore((state) => state.setSelection)

  const timeline = engine?.history.present
  const canvasWidth = timeline?.canvas.width ?? 1920
  const canvasHeight = timeline?.canvas.height ?? 1080

  // If a text clip is currently selected in the timeline, let the user click a preset to apply it directly
  const selectedTextClip = useMemo(() => {
    if (!timeline || !view.selection || view.selection.kind !== "clip") return null
    const primaryClipId = view.selection.primaryClipId
    for (const track of timeline.tracks) {
      const clip = track.clips.find((c) => c.id === primaryClipId)
      if (clip && clip.kind === "text") return { clip: clip as TextClip, trackId: track.id }
    }
    return null
  }, [timeline, view.selection])

  const filteredPresets = useMemo(() => {
    const categoryFilter =
      selectedCategory === "all" ? undefined : (selectedCategory as TitlePresetCategory)
    let presets = listTextPresetsByCategory(categoryFilter)

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase()
      presets = presets.filter(
        (p) =>
          p.name.toLowerCase().includes(query) ||
          p.description.toLowerCase().includes(query) ||
          p.category.toLowerCase().includes(query),
      )
    }
    return presets
  }, [selectedCategory, searchQuery])

  function handleAddPreset(preset: TextPresetDefinition) {
    if (selectedTextClip) {
      // Apply style to currently selected clip
      const updated = applyPresetToTextClip(selectedTextClip.clip, preset.id)
      execute(createUpdateTextClipCommand(selectedTextClip.clip.id, updated))
      return
    }

    // Otherwise, create a new text clip at current playhead
    const startMs = Math.round(view.playheadMs)
    const clip = createTextClipFromPreset(preset.id, {
      startMs,
      durationMs: 4000,
      canvasWidth,
      canvasHeight,
    })

    // Find existing titles track or default to automatic track creation
    const titlesTrack = timeline?.tracks.find((t) => t.kind === "titles")
    const ok = execute(createAddTextClipCommand(clip, titlesTrack?.id))
    if (ok) {
      setSelection({
        kind: "clip",
        clipIds: [clip.id],
        primaryClipId: clip.id,
      })
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface">
      {/* Header */}
      <div className="border-b border-border p-3.5 pb-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-md bg-warning/15 text-warning">
              <Type className="size-4" aria-hidden />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">Titles & Presets</h3>
              <p className="text-[11px] text-muted-foreground">
                {selectedTextClip
                  ? "Click preset to apply to selected clip"
                  : "Add stylized titles & lower thirds"}
              </p>
            </div>
          </div>
        </div>

        {/* Search */}
        <div className="relative mt-2.5">
          <Search
            className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search title styles..."
            className="h-8 pl-8 text-xs bg-surface-dim border-border"
          />
        </div>

        {/* Category Tabs */}
        <Tabs value={selectedCategory} onValueChange={setSelectedCategory} className="mt-2">
          <TabsList className="grid w-full grid-cols-4 h-7 bg-surface-dim p-0.5">
            <TabsTrigger value="all" className="text-[10px] py-0 px-1.5 h-6">
              All
            </TabsTrigger>
            <TabsTrigger value="title" className="text-[10px] py-0 px-1.5 h-6">
              Titles
            </TabsTrigger>
            <TabsTrigger value="lower-third" className="text-[10px] py-0 px-1.5 h-6">
              Lower 3rd
            </TabsTrigger>
            <TabsTrigger value="callout" className="text-[10px] py-0 px-1.5 h-6">
              Callouts
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Preset Card Grid */}
      <ScrollArea className="flex-1 p-3">
        <div className="grid grid-cols-1 gap-2.5 pb-6">
          {filteredPresets.map((preset) => (
            <PresetCard
              key={preset.id}
              preset={preset}
              isSelectedClipTarget={selectedTextClip?.clip.presetId === preset.id}
              onSelect={() => handleAddPreset(preset)}
            />
          ))}

          {filteredPresets.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <Sparkles className="size-8 text-muted-foreground/40 mb-2" aria-hidden />
              <p className="text-xs font-medium text-foreground">No matching presets found</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Try searching for different keywords
              </p>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  )
}

interface PresetCardProps {
  preset: TextPresetDefinition
  isSelectedClipTarget?: boolean
  onSelect: () => void
}

function PresetCard({ preset, isSelectedClipTarget, onSelect }: PresetCardProps) {
  return (
    <Card
      onClick={onSelect}
      className={cn(
        "group relative cursor-pointer overflow-hidden border border-border bg-surface-container transition-all duration-fast ease-forge hover:border-primary/60 hover:bg-surface-container-high hover:shadow-e2",
        isSelectedClipTarget && "ring-2 ring-primary border-primary",
      )}
    >
      <CardContent className="p-2.5">
        {/* Visual Live Stylized Preview Box */}
        <div
          className="relative flex min-h-19 w-full flex-col justify-center overflow-hidden rounded-lg p-3 select-none"
          style={{
            backgroundColor: preset.backdropColor,
            border:
              preset.backdropStyle === "glass" || preset.backdropStyle === "outline"
                ? `1px solid ${preset.accentColor}40`
                : "1px solid rgba(255,255,255,0.06)",
            boxShadow: preset.shadowEnabled ? preset.shadowColor : undefined,
          }}
        >
          {/* Accent indicator line if applicable */}
          {preset.backdropStyle === "accent-bar" ? (
            <div
              className="absolute left-0 top-0 bottom-0 w-1.5"
              style={{ backgroundColor: preset.accentColor }}
            />
          ) : null}

          {/* Tag / Badge */}
          {preset.defaultTagText ? (
            <span
              className="mb-1 inline-flex w-fit items-center rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider"
              style={{
                backgroundColor: `${preset.accentColor}25`,
                color: preset.accentColor,
              }}
            >
              {preset.defaultTagText}
            </span>
          ) : null}

          {/* Main Title text preview */}
          <div
            className={cn(
              "truncate text-xs font-bold leading-tight",
              preset.alignment === "center" && "text-center",
              preset.alignment === "right" && "text-right",
              preset.fontFamily === "serif" && "font-serif",
              preset.fontFamily === "mono" && "font-mono",
            )}
            style={{ color: preset.textColor }}
          >
            {preset.defaultPrimaryText}
          </div>

          {/* Secondary Subtitle text preview */}
          {preset.defaultSecondaryText ? (
            <div
              className={cn(
                "mt-0.5 truncate text-[10px] opacity-80",
                preset.alignment === "center" && "text-center",
                preset.alignment === "right" && "text-right",
              )}
              style={{ color: preset.secondaryTextColor }}
            >
              {preset.defaultSecondaryText}
            </div>
          ) : null}
        </div>

        {/* Card Footer Info */}
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h4 className="truncate text-xs font-semibold text-foreground group-hover:text-primary transition-colors">
              {preset.name}
            </h4>
            <p className="truncate text-[10px] text-muted-foreground">{preset.description}</p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="size-7 shrink-0 p-0 text-muted-foreground group-hover:bg-primary group-hover:text-primary-foreground transition-all rounded-md"
            title="Add preset to timeline"
          >
            <Plus className="size-4" aria-hidden />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
