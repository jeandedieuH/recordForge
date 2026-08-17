import { useMemo } from "react"
import {
  applyTextPresetToClip,
  createAddTextClipCommand,
  createTextClipFromDefinition,
  createUpdateTextClipCommand,
  textPresetToDefinition,
  type TextClip,
  type TextPresetRecord,
} from "@recordforge/editor-core"
import { useTimelineStore } from "../../../stores/timeline-store"
import { Type } from "lucide-react"
import { PresetBrowser, type BrowserPreset } from "./preset-browser"

export function TitlesPanel() {
  const engine = useTimelineStore((state) => state.engine)
  const view = useTimelineStore((state) => state.view)
  const execute = useTimelineStore((state) => state.execute)
  const setSelection = useTimelineStore((state) => state.setSelection)

  const timeline = engine?.history.present
  const canvasWidth = timeline?.canvas.width ?? 1920
  const canvasHeight = timeline?.canvas.height ?? 1080

  const selectedTextClip = useMemo(() => {
    if (!timeline || !view.selection || view.selection.kind !== "clip") return null
    const primaryClipId = view.selection.primaryClipId
    for (const track of timeline.tracks) {
      const clip = track.clips.find((candidate) => candidate.id === primaryClipId)
      if (clip?.kind === "text") return { clip: clip as TextClip }
    }
    return null
  }, [timeline, view.selection])

  function handleAddPreset(preset: BrowserPreset) {
    const definition = textPresetToDefinition(preset as TextPresetRecord)
    if (selectedTextClip) {
      const updated = applyTextPresetToClip(selectedTextClip.clip, definition)
      execute(
        createUpdateTextClipCommand(selectedTextClip.clip.id, {
          ...updated,
          primaryText: selectedTextClip.clip.primaryText,
          secondaryText: selectedTextClip.clip.secondaryText,
          tagText: selectedTextClip.clip.tagText,
        }),
      )
      return
    }

    const clip = createTextClipFromDefinition(definition, {
      startMs: Math.round(view.playheadMs),
      durationMs: 4000,
      canvasWidth,
      canvasHeight,
    })
    const titlesTrack = timeline?.tracks.find((track) => track.kind === "titles")
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
      <div className="border-b border-border p-3.5 pb-3">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-warning/15 text-warning">
            <Type className="size-4" aria-hidden />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Titles & Presets</h3>
            <p className="text-[11px] text-muted-foreground">
              {selectedTextClip
                ? "Click a preset to apply it to the selected title"
                : "Add stylized titles & lower thirds"}
            </p>
          </div>
        </div>
      </div>
      <PresetBrowser
        kind="text"
        selectedPresetId={selectedTextClip?.clip.presetId}
        onSelect={handleAddPreset}
        className="p-3"
      />
    </div>
  )
}
