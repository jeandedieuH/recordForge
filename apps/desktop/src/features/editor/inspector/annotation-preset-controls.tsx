import { useState } from "react"
import {
  annotationPresetFromClip,
  annotationPresetToShapePreset,
  type AnnotationPresetRecord,
} from "@recordforge/editor-core"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  useToast,
} from "@recordforge/ui"
import { FolderOpen, Save, Shapes } from "lucide-react"
import { useAnnotationPresetRegistry } from "../presets/preset-store"
import { PresetBrowser, type BrowserPreset } from "../panels/preset-browser"
import { SavePresetDialog, type SavePresetFormData } from "../presets/save-preset-dialog"
import {
  applyAnnotationInspectorPreset,
  type AnnotationInspectorProps,
} from "./annotation-inspector-helpers"

export function AnnotationPresetControls({ clip, onChange }: AnnotationInspectorProps) {
  const { registry, snapshot } = useAnnotationPresetRegistry()
  const { toast } = useToast()
  const [browserOpen, setBrowserOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const activePresetName =
    (clip.presetId ? registry.getPresetById(clip.presetId)?.name : undefined) ?? "Custom style"

  function handleApplyPreset(preset: BrowserPreset) {
    const shape = annotationPresetToShapePreset(preset as AnnotationPresetRecord)
    if (clip.locked && shape.type !== clip.annotationType) {
      toast({
        title: "Position is locked",
        description: "Unlock the annotation to apply a different shape.",
      })
      return
    }
    onChange(applyAnnotationInspectorPreset(clip, shape))
    setBrowserOpen(false)
  }

  async function handleSavePreset(data: SavePresetFormData) {
    const record = annotationPresetFromClip(clip, {
      name: data.name,
      description: data.description,
      category: data.category,
      tags: data.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    })
    try {
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
    <>
      {/* Preset Controls */}
      <div className="flex flex-col gap-2">
        <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
          <span className="shrink-0 text-muted-foreground">Preset</span>
          <span className="truncate font-medium text-foreground" title={activePresetName}>
            {activePresetName}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 min-w-0 gap-1.5 px-2 text-xs"
            aria-label="Browse annotation presets"
            onClick={() => setBrowserOpen(true)}
          >
            <FolderOpen className="size-3.5 shrink-0" aria-hidden />
            Browse
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 min-w-0 gap-1.5 px-2 text-xs"
            aria-label="Save annotation preset"
            onClick={() => setSaveOpen(true)}
          >
            <Save className="size-3.5 shrink-0" aria-hidden />
            Save
          </Button>
        </div>
      </div>
      <Dialog open={browserOpen} onOpenChange={setBrowserOpen}>
        <DialogContent className="flex max-h-[90vh] max-w-3xl flex-col gap-3 overflow-hidden p-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shapes className="size-4 text-primary" aria-hidden />
              Browse annotation presets
            </DialogTitle>
            <DialogDescription>Apply a saved look to this annotation.</DialogDescription>
          </DialogHeader>
          <PresetBrowser
            kind="annotation"
            selectedPresetId={clip.presetId}
            onSelect={handleApplyPreset}
          />
        </DialogContent>
      </Dialog>
      <SavePresetDialog
        key={clip.annotationType}
        open={saveOpen}
        onOpenChange={setSaveOpen}
        defaultCategory={clip.annotationType}
        categories={snapshot.categories}
        onSave={handleSavePreset}
      />
    </>
  )
}
