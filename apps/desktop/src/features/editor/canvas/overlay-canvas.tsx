import { useCallback, useEffect, useRef, useState } from "react"
import type { AnnotationClip, OverlayRenderPlan } from "@recordforge/contracts"
import {
  createOverlayWasmEngine,
  renderOverlayDisplayList,
  type OverlayEngine,
} from "@recordforge/overlay-core"
import { cn } from "@recordforge/ui"
import {
  DEFAULT_ANNOTATION_DRAW_SETTINGS,
  type AnnotationDrawSettings,
} from "../annotations/annotation-tools"
import { usePlayheadMs } from "../timeline/use-playback-state"
import { getAnnotationDrawingPreview } from "./annotation-drawing"
import { createAnnotationDrawingSession } from "./annotation-drawing-session"

interface OverlayCanvasProps {
  renderPlan: OverlayRenderPlan
  canvasWidth: number
  canvasHeight: number
  assetUrls?: Readonly<Record<string, string>>
  drawMode?: boolean
  drawSettings?: AnnotationDrawSettings
  onCreateClip?: (clip: AnnotationClip) => void
  className?: string
}

export function OverlayCanvas({
  renderPlan,
  canvasWidth,
  canvasHeight,
  assetUrls = {},
  drawMode = false,
  drawSettings = DEFAULT_ANNOTATION_DRAW_SETTINGS,
  onCreateClip,
  className,
}: OverlayCanvasProps) {
  const playheadMs = usePlayheadMs()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<OverlayEngine | null>(null)
  const imageCacheRef = useRef(new Map<string, HTMLImageElement>())
  const renderFrameRef = useRef<() => void>(() => undefined)
  const onCreateClipRef = useRef(onCreateClip)
  onCreateClipRef.current = onCreateClip
  const [engineVersion, setEngineVersion] = useState(0)
  const drawingRef = useRef<ReturnType<typeof createAnnotationDrawingSession> | null>(null)
  if (!drawingRef.current) {
    drawingRef.current = createAnnotationDrawingSession({
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (id) => cancelAnimationFrame(id),
      onInvalidate: () => renderFrameRef.current(),
      onCreateClip: (clip) => onCreateClipRef.current?.(clip),
    })
  }
  const drawing = drawingRef.current

  useEffect(() => {
    let isCancelled = false

    void createOverlayWasmEngine(renderPlan).then(
      (engine) => {
        if (isCancelled) {
          engine.dispose()
          return
        }
        const previousEngine = engineRef.current
        engineRef.current = engine
        previousEngine?.dispose()
        setEngineVersion((version) => version + 1)
      },
      (error) => {
        console.warn("Failed to create WASM overlay engine for preview:", error)
      },
    )

    return () => {
      isCancelled = true
    }
  }, [renderPlan])

  useEffect(() => {
    return () => {
      drawing.dispose()
      const engine = engineRef.current
      engineRef.current = null
      engine?.dispose()
    }
  }, [drawing])

  useEffect(() => {
    drawing.cancel()
  }, [drawMode, drawSettings, canvasWidth, canvasHeight, drawing])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || !drawing.isActive()) return
      event.preventDefault()
      event.stopPropagation()
      drawing.cancel()
    }
    function handleBlur() {
      drawing.cancel()
    }
    window.addEventListener("keydown", handleKeyDown, true)
    window.addEventListener("blur", handleBlur)
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true)
      window.removeEventListener("blur", handleBlur)
    }
  }, [drawing])

  const renderFrame = useCallback(() => {
    const canvas = canvasRef.current
    const engine = engineRef.current
    if (!canvas) return

    if (canvas.width !== canvasWidth) canvas.width = canvasWidth
    if (canvas.height !== canvasHeight) canvas.height = canvasHeight

    try {
      // Existing clips retain canonical WASM evaluation. Only the transient draft bypasses
      // timeline animation, sharing the renderer so arrow heads, fills and stroke styles match.
      const displayList = engine?.evaluate(playheadMs) ?? { timeMs: 0, items: [] }
      const draft = drawing.getPreview()
      renderOverlayDisplayList(
        draft
          ? { ...displayList, items: [...displayList.items, getAnnotationDrawingPreview(draft)] }
          : displayList,
        canvas,
        {
          assetUrls,
          imageCache: imageCacheRef.current,
          onImageLoad: () => renderFrameRef.current(),
        },
      )
    } catch (err) {
      canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height)
      console.warn("Overlay renderToCanvas error:", err)
    }
  }, [assetUrls, canvasHeight, canvasWidth, drawing, playheadMs])

  renderFrameRef.current = renderFrame

  useEffect(() => {
    renderFrame()
  }, [engineVersion, renderFrame])

  function getCanvasCoords(clientX: number, clientY: number): { x: number; y: number } {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    const x = ((clientX - rect.left) / Math.max(1, rect.width)) * canvasWidth
    const y = ((clientY - rect.top) / Math.max(1, rect.height)) * canvasHeight
    return {
      x: Math.max(0, Math.min(canvasWidth, x)),
      y: Math.max(0, Math.min(canvasHeight, y)),
    }
  }

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawMode || event.button !== 0 || !event.isPrimary) return
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    drawing.start({
      pointerId: event.pointerId,
      target: event.currentTarget,
      point: getCanvasCoords(event.clientX, event.clientY),
      shiftKey: event.shiftKey,
      settings: drawSettings,
      startMs: playheadMs,
      bounds: {
        width: canvasWidth,
        height: canvasHeight,
        // Keep the dead zone at five screen pixels even when the preview is scaled down.
        minimumWidth: (5 * canvasWidth) / Math.max(1, rect.width),
        minimumHeight: (5 * canvasHeight) / Math.max(1, rect.height),
      },
    })
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (
      drawing.move({
        pointerId: event.pointerId,
        point: getCanvasCoords(event.clientX, event.clientY),
        shiftKey: event.shiftKey,
      })
    ) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  function handlePointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    drawing.finish({
      pointerId: event.pointerId,
      point: getCanvasCoords(event.clientX, event.clientY),
      shiftKey: event.shiftKey,
    })
  }

  function handlePointerCancel(event: React.PointerEvent<HTMLCanvasElement>) {
    drawing.cancel(event.pointerId)
  }

  return (
    <canvas
      ref={canvasRef}
      width={canvasWidth}
      height={canvasHeight}
      aria-label="Overlay preview canvas"
      className={cn(
        "absolute inset-0 size-full",
        drawMode ? "pointer-events-auto touch-none cursor-crosshair" : "pointer-events-none",
        className,
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handlePointerCancel}
    />
  )
}
