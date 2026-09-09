import { useMemo, useState } from "react"
import {
  applyTextPresetToClip,
  createAddTextClipCommand,
  createTextClipFromDefinition,
  createUpdateTextClipCommand,
  TEXT_PRESET_CATALOG,
  textPresetToDefinition,
  type TextClip,
  type TextPresetRecord,
} from "@recordforge/editor-core"
import { Button, IconButton, useToast } from "@recordforge/ui"
import { Plus, Save, Type } from "lucide-react"
import { useTimelineStore } from "../../../stores/timeline-store"
import { TitlePresetBrowser } from "../titles/title-preset-browser"
import { useTitleLibraryState } from "../titles/title-library-state"
import { TitleSaveDialog } from "../titles/title-save-dialog"
import type { TitleReplaceOptions } from "../titles/title-preview-plan"

export function TitlesPanel() {
  const engine = useTimelineStore((state) => state.engine)
  const view = useTimelineStore((state) => state.view)
  const execute = useTimelineStore((state) => state.execute)
  const setSelection = useTimelineStore((state) => state.setSelection)
  const remember = useTitleLibraryState((state) => state.remember)
  const { toast } = useToast()
  const [saveOpen, setSaveOpen] = useState(false)
  const timeline = engine?.history.present
  const canvasWidth = timeline?.canvas.width ?? 1920
  const canvasHeight = timeline?.canvas.height ?? 1080
  const selectedTextClip = useMemo(() => {
    if (!timeline || view.selection?.kind !== "clip") return undefined
    const primaryClipId = view.selection.primaryClipId
    for (const track of timeline.tracks) {
      const clip = track.clips.find((candidate) => candidate.id === primaryClipId)
      if (clip?.kind === "text") return clip as TextClip
    }
    return undefined
  }, [timeline, view.selection])

  function handleAddPreset(preset: TextPresetRecord) {
    try {
      const titlesTrack = timeline?.tracks.find((track) => track.kind === "titles" && !track.locked)
      const existingClips = titlesTrack?.clips ?? []
      const startMs = Math.max(0, Math.round(view.playheadMs))
      const durationMs = 4000

      const clip = createTextClipFromDefinition(textPresetToDefinition(preset), {
        startMs,
        durationMs,
        canvasWidth,
        canvasHeight,
      })

      // If existing titles overlap this timestamp, offset y on canvas so titles don't visually occlude each other
      const overlappingClips = existingClips.filter(
        (c) => startMs < c.startMs + c.durationMs && startMs + durationMs > c.startMs,
      )
      if (overlappingClips.length > 0) {
        const offset = (overlappingClips.length % 5) * 80
        clip.y = Math.min(canvasHeight - clip.height - 40, clip.y + offset)
      }

      const ok = execute(createAddTextClipCommand(clip, titlesTrack?.id))
      if (!ok) throw new Error("Title command rejected")
      setSelection({ kind: "clip", clipIds: [clip.id], primaryClipId: clip.id })
      remember(preset.id)
      toast({
        title: "Title added",
        description: `${preset.name} was added at the playhead.`,
      })
    } catch {
      toast({
        title: "Title could not be added",
        description: "Open a project and unlock the titles track, then try again.",
        variant: "error",
      })
    }
  }

  function handleReplace(preset: TextPresetRecord, options?: TitleReplaceOptions) {
    if (!selectedTextClip) return
    try {
      const updated = applyTextPresetToClip(
        selectedTextClip,
        textPresetToDefinition(preset),
        options,
      )
      const ok = execute(
        createUpdateTextClipCommand(selectedTextClip.id, {
          ...updated,
          primaryText: selectedTextClip.primaryText,
          secondaryText: selectedTextClip.secondaryText,
          tagText: selectedTextClip.tagText,
          startMs: selectedTextClip.startMs,
          durationMs: selectedTextClip.durationMs,
        }),
      )
      if (!ok) throw new Error("Title command rejected")
      remember(preset.id)
      toast({
        title: "Title design replaced",
        description: "Your words and timing were preserved. Undo is available.",
      })
    } catch {
      toast({
        title: "Title could not be replaced",
        description: "Unlock the selected title and its track, then try again.",
        variant: "error",
      })
    }
  }

  const plainText =
    TEXT_PRESET_CATALOG.presets.find((preset) => preset.id === "text-clean") ??
    TEXT_PRESET_CATALOG.presets[0]
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-surface">
      <div className="flex shrink-0 flex-col gap-2 border-b border-border p-3">
        <div className="flex min-w-0 items-center gap-2">
          <Type className="size-4 shrink-0 text-warning" aria-hidden />
          <h3 className="min-w-0 flex-1 text-sm font-semibold text-foreground">
            Text &amp; Titles
          </h3>
          {selectedTextClip ? (
            <IconButton
              label="Save selected title as custom preset"
              className="size-7 shrink-0"
              onClick={() => setSaveOpen(true)}
            >
              <Save className="size-3.5" aria-hidden />
            </IconButton>
          ) : null}
          <Button
            size="sm"
            className="shrink-0"
            disabled={!timeline || !plainText}
            onClick={() => plainText && handleAddPreset(plainText)}
          >
            <Plus className="size-3.5" aria-hidden />
            Add Text
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Choose a design to preview. Add new or replace explicitly.
        </p>
      </div>
      <TitlePresetBrowser
        selectedPresetId={selectedTextClip?.presetId}
        previewClip={selectedTextClip}
        onAdd={handleAddPreset}
        onReplace={handleReplace}
        className="p-3"
      />
      {selectedTextClip && saveOpen ? (
        <TitleSaveDialog
          key={selectedTextClip.id}
          clip={selectedTextClip}
          open={saveOpen}
          onOpenChange={setSaveOpen}
        />
      ) : null}
    </div>
  )
}
