import { useCallback, useEffect, useRef, useState } from "react"
import type { AnnotationClip, AnnotationType, OverlayRenderPlan } from "@recordforge/contracts"
import { createAnnotationClip } from "@recordforge/editor-core"
import { createOverlayWasmEngine, type OverlayEngine } from "@recordforge/overlay-core"
import { cn } from "@recordforge/ui"
import { usePlayheadMs } from "../timeline/use-playback-state"

interface OverlayCanvasProps {
  renderPlan: OverlayRenderPlan
  canvasWidth: number
  canvasHeight: number
  assetUrls?: Readonly<Record<string, string>>
  drawMode?: boolean
  drawType?: AnnotationType
  drawColor?: string
  onCreateClip?: (clip: AnnotationClip) => void
  className?: string
}

interface DrawState {
  pointerId: number
  startX: number
  startY: number
  currentX: number
  currentY: number
}

export function OverlayCanvas({
  renderPlan,
  canvasWidth,
  canvasHeight,
  assetUrls = {},
  drawMode = false,
  drawType = "rectangle",
  drawColor = "#38bdf8",
  onCreateClip,
  className,
}: OverlayCanvasProps) {
  const playheadMs = usePlayheadMs()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<OverlayEngine | null>(null)
  const imageCacheRef = useRef(new Map<string, HTMLImageElement>())
  const renderFrameRef = useRef<() => void>(() => undefined)
  const [engineVersion, setEngineVersion] = useState(0)
  const [drawState, setDrawState] = useState<DrawState | null>(null)

  useEffect(() => {
    let isCancelled = false
    const previousEngine = engineRef.current
    engineRef.current = null
    previousEngine?.dispose()
    setEngineVersion((version) => version + 1)
    imageCacheRef.current.clear()

    void createOverlayWasmEngine(renderPlan).then(
      (engine) => {
        if (isCancelled) {
          engine.dispose()
          return
        }
        engineRef.current = engine
        setEngineVersion((version) => version + 1)
      },
      () => {
        if (!isCancelled) setEngineVersion((version) => version + 1)
      },
    )

    return () => {
      isCancelled = true
      const engine = engineRef.current
      engineRef.current = null
      engine?.dispose()
    }
  }, [renderPlan])

  const renderFrame = useCallback(() => {
    const canvas = canvasRef.current
    const engine = engineRef.current
    if (!canvas || !engine) return

    if (canvas.width !== canvasWidth) canvas.width = canvasWidth
    if (canvas.height !== canvasHeight) canvas.height = canvasHeight

    engine.renderToCanvas(playheadMs, canvas, {
      assetUrls,
      imageCache: imageCacheRef.current,
      onImageLoad: () => renderFrameRef.current(),
    })

    const currentDrawState = drawState
    if (!currentDrawState) return
    const context = canvas.getContext("2d")
    if (!context) return
    context.save()
    context.globalAlpha = 0.7
    context.strokeStyle = drawColor
    context.fillStyle = drawColor
    context.setLineDash([6, 6])
    const x = Math.min(currentDrawState.startX, currentDrawState.currentX)
    const y = Math.min(currentDrawState.startY, currentDrawState.currentY)
    const width = Math.abs(currentDrawState.currentX - currentDrawState.startX)
    const height = Math.abs(currentDrawState.currentY - currentDrawState.startY)
    context.fillRect(x, y, width, height)
    context.strokeRect(x, y, width, height)
    context.restore()
  }, [assetUrls, canvasHeight, canvasWidth, drawColor, drawState, playheadMs])

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
    if (!drawMode || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = getCanvasCoords(event.clientX, event.clientY)
    setDrawState({
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
    })
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawState || drawState.pointerId !== event.pointerId) return
    event.preventDefault()
    const point = getCanvasCoords(event.clientX, event.clientY)
    setDrawState((current) =>
      current ? { ...current, currentX: point.x, currentY: point.y } : null,
    )
  }

  function handlePointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawState || drawState.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const point = getCanvasCoords(event.clientX, event.clientY)
    const current = drawState
    setDrawState(null)

    const width = Math.abs(point.x - current.startX)
    const height = Math.abs(point.y - current.startY)
    if ((drawType === "arrow" || drawType === "line") && width < 5 && height < 5) return
    if (drawType !== "arrow" && drawType !== "line" && (width < 10 || height < 10)) return

    const clip = createAnnotationClip(drawType, {
      startMs: Math.round(playheadMs),
      durationMs: 3_500,
      strokeColor: drawColor,
      canvasWidth,
      canvasHeight,
    })
    if (drawType === "arrow" || drawType === "line") {
      clip.x = current.startX
      clip.y = current.startY
      clip.endX = point.x
      clip.endY = point.y
      clip.width = width
      clip.height = height
    } else {
      clip.x = Math.min(current.startX, point.x)
      clip.y = Math.min(current.startY, point.y)
      clip.width = width
      clip.height = height
    }
    onCreateClip?.(clip)
  }

  return (
    <canvas
      ref={canvasRef}
      width={canvasWidth}
      height={canvasHeight}
      aria-label="Overlay preview canvas"
      className={cn(
        "absolute inset-0 size-full",
        drawMode ? "pointer-events-auto cursor-crosshair" : "pointer-events-none",
        className,
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    />
  )
}
