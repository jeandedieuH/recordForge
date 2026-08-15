import { useState } from "react"
import {
  ANNOTATION_PALETTES,
  ANNOTATION_SHAPES,
  createAnnotationClip,
  createAddAnnotationClipCommand,
  type AnnotationShapePreset,
} from "@recordforge/editor-core"
import type { AnnotationType } from "@recordforge/contracts"
import { useTimelineStore } from "../../../stores/timeline-store"
import {
  Button,
  Card,
  CardContent,
  ScrollArea,
  ToggleGroup,
  ToggleGroupItem,
  cn,
} from "@recordforge/ui"
import {
  ArrowUpRight,
  Circle,
  MessageSquare,
  Minus,
  Pencil,
  Radio,
  Shapes,
  ShieldAlert,
  Square,
} from "lucide-react"

interface AnnotationsPanelProps {
  drawMode?: boolean
  onToggleDrawMode?: (enabled: boolean, type: AnnotationType, color: string) => void
}

export function AnnotationsPanel({ drawMode = false, onToggleDrawMode }: AnnotationsPanelProps) {
  const [selectedType, setSelectedType] = useState<AnnotationType>("rectangle")
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

  function handleAddShape(shape: AnnotationShapePreset) {
    const startMs = Math.round(view.playheadMs)
    const clip = createAnnotationClip(shape.type, {
      startMs,
      durationMs: 3500,
      strokeColor: selectedColor,
      strokeWidth,
      canvasWidth,
      canvasHeight,
    })
    clip.strokeStyle = strokeStyle

    const annotationsTrack = timeline?.tracks.find((t) => t.kind === "annotations")
    const ok = execute(createAddAnnotationClipCommand(clip, annotationsTrack?.id))
    if (ok) {
      setSelection({
        kind: "clip",
        clipIds: [clip.id],
        primaryClipId: clip.id,
      })
    }
  }

  function getShapeIcon(type: AnnotationType) {
    switch (type) {
      case "rectangle":
        return Square
      case "rounded-rect":
        return Square
      case "circle":
        return Circle
      case "arrow":
        return ArrowUpRight
      case "line":
        return Minus
      case "callout":
        return MessageSquare
      case "spotlight":
        return Radio
      case "badge":
        return ShieldAlert
      default:
        return Shapes
    }
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
              <p className="text-[11px] text-muted-foreground">Draw and place vector callouts</p>
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
                      onToggleDrawMode(true, selectedType, palette.color)
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
            <ToggleGroup
              type="single"
              value={String(strokeWidth)}
              onValueChange={(val) => val && setStrokeWidth(Number(val))}
              className="bg-surface-dim p-0.5 rounded-lg border border-border"
            >
              <ToggleGroupItem value="2" className="h-6 px-2 text-[11px]">
                2px
              </ToggleGroupItem>
              <ToggleGroupItem value="4" className="h-6 px-2 text-[11px]">
                4px
              </ToggleGroupItem>
              <ToggleGroupItem value="6" className="h-6 px-2 text-[11px]">
                6px
              </ToggleGroupItem>
              <ToggleGroupItem value="8" className="h-6 px-2 text-[11px]">
                8px
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          <div>
            <label className="text-[11px] font-medium text-muted-foreground mb-1 block">
              Style
            </label>
            <ToggleGroup
              type="single"
              value={strokeStyle}
              onValueChange={(val) => val && setStrokeStyle(val as any)}
              className="bg-surface-dim p-0.5 rounded-lg border border-border"
            >
              <ToggleGroupItem value="solid" className="h-6 px-2 text-[11px]">
                Solid
              </ToggleGroupItem>
              <ToggleGroupItem value="dashed" className="h-6 px-2 text-[11px]">
                Dashed
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>

        {/* Draw on Canvas Mode toggle */}
        {onToggleDrawMode ? (
          <div className="mt-3">
            <Button
              variant={drawMode ? "primary" : "outline"}
              size="sm"
              onClick={() => onToggleDrawMode(!drawMode, selectedType, selectedColor)}
              className="w-full gap-2 text-xs font-medium"
            >
              <Pencil className="size-3.5" aria-hidden />
              {drawMode ? "Drawing Mode Active (Click-drag on player)" : "Enable Draw on Player"}
            </Button>
          </div>
        ) : null}
      </div>

      {/* Shape Library Grid */}
      <ScrollArea className="flex-1 p-3">
        <div className="grid grid-cols-2 gap-2 pb-6">
          {ANNOTATION_SHAPES.map((shape) => {
            const Icon = getShapeIcon(shape.type)
            const isSelected = selectedType === shape.type
            return (
              <Card
                key={shape.type}
                onClick={() => {
                  setSelectedType(shape.type)
                  if (drawMode && onToggleDrawMode) {
                    onToggleDrawMode(true, shape.type, selectedColor)
                  } else {
                    handleAddShape(shape)
                  }
                }}
                className={cn(
                  "group relative cursor-pointer overflow-hidden border border-border bg-surface-container transition-all duration-fast ease-forge hover:border-primary/60 hover:bg-surface-container-high hover:shadow-e2",
                  isSelected && "border-primary bg-surface-container-high",
                )}
              >
                <CardContent className="flex flex-col items-center justify-center p-3 text-center">
                  <div
                    className="flex size-11 items-center justify-center rounded-xl transition-transform duration-fast group-hover:scale-105"
                    style={{
                      backgroundColor: `${selectedColor}18`,
                      color: selectedColor,
                    }}
                  >
                    <Icon className="size-6" aria-hidden />
                  </div>
                  <h4 className="mt-2 text-xs font-semibold text-foreground group-hover:text-primary transition-colors">
                    {shape.name}
                  </h4>
                  <p className="mt-0.5 line-clamp-1 text-[10px] text-muted-foreground">
                    {shape.description}
                  </p>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}
