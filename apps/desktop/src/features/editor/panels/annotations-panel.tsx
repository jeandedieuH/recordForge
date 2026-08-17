import { useState } from "react"
import type { AnnotationType } from "@recordforge/contracts"
import {
  ANNOTATION_PALETTES,
  annotationPresetToShapePreset,
  applyPresetToAnnotationClip,
  createAddAnnotationClipCommand,
  createAnnotationClip,
  createUpdateAnnotationClipCommand,
  type AnnotationPresetRecord,
} from "@recordforge/editor-core"
import { useTimelineStore } from "../../../stores/timeline-store"
import { Button, cn } from "@recordforge/ui"
import { Pencil, Shapes } from "lucide-react"
import { PresetBrowser, type BrowserPreset } from "./preset-browser"

interface AnnotationsPanelProps {
  drawMode?: boolean
  onToggleDrawMode?: (enabled: boolean, type: AnnotationType, color: string) => void
}

export function AnnotationsPanel({ drawMode = false, onToggleDrawMode }: AnnotationsPanelProps) {
  const [selectedColor, setSelectedColor] = useState<string>("#38bdf8")
  const [strokeWidth, setStrokeWidth] = useState<number>(4)
  const [strokeStyle, setStrokeStyle] = useState<"solid" | "dashed" | "dotted">("solid")

  const engine = useTimelineStore((state) => state.engine)
  const view = useTimelineStore((state) => state.view)
  const execute = useTimelineStore((state) => state.execute)
  const setSelection = useTimelineStore((state) => state.setSelection)

  const timeline = engine?.history.present
  const canvasWidth = timeline?.canvas.width ?? 1920
  const canvasHeight = timeline?.canvas.height ?? 1080

  const selectedAnnotationClip = (() => {
    if (!timeline || view.selection?.kind !== "clip") return null
    const primaryClipId = view.selection.primaryClipId
    for (const track of timeline.tracks) {
      const clip = track.clips.find((candidate) => candidate.id === primaryClipId)
      if (clip?.kind === "annotation") return { clip }
    }
    return null
  })()

  function handleAddPreset(preset: BrowserPreset) {
    const shape = annotationPresetToShapePreset(preset as AnnotationPresetRecord)
    if (selectedAnnotationClip) {
      const updated = applyPresetToAnnotationClip(selectedAnnotationClip.clip, shape)
      execute(createUpdateAnnotationClipCommand(selectedAnnotationClip.clip.id, updated))
      return
    }

    const startMs = Math.round(view.playheadMs)
    const clip = createAnnotationClip(shape.type, {
      startMs,
      durationMs: 3500,
      strokeColor: selectedColor,
      strokeWidth,
      text: shape.text,
      canvasWidth,
      canvasHeight,
    })
    clip.strokeStyle = strokeStyle
    clip.fillColor = shape.defaultFillColor
    clip.fillOpacity = shape.defaultFillOpacity

    const annotationsTrack = timeline?.tracks.find((track) => track.kind === "annotations")
    const ok = execute(createAddAnnotationClipCommand(clip, annotationsTrack?.id))
    if (ok) {
      setSelection({
        kind: "clip",
        clipIds: [clip.id],
        primaryClipId: clip.id,
      })
    }
  }

  function handleQuickDraw(type: AnnotationType, color: string) {
    onToggleDrawMode?.(true, type, color)
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface">
      {/* Header */}
      <div className="border-b border-border p-3.5 pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-md bg-secondary/20 text-secondary">
              <Shapes className="size-4 text-purple-400" aria-hidden />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">Annotations & Shapes</h3>
              <p className="text-[11px] text-muted-foreground">
                {selectedAnnotationClip
                  ? "Click a preset to apply it to the selected annotation"
                  : "Draw and place vector callouts"}
              </p>
            </div>
          </div>
        </div>

        {/* Color Palette Selector */}
        <div className="mt-3">
          <label className="text-[11px] font-medium text-muted-foreground mb-1.5 block">
            Color Theme
          </label>
          <div className="flex items-center gap-1.5 flex-wrap">
            {ANNOTATION_PALETTES.map((palette) => {
              const isSelected = selectedColor.toLowerCase() === palette.color.toLowerCase()
              return (
                <button
                  key={palette.id}
                  type="button"
                  onClick={() => {
                    setSelectedColor(palette.color)
                    if (drawMode && onToggleDrawMode) {
                      handleQuickDraw("rectangle", palette.color)
                    }
                  }}
                  className={cn(
                    "size-6 rounded-full border border-border transition-all duration-fast hover:scale-110",
                    isSelected
                      ? "ring-2 ring-primary ring-offset-2 ring-offset-surface scale-105 border-white"
                      : "",
                  )}
                  style={{ backgroundColor: palette.color }}
                  title={palette.name}
                  aria-label={palette.name}
                />
              )
            })}
          </div>
        </div>

        {/* Stroke Width & Style */}
        <div className="mt-3 flex items-center justify-between gap-2">
          <div>
            <label className="text-[11px] font-medium text-muted-foreground mb-1 block">
              Width
            </label>
            <div
              className="flex items-center gap-0.5 rounded-lg border border-border bg-surface-dim p-0.5"
              role="group"
              aria-label="Stroke width"
            >
              {[2, 4, 6, 8].map((width) => (
                <button
                  key={width}
                  type="button"
                  onClick={() => setStrokeWidth(width)}
                  className={cn(
                    "h-6 px-2 text-[11px] rounded-md transition-colors",
                    strokeWidth === width
                      ? "bg-surface text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {width}px
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-[11px] font-medium text-muted-foreground mb-1 block">
              Style
            </label>
            <div
              className="flex items-center gap-0.5 rounded-lg border border-border bg-surface-dim p-0.5"
              role="group"
              aria-label="Stroke style"
            >
              {(["solid", "dashed"] as const).map((style) => (
                <button
                  key={style}
                  type="button"
                  onClick={() => setStrokeStyle(style)}
                  className={cn(
                    "h-6 px-2 text-[11px] rounded-md transition-colors capitalize",
                    strokeStyle === style
                      ? "bg-surface text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {style}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Draw on Canvas Mode toggle */}
        {onToggleDrawMode ? (
          <div className="mt-3">
            <Button
              variant={drawMode ? "primary" : "outline"}
              size="sm"
              onClick={() => onToggleDrawMode(!drawMode, "rectangle", selectedColor)}
              className="w-full gap-2 text-xs font-medium"
            >
              <Pencil className="size-3.5" aria-hidden />
              {drawMode ? "Drawing Mode Active (Click-drag on player)" : "Enable Draw on Player"}
            </Button>
          </div>
        ) : null}
      </div>

      {/* Preset Browser */}
      <PresetBrowser
        kind="annotation"
        selectedPresetId={selectedAnnotationClip?.clip.presetId}
        onSelect={(preset) => {
          if (drawMode && onToggleDrawMode) {
            const shape = annotationPresetToShapePreset(preset as AnnotationPresetRecord)
            handleQuickDraw(shape.type, selectedColor)
          } else {
            handleAddPreset(preset)
          }
        }}
        className="p-3"
      />
    </div>
  )
}
