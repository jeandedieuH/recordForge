import { useState } from "react"
import type { TextClip, TitlePresetCategory } from "@recordforge/contracts"
import {
  applyTextPresetToClip,
  textPresetFromClip,
  textPresetToDefinition,
  type TextPresetRecord,
} from "@recordforge/editor-core"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  IconButton,
  cn,
  useToast,
} from "@recordforge/ui"
import { Eye, FolderOpen, Lock, Save, Type } from "lucide-react"
import { useTextPresetRegistry } from "../presets/preset-store"
import { SavePresetDialog, type SavePresetFormData } from "../presets/save-preset-dialog"
import { TitlePresetBrowser } from "../titles/title-preset-browser"
import { useTimelineStore } from "../../../stores/timeline-store"
import { TitleContentSection } from "./text/title-content-section"
import { TitleDesignSection } from "./text/title-design-section"
import { TitleMotionSection } from "./text/title-motion-section"
import { TitleLayoutSection } from "./text/title-layout-section"
import { TitleAdvancedSection } from "./text/title-advanced-section"
import { fitTitleLayout } from "./text/title-layout"

interface TextClipInspectorProps {
  clip: TextClip
  onChange: (update: Partial<TextClip>) => void
}

export function TextClipInspector(props: TextClipInspectorProps) {
  // Selection owns the draft lifecycle, including flush-on-unmount with the old clip callback.
  return <TitleInspectorSession key={props.clip.id} {...props} />
}

function TitleInspectorSession({ clip, onChange }: TextClipInspectorProps) {
  const { registry, snapshot } = useTextPresetRegistry()
  const { toast } = useToast()
  const [browserOpen, setBrowserOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const canvasWidth = useTimelineStore(
    (state) => state.engine?.history.present.canvas.width ?? 1920,
  )
  const canvasHeight = useTimelineStore(
    (state) => state.engine?.history.present.canvas.height ?? 1080,
  )
  const canvas = { width: canvasWidth, height: canvasHeight }
  const activePreset = registry.getPresetById(clip.presetId)
  const activePresetName = activePreset?.name ?? "Custom title"

  function replacePreset(
    preset: TextPresetRecord,
    options?: { preserveLayout?: boolean; preserveStyle?: boolean },
  ) {
    const updated = applyTextPresetToClip(clip, textPresetToDefinition(preset), options)
    onChange({ ...updated, ...(!options?.preserveLayout ? fitTitleLayout(updated, canvas) : {}) })
    setBrowserOpen(false)
    toast({
      title: "Title design replaced",
      description: "Your content and clip timing are preserved.",
    })
  }

  function resetDimensions() {
    // Resolve custom definitions from the registry, never the built-in fallback lookup.
    if (!activePreset) return
    const definition = textPresetToDefinition(activePreset)
    onChange(
      fitTitleLayout(clip, canvas, {
        width: definition.width,
        height: definition.height,
        fontSize: definition.fontSize,
        backdropPaddingX: definition.backdropPaddingX,
        backdropPaddingY: definition.backdropPaddingY,
        backdropBorderRadius: definition.backdropBorderRadius,
      }),
    )
    toast({ title: "Dimensions reset", description: "Preset dimensions fitted to the canvas." })
  }

  async function savePreset(data: SavePresetFormData) {
    try {
      const record = textPresetFromClip(clip, {
        name: data.name,
        description: data.description,
        category: data.category as TitlePresetCategory,
        tags: data.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      })
      await registry.saveCustomPreset(record)
      toast({ title: "Preset saved", description: `${data.name} is now in your library.` })
    } catch (error) {
      toast({
        title: "Could not save preset",
        description: error instanceof Error ? error.message : "Try again.",
        variant: "error",
      })
    }
  }

  return (
    <div className="flex flex-col gap-4 p-3 text-xs">
      {/* Top Header */}
      <div className="flex items-center justify-between gap-2 border-b border-border pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <Type className="size-4 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">{activePresetName}</h3>
            <p className="text-xs text-muted-foreground">
              {clip.titleDesign ? "Creator title" : "Legacy title"}
            </p>
          </div>
        </div>
        <div className="flex gap-1">
          <IconButton
            label={clip.enabled ? "Hide title" : "Show title"}
            aria-pressed={!clip.enabled}
            className={cn("size-7", !clip.enabled && "text-muted-foreground")}
            onClick={() => onChange({ enabled: !clip.enabled })}
          >
            <Eye className="size-3.5" aria-hidden />
          </IconButton>
          <IconButton
            label={clip.locked ? "Unlock position" : "Lock position"}
            aria-pressed={clip.locked}
            className={cn("size-7", clip.locked && "text-primary")}
            onClick={() => onChange({ locked: !clip.locked })}
          >
            <Lock className="size-3.5" aria-hidden />
          </IconButton>
        </div>
      </div>
      <TitleContentSection clip={clip} onChange={onChange} />
      <TitleDesignSection clip={clip} onChange={onChange}>
        {/* Preset Controls */}
        {/* Quick Preset Selector Chips */}
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="gap-1"
            onClick={() => setBrowserOpen(true)}
          >
            <FolderOpen className="size-3.5" aria-hidden />
            Replace design
          </Button>
          <Button variant="outline" size="sm" className="gap-1" onClick={() => setSaveOpen(true)}>
            <Save className="size-3.5" aria-hidden />
            Save preset
          </Button>
        </div>
      </TitleDesignSection>
      <TitleMotionSection clip={clip} onChange={onChange} />
      <TitleLayoutSection
        clip={clip}
        onChange={onChange}
        canvas={canvas}
        onReset={resetDimensions}
        canReset={!!activePreset}
      />
      <TitleAdvancedSection clip={clip} onChange={onChange} canvas={canvas} />
      <Dialog open={browserOpen} onOpenChange={setBrowserOpen}>
        <DialogContent className="flex max-h-[90vh] max-w-4xl flex-col gap-3 overflow-hidden p-4">
          <DialogHeader>
            <DialogTitle>Replace title design</DialogTitle>
            <DialogDescription>
              Choose a title from the library. Your words and timing stay intact.
            </DialogDescription>
          </DialogHeader>
          <TitlePresetBrowser
            selectedPresetId={clip.presetId}
            previewClip={clip}
            onReplace={replacePreset}
          />
        </DialogContent>
      </Dialog>
      <SavePresetDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        defaultCategory={clip.category}
        categories={snapshot.categories}
        onSave={savePreset}
      />
    </div>
  )
}
