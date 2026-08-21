import { useEffect, useMemo, useRef, useState } from "react"
import type {
  OverlayDisplayAnnotation,
  OverlayDisplayList,
  OverlayDisplayText,
} from "@recordforge/contracts"
import {
  annotationPresetToShapePreset,
  createAnnotationClipFromPreset,
  createTextClipFromDefinition,
  textPresetToDefinition,
  type AnnotationPresetRecord,
  type PresetDefinition,
  type TextPresetDefinition,
  type TextPresetRecord,
} from "@recordforge/editor-core"
import { renderOverlayDisplayList } from "@recordforge/overlay-core"
import { Skeleton, cn } from "@recordforge/ui"
import { AlertTriangle, Shapes, Type } from "lucide-react"

const THUMBNAIL_WIDTH = 640
const THUMBNAIL_HEIGHT = 360

type AnnotationPreset = PresetDefinition<AnnotationPresetRecord["definition"]>
type TextPreset = TextPresetRecord

interface PresetThumbnailProps {
  kind: "annotation" | "text"
  preset: AnnotationPreset | TextPreset
  className?: string
}

export function PresetThumbnail({ kind, preset, className }: PresetThumbnailProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")

  const displayList = useMemo<OverlayDisplayList | null>(() => {
    try {
      if (kind === "annotation") {
        const item = createAnnotationDisplayItem(preset as AnnotationPreset)
        return { timeMs: 1_000, items: [item] }
      }
      const item = createTextDisplayItem(preset as TextPreset)
      return { timeMs: 1_000, items: [item] }
    } catch {
      return null
    }
  }, [kind, preset])

  useEffect(() => {
    if (!displayList) {
      setStatus("error")
      return
    }

    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = THUMBNAIL_WIDTH
    canvas.height = THUMBNAIL_HEIGHT

    try {
      renderOverlayDisplayList(displayList, canvas)
      setStatus("ready")
    } catch {
      setStatus("error")
    }
  }, [displayList])

  return (
    <div
      className={cn(
        "relative aspect-video w-full overflow-hidden rounded-lg border border-border bg-overlay",
        className,
      )}
      aria-label={`${preset.name} preview`}
    >
      <canvas ref={canvasRef} className="size-full" aria-hidden />
      {status === "loading" ? <Skeleton className="absolute inset-0 rounded-none" /> : null}
      {status === "error" ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-muted-foreground">
          <AlertTriangle className="size-5" aria-hidden />
          <span className="text-[10px]">Preview unavailable</span>
        </div>
      ) : null}
      {status === "ready" ? null : (
        <div className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-black/50 p-1.5 text-white/70">
          {kind === "annotation" ? (
            <Shapes className="size-3.5" aria-hidden />
          ) : (
            <Type className="size-3.5" aria-hidden />
          )}
        </div>
      )}
    </div>
  )
}

function createTextDisplayItem(preset: TextPreset): OverlayDisplayText {
  const def =
    "definition" in preset && preset.definition
      ? textPresetToDefinition(preset as TextPreset)
      : (preset as unknown as TextPresetDefinition)

  const clip = createTextClipFromDefinition(def, {
    id: `thumb-${preset.id}`,
    startMs: 0,
    durationMs: 2_000,
    canvasWidth: THUMBNAIL_WIDTH,
    canvasHeight: THUMBNAIL_HEIGHT,
  })

  return {
    id: clip.id,
    kind: "text",
    zIndex: 0,
    transform: {
      x: clip.x,
      y: clip.y,
      width: clip.width,
      height: clip.height,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
      zIndex: 0,
      opacity: 1,
    },
    animationProgress: 1,
    textProgress: 1,
    presetId: clip.presetId,
    category: clip.category,
    primaryText: clip.primaryText,
    secondaryText: clip.secondaryText,
    tagText: clip.tagText,
    alignment: clip.alignment,
    fontFamily: clip.fontFamily,
    fontSize: clip.fontSize,
    fontWeight: clip.fontWeight,
    textColor: clip.textColor,
    secondaryTextColor: clip.secondaryTextColor,
    accentColor: clip.accentColor,
    backdropStyle: clip.backdropStyle,
    backdropColor: clip.backdropColor,
    backdropOpacity: clip.backdropOpacity,
    backdropBlur: clip.backdropBlur,
    backdropBorderRadius: clip.backdropBorderRadius,
    backdropPaddingX: clip.backdropPaddingX,
    backdropPaddingY: clip.backdropPaddingY,
    shadowEnabled: clip.shadowEnabled,
    shadowColor: clip.shadowColor,
    shadowBlur: clip.shadowBlur,
    autoScaleText: clip.autoScaleText ?? true,
  }
}

function createAnnotationDisplayItem(preset: AnnotationPreset): OverlayDisplayAnnotation {
  const shapePreset = annotationPresetToShapePreset(preset)
  const clip = createAnnotationClipFromPreset(shapePreset, {
    id: `thumb-${preset.id}`,
    startMs: 0,
    durationMs: 2_000,
    canvasWidth: THUMBNAIL_WIDTH,
    canvasHeight: THUMBNAIL_HEIGHT,
  })

  return {
    id: clip.id,
    kind: "annotation",
    zIndex: 0,
    transform: {
      x: clip.x,
      y: clip.y,
      width: clip.width,
      height: clip.height,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
      zIndex: 0,
      opacity: 1,
    },
    animationProgress: 1,
    drawProgress: 1,
    annotationType: clip.annotationType,
    endX: clip.endX,
    endY: clip.endY,
    strokeColor: clip.strokeColor,
    strokeWidth: clip.strokeWidth,
    strokeStyle: clip.strokeStyle,
    fillColor: clip.fillColor,
    fillOpacity: clip.fillOpacity,
    cornerRadius: clip.cornerRadius,
    arrowEndHead: clip.arrowEndHead,
    arrowStartHead: clip.arrowStartHead,
    shadowEnabled: clip.shadowEnabled,
    shadowColor: clip.shadowColor,
    shadowBlur: clip.shadowBlur,
    text: clip.text,
    textColor: clip.textColor,
    fontSize: clip.fontSize,
  }
}
