import { useMemo, useState } from "react"
import {
  ANNOTATION_PALETTES,
  annotationPresetToShapePreset,
  createAddAnnotationClipCommand,
  createUpdateAnnotationClipCommand,
  getAnnotationShapePreset,
  type AnnotationPresetRecord,
} from "@recordforge/editor-core"
import { annotationPresetValuesSchema } from "@recordforge/editor-core"
import { useTimelineStore } from "../../../stores/timeline-store"
import {
  Button,
  ColorPicker,
  IconButton,
  Kbd,
  NumberInputField,
  ToggleGroup,
  ToggleGroupItem,
} from "@recordforge/ui"
import { Check, FolderOpen, MousePointer2, Pencil, Plus, Shapes } from "lucide-react"
import { PresetBrowser, type BrowserPreset } from "./preset-browser"
import { PresetThumbnail } from "../presets/preset-thumbnail"
import { AnnotationShapePicker } from "../annotations/annotation-shape-picker"
import {
  annotationSettingsFromPreset,
  applyAnnotationToolToClip,
  createAnnotationFromTool,
  getAnnotationEditTime,
  type AnnotationDrawSettings,
} from "../annotations/annotation-tools"

interface AnnotationsPanelProps {
  drawMode: boolean
  drawSettings: AnnotationDrawSettings
  onDrawSettingsChange: (settings: AnnotationDrawSettings) => void
  onToggleDrawMode: (enabled: boolean) => void
}

export function AnnotationsPanel({
  drawMode,
  drawSettings,
  onDrawSettingsChange,
  onToggleDrawMode,
}: AnnotationsPanelProps) {
  const [browserOpen, setBrowserOpen] = useState(false)
  const timeline = useTimelineStore((state) => state.engine?.history.present)
  const selectedId = useTimelineStore((state) =>
    state.view.selection?.kind === "clip" ? state.view.selection.primaryClipId : null,
  )
  const selected = timeline?.tracks
    .flatMap((track) => track.clips)
    .find((clip) => clip.id === selectedId)
  const selectedAnnotation = selected?.kind === "annotation" ? selected : null
  const { preset, strokeColor, strokeWidth, strokeStyle } = drawSettings

  const previewPreset = useMemo<AnnotationPresetRecord>(
    () => ({
      id: preset.presetId ?? preset.type,
      name: preset.name,
      description: preset.description,
      category: preset.type,
      tags: [preset.type],
      definition: {
        ...preset,
        defaultStrokeColor: strokeColor,
        defaultStrokeWidth: strokeWidth,
        defaultStrokeStyle: strokeStyle,
      },
    }),
    [preset, strokeColor, strokeWidth, strokeStyle],
  )

  function updateSettings(update: Partial<AnnotationDrawSettings>) {
    onDrawSettingsChange({ ...drawSettings, ...update })
  }

  function handleChoosePreset(candidate: BrowserPreset) {
    const result = annotationPresetValuesSchema.safeParse(candidate.definition)
    if (!result.success) return
    const shape = annotationPresetToShapePreset({ ...candidate, definition: result.data })
    onDrawSettingsChange(annotationSettingsFromPreset(shape))
  }

  function handleAddAnnotation() {
    const store = useTimelineStore.getState()
    const current = store.engine?.history.present
    if (!current) return
    store.pause()
    const clip = createAnnotationFromTool({
      settings: drawSettings,
      startMs: store.view.playheadMs,
      canvasWidth: current.canvas.width,
      canvasHeight: current.canvas.height,
    })
    const track = current.tracks.find((item) => item.kind === "annotations" && !item.locked)
    if (!store.execute(createAddAnnotationClipCommand(clip, track?.id))) return
    store.setSelection({ kind: "clip", clipIds: [clip.id], primaryClipId: clip.id })
    store.seek(getAnnotationEditTime(clip))
    onToggleDrawMode(false)
  }

  function handleApplyToSelected() {
    if (!selectedAnnotation || selectedAnnotation.locked) return
    const store = useTimelineStore.getState()
    const updated = applyAnnotationToolToClip({ clip: selectedAnnotation, settings: drawSettings })
    if (!store.execute(createUpdateAnnotationClipCommand(selectedAnnotation.id, updated))) return
    store.pause()
    store.seek(getAnnotationEditTime(updated))
    onToggleDrawMode(false)
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-surface">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border p-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Shapes className="size-4" aria-hidden />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">Annotations</h3>
          <p className="text-xs text-muted-foreground">Make the important part clear.</p>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-3">
        <section className="flex flex-col gap-2" aria-label="Choose a shape">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-xs font-medium text-foreground">Shape</h4>
            <Button variant="ghost" size="sm" onClick={() => setBrowserOpen(true)}>
              <FolderOpen aria-hidden />
              Presets
            </Button>
          </div>
          <AnnotationShapePicker
            value={preset.type}
            onChange={(type) => updateSettings({ preset: getAnnotationShapePreset(type) })}
          />
        </section>

        <section className="flex flex-col gap-2" aria-label="Annotation preview">
          <div className="rounded-xl border border-border bg-surface-dim p-1.5">
            <PresetThumbnail kind="annotation" preset={previewPreset} />
          </div>
          <div className="flex flex-col gap-0.5 px-1">
            <p className="truncate text-xs font-medium text-foreground" title={preset.name}>
              {preset.name}
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">{preset.description}</p>
          </div>
        </section>

        {/* Color Palette Selector */}
        <section className="flex flex-col gap-3" aria-label="Drawing appearance">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-xs font-medium text-foreground">Stroke color</h4>
            <ColorPicker
              aria-label="Custom annotation color"
              size="sm"
              value={strokeColor}
              onChange={(color) => updateSettings({ strokeColor: color })}
            />
          </div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Annotation color palette">
            {ANNOTATION_PALETTES.map((palette) => (
              <IconButton
                key={palette.id}
                label={palette.name}
                aria-pressed={strokeColor.toLowerCase() === palette.color.toLowerCase()}
                onClick={() => updateSettings({ strokeColor: palette.color })}
                className="size-8 shrink-0"
              >
                <span
                  className="flex size-5 items-center justify-center rounded-full border border-border"
                  style={{ backgroundColor: palette.color }}
                >
                  {strokeColor.toLowerCase() === palette.color.toLowerCase() ? (
                    <Check
                      className="size-3 rounded-full bg-background text-foreground"
                      aria-hidden
                    />
                  ) : null}
                </span>
              </IconButton>
            ))}
          </div>

          {/* Stroke Width & Style */}
          <NumberInputField
            label="Stroke width"
            value={strokeWidth}
            min={0}
            max={64}
            step={1}
            unit="px"
            size="sm"
            onChange={(width) => updateSettings({ strokeWidth: width })}
          />
          <ToggleGroup
            type="single"
            value={strokeStyle}
            aria-label="Stroke style"
            onValueChange={(style) => {
              if (style === "solid" || style === "dashed" || style === "dotted")
                updateSettings({ strokeStyle: style })
            }}
            className="grid grid-cols-3 gap-1 rounded-lg border border-border bg-surface-dim p-1"
          >
            {["solid", "dashed", "dotted"].map((style) => (
              <ToggleGroupItem key={style} value={style} className="px-1 text-xs capitalize">
                {style}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </section>
      </div>

      {/* Draw on Canvas Mode toggle */}
      <div className="flex shrink-0 flex-col gap-2 border-t border-border bg-surface p-3">
        <Button onClick={handleAddAnnotation} disabled={!timeline} className="w-full">
          <Plus aria-hidden />
          Add annotation
        </Button>
        <Button
          variant={drawMode ? "secondary" : "outline"}
          aria-pressed={drawMode}
          onClick={() => onToggleDrawMode(!drawMode)}
          disabled={!timeline}
          className="w-full"
        >
          {drawMode ? <MousePointer2 aria-hidden /> : <Pencil aria-hidden />}
          {drawMode ? "Finish drawing" : "Draw on canvas"}
        </Button>
        {selectedAnnotation ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleApplyToSelected}
            disabled={selectedAnnotation.locked}
            className="w-full"
          >
            {selectedAnnotation.locked ? "Unlock annotation to restyle" : "Apply to selected"}
          </Button>
        ) : null}
        <p className="text-center text-xs leading-relaxed text-muted-foreground" role="status">
          {drawMode ? (
            <>
              Drag to draw · <Kbd>Shift</Kbd> constrains · <Kbd>Esc</Kbd> exits
            </>
          ) : (
            "Adds at the playhead. Existing annotations stay unchanged."
          )}
        </p>
      </div>

      {/* Preset Browser */}
      <PresetBrowser
        kind="annotation"
        open={browserOpen}
        onOpenChange={setBrowserOpen}
        selectedPresetId={preset.presetId}
        onSelect={handleChoosePreset}
      />
    </div>
  )
}
