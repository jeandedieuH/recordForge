import { useEffect, useMemo, useRef, useState } from "react"
import type { TimelineState } from "@recordforge/contracts"
import { defaultCursorSettings } from "@recordforge/domain"
import {
  annotationPresetToShapePreset,
  createAnnotationClipFromPreset,
  createTextClipFromDefinition,
  textPresetToDefinition,
  type AnnotationPresetRecord,
  type PresetDefinition,
  type TextPresetRecord,
} from "@recordforge/editor-core"
import { buildOverlayRenderPlan } from "@recordforge/media-core"
import { createOverlayWasmEngine } from "@recordforge/overlay-core"
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
  const plan = useMemo(() => createThumbnailPlan(kind, preset), [kind, preset])

  useEffect(() => {
    let isCancelled = false
    setStatus("loading")
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = THUMBNAIL_WIDTH
    canvas.height = THUMBNAIL_HEIGHT

    void createOverlayWasmEngine(plan).then(
      (engine) => {
        if (isCancelled) {
          engine.dispose()
          return
        }
        engine.renderToCanvas(1_000, canvas)
        setStatus("ready")
        engine.dispose()
      },
      () => {
        if (!isCancelled) setStatus("error")
      },
    )

    return () => {
      isCancelled = true
    }
  }, [plan])

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

function createThumbnailPlan(kind: "annotation" | "text", preset: AnnotationPreset | TextPreset) {
  const id = `preset-thumbnail-${preset.id}`
  const clip =
    kind === "annotation"
      ? createAnnotationClipFromPreset(annotationPresetToShapePreset(preset as AnnotationPreset), {
          id,
          startMs: 0,
          durationMs: 2_000,
          canvasWidth: THUMBNAIL_WIDTH,
          canvasHeight: THUMBNAIL_HEIGHT,
        })
      : createTextClipFromDefinition(textPresetToDefinition(preset as TextPreset), {
          id,
          startMs: 0,
          durationMs: 2_000,
          canvasWidth: THUMBNAIL_WIDTH,
          canvasHeight: THUMBNAIL_HEIGHT,
        })

  const timeline: TimelineState = {
    version: 1,
    id: id,
    name: "Preset preview",
    recordingId: "preset-preview",
    canvas: {
      width: THUMBNAIL_WIDTH,
      height: THUMBNAIL_HEIGHT,
      fps: 30,
      background: "#090d16",
      padding: 0,
      borderRadius: 0,
      shadow: false,
      cursorSettings: defaultCursorSettings,
    },
    tracks: [
      {
        id: "preset-preview-overlay",
        kind: "overlay",
        name: "Preset preview",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [clip],
      },
    ],
    markers: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }

  return buildOverlayRenderPlan(timeline)
}
