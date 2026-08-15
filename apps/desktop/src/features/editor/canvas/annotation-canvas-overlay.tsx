import { useRef, useState } from "react"
import type { AnnotationClip, AnnotationType } from "@recordforge/contracts"
import { createAnnotationClip } from "@recordforge/editor-core"
import { cn } from "@recordforge/ui"

interface AnnotationCanvasOverlayProps {
  clips: AnnotationClip[]
  playheadMs: number
  canvasWidth: number
  canvasHeight: number
  selectedClipId?: string | null
  drawMode?: boolean
  drawType?: AnnotationType
  drawColor?: string
  onSelectClip?: (clip: AnnotationClip) => void
  onUpdateClip?: (
    clipId: string,
    update: Partial<AnnotationClip>,
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
  onCreateClip?: (clip: AnnotationClip) => void
}

interface GestureState {
  clipId: string
  pointerId: number
  mode:
    | "move"
    | "resize-se"
    | "resize-nw"
    | "resize-ne"
    | "resize-sw"
    | "resize-e"
    | "resize-s"
    | "resize-w"
    | "resize-n"
    | "arrow-start"
    | "arrow-end"
  startX: number
  startY: number
  initialClip: AnnotationClip
  moved: boolean
}

interface DrawState {
  pointerId: number
  startX: number
  startY: number
  currentX: number
  currentY: number
}

function isActive(clip: AnnotationClip, playheadMs: number): boolean {
  return (
    clip.enabled !== false &&
    playheadMs >= clip.startMs &&
    playheadMs < clip.startMs + clip.durationMs
  )
}

export function AnnotationCanvasOverlay({
  clips,
  playheadMs,
  canvasWidth,
  canvasHeight,
  selectedClipId,
  drawMode = false,
  drawType = "rectangle",
  drawColor = "#38bdf8",
  onSelectClip,
  onUpdateClip,
  onCreateClip,
}: AnnotationCanvasOverlayProps) {
  const gestureRef = useRef<GestureState | null>(null)
  const [drawState, setDrawState] = useState<DrawState | null>(null)
  const containerRef = useRef<SVGSVGElement>(null)

  function getCanvasCoords(clientX: number, clientY: number) {
    if (!containerRef.current) return { x: 0, y: 0 }
    const rect = containerRef.current.getBoundingClientRect()
    const x = ((clientX - rect.left) / Math.max(1, rect.width)) * canvasWidth
    const y = ((clientY - rect.top) / Math.max(1, rect.height)) * canvasHeight
    return { x: Math.max(0, Math.min(canvasWidth, x)), y: Math.max(0, Math.min(canvasHeight, y)) }
  }

  // Handle direct draw on canvas
  function handlePointerDownCanvas(event: React.PointerEvent<SVGSVGElement>) {
    if (!drawMode || event.button !== 0) return
    event.stopPropagation()
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const { x, y } = getCanvasCoords(event.clientX, event.clientY)
    setDrawState({
      pointerId: event.pointerId,
      startX: x,
      startY: y,
      currentX: x,
      currentY: y,
    })
  }

  function handlePointerMoveCanvas(event: React.PointerEvent<SVGSVGElement>) {
    if (!drawState || drawState.pointerId !== event.pointerId) return
    event.preventDefault()
    const { x, y } = getCanvasCoords(event.clientX, event.clientY)
    setDrawState((prev) => (prev ? { ...prev, currentX: x, currentY: y } : null))
  }

  function handlePointerUpCanvas(event: React.PointerEvent<SVGSVGElement>) {
    if (!drawState || drawState.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const { x, y } = getCanvasCoords(event.clientX, event.clientY)
    const startX = drawState.startX
    const startY = drawState.startY
    setDrawState(null)

    const width = Math.abs(x - startX)
    const height = Math.abs(y - startY)

    if (drawType === "arrow" || drawType === "line") {
      if (width < 5 && height < 5) return
      const clip = createAnnotationClip(drawType, {
        startMs: Math.round(playheadMs),
        durationMs: 3500,
        strokeColor: drawColor,
        canvasWidth,
        canvasHeight,
      })
      clip.x = startX
      clip.y = startY
      clip.endX = x
      clip.endY = y
      clip.width = width
      clip.height = height
      onCreateClip?.(clip)
      return
    }

    if (width < 10 || height < 10) return
    const left = Math.min(startX, x)
    const top = Math.min(startY, y)
    const clip = createAnnotationClip(drawType, {
      startMs: Math.round(playheadMs),
      durationMs: 3500,
      strokeColor: drawColor,
      canvasWidth,
      canvasHeight,
    })
    clip.x = left
    clip.y = top
    clip.width = width
    clip.height = height
    onCreateClip?.(clip)
  }

  // Handle move/resize gestures on shapes
  function beginShapeGesture(
    event: React.PointerEvent,
    clip: AnnotationClip,
    mode: GestureState["mode"],
  ) {
    if (drawMode || event.button !== 0 || !isActive(clip, playheadMs) || clip.locked) return
    event.stopPropagation()
    event.preventDefault()
    ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
    gestureRef.current = {
      clipId: clip.id,
      pointerId: event.pointerId,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      initialClip: { ...clip },
      moved: false,
    }
  }

  function moveShapeGesture(event: React.PointerEvent) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId || !onUpdateClip || !containerRef.current)
      return
    const rect = containerRef.current.getBoundingClientRect()
    const deltaX = ((event.clientX - gesture.startX) / Math.max(1, rect.width)) * canvasWidth
    const deltaY = ((event.clientY - gesture.startY) / Math.max(1, rect.height)) * canvasHeight

    if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1 && !gesture.moved) return
    gesture.moved = true
    event.preventDefault()

    const init = gesture.initialClip
    const update: Partial<AnnotationClip> = {}

    if (gesture.mode === "move") {
      update.x = Math.max(0, Math.min(canvasWidth - init.width, init.x + deltaX))
      update.y = Math.max(0, Math.min(canvasHeight - init.height, init.y + deltaY))
      if (init.endX !== undefined && init.endY !== undefined) {
        update.endX = init.endX + deltaX
        update.endY = init.endY + deltaY
      }
    } else if (gesture.mode === "resize-se") {
      update.width = Math.max(20, init.width + deltaX)
      update.height = Math.max(20, init.height + deltaY)
    } else if (gesture.mode === "resize-nw") {
      const nextW = Math.max(20, init.width - deltaX)
      const nextH = Math.max(20, init.height - deltaY)
      update.x = init.x + (init.width - nextW)
      update.y = init.y + (init.height - nextH)
      update.width = nextW
      update.height = nextH
    } else if (gesture.mode === "arrow-start") {
      update.x = Math.max(0, Math.min(canvasWidth, init.x + deltaX))
      update.y = Math.max(0, Math.min(canvasHeight, init.y + deltaY))
    } else if (gesture.mode === "arrow-end") {
      update.endX = Math.max(0, Math.min(canvasWidth, (init.endX ?? init.x + init.width) + deltaX))
      update.endY = Math.max(
        0,
        Math.min(canvasHeight, (init.endY ?? init.y + init.height) + deltaY),
      )
    }

    onUpdateClip(gesture.clipId, update, { phase: "draft" })
  }

  function finishShapeGesture(event: React.PointerEvent) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const wasCancelled = event.type === "pointercancel"
    const didMove = gesture.moved
    gestureRef.current = null
    try {
      if ((event.currentTarget as Element).hasPointerCapture(event.pointerId)) {
        ;(event.currentTarget as Element).releasePointerCapture(event.pointerId)
      }
    } catch {}

    if (!onUpdateClip) return
    if (wasCancelled || !didMove) {
      onUpdateClip(gesture.clipId, gesture.initialClip, { phase: "cancel" })
      return
    }

    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const deltaX = ((event.clientX - gesture.startX) / Math.max(1, rect.width)) * canvasWidth
    const deltaY = ((event.clientY - gesture.startY) / Math.max(1, rect.height)) * canvasHeight

    const init = gesture.initialClip
    const update: Partial<AnnotationClip> = {}

    if (gesture.mode === "move") {
      update.x = Math.max(0, Math.min(canvasWidth - init.width, init.x + deltaX))
      update.y = Math.max(0, Math.min(canvasHeight - init.height, init.y + deltaY))
      if (init.endX !== undefined && init.endY !== undefined) {
        update.endX = init.endX + deltaX
        update.endY = init.endY + deltaY
      }
    } else if (gesture.mode === "resize-se") {
      update.width = Math.max(20, init.width + deltaX)
      update.height = Math.max(20, init.height + deltaY)
    } else if (gesture.mode === "arrow-start") {
      update.x = Math.max(0, Math.min(canvasWidth, init.x + deltaX))
      update.y = Math.max(0, Math.min(canvasHeight, init.y + deltaY))
    } else if (gesture.mode === "arrow-end") {
      update.endX = Math.max(0, Math.min(canvasWidth, (init.endX ?? init.x + init.width) + deltaX))
      update.endY = Math.max(
        0,
        Math.min(canvasHeight, (init.endY ?? init.y + init.height) + deltaY),
      )
    }

    onUpdateClip(gesture.clipId, update, { phase: "commit" })
  }

  return (
    <svg
      ref={containerRef}
      viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}
      className={cn(
        "absolute inset-0 z-35 size-full overflow-visible",
        drawMode ? "cursor-crosshair pointer-events-auto" : "pointer-events-none",
      )}
      onPointerDown={handlePointerDownCanvas}
      onPointerMove={handlePointerMoveCanvas}
      onPointerUp={handlePointerUpCanvas}
      onPointerCancel={handlePointerUpCanvas}
    >
      <defs>
        <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
          <polygon points="0 0, 10 3.5, 0 7" fill="currentColor" />
        </marker>
        <filter id="annotation-shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="4" stdDeviation="6" floodOpacity="0.5" />
        </filter>
      </defs>

      {/* Render active annotations */}
      {clips.map((clip) => {
        const active = isActive(clip, playheadMs)
        if (!active) return null
        const isSelected = selectedClipId === clip.id

        return (
          <g
            key={clip.id}
            className={cn(
              "pointer-events-auto cursor-move transition-opacity",
              clip.locked && "cursor-default",
            )}
            onClick={(e) => {
              e.stopPropagation()
              onSelectClip?.(clip)
            }}
            onPointerDown={(e) => beginShapeGesture(e, clip, "move")}
            onPointerMove={moveShapeGesture}
            onPointerUp={finishShapeGesture}
            onPointerCancel={finishShapeGesture}
          >
            {/* Spotlight backdrop blackout if spotlight */}
            {clip.annotationType === "spotlight" && (
              <mask id={`spotlight-mask-${clip.id}`}>
                <rect x="0" y="0" width={canvasWidth} height={canvasHeight} fill="white" />
                <ellipse
                  cx={clip.x + clip.width / 2}
                  cy={clip.y + clip.height / 2}
                  rx={clip.width / 2}
                  ry={clip.height / 2}
                  fill="black"
                />
              </mask>
            )}

            {clip.annotationType === "spotlight" && (
              <rect
                x="0"
                y="0"
                width={canvasWidth}
                height={canvasHeight}
                fill="#000000"
                opacity={clip.fillOpacity ?? 0.6}
                mask={`url(#spotlight-mask-${clip.id})`}
                pointerEvents="none"
              />
            )}

            {/* Shape Geometry */}
            {clip.annotationType === "rectangle" && (
              <rect
                x={clip.x}
                y={clip.y}
                width={clip.width}
                height={clip.height}
                stroke={clip.strokeColor}
                strokeWidth={clip.strokeWidth}
                strokeDasharray={
                  clip.strokeStyle === "dashed"
                    ? "8 8"
                    : clip.strokeStyle === "dotted"
                      ? "3 6"
                      : undefined
                }
                fill={clip.fillColor}
                fillOpacity={clip.fillOpacity}
                filter={clip.shadowEnabled ? "url(#annotation-shadow)" : undefined}
              />
            )}

            {clip.annotationType === "rounded-rect" && (
              <rect
                x={clip.x}
                y={clip.y}
                width={clip.width}
                height={clip.height}
                rx={clip.cornerRadius ?? 16}
                ry={clip.cornerRadius ?? 16}
                stroke={clip.strokeColor}
                strokeWidth={clip.strokeWidth}
                strokeDasharray={
                  clip.strokeStyle === "dashed"
                    ? "8 8"
                    : clip.strokeStyle === "dotted"
                      ? "3 6"
                      : undefined
                }
                fill={clip.fillColor}
                fillOpacity={clip.fillOpacity}
                filter={clip.shadowEnabled ? "url(#annotation-shadow)" : undefined}
              />
            )}

            {clip.annotationType === "circle" && (
              <ellipse
                cx={clip.x + clip.width / 2}
                cy={clip.y + clip.height / 2}
                rx={clip.width / 2}
                ry={clip.height / 2}
                stroke={clip.strokeColor}
                strokeWidth={clip.strokeWidth}
                strokeDasharray={
                  clip.strokeStyle === "dashed"
                    ? "8 8"
                    : clip.strokeStyle === "dotted"
                      ? "3 6"
                      : undefined
                }
                fill={clip.fillColor}
                fillOpacity={clip.fillOpacity}
                filter={clip.shadowEnabled ? "url(#annotation-shadow)" : undefined}
              />
            )}

            {clip.annotationType === "arrow" && (
              <g color={clip.strokeColor}>
                <line
                  x1={clip.x}
                  y1={clip.y}
                  x2={clip.endX ?? clip.x + clip.width}
                  y2={clip.endY ?? clip.y + clip.height}
                  stroke={clip.strokeColor}
                  strokeWidth={clip.strokeWidth}
                  strokeDasharray={clip.strokeStyle === "dashed" ? "8 8" : undefined}
                  markerEnd="url(#arrowhead)"
                  filter={clip.shadowEnabled ? "url(#annotation-shadow)" : undefined}
                />
              </g>
            )}

            {clip.annotationType === "line" && (
              <line
                x1={clip.x}
                y1={clip.y}
                x2={clip.endX ?? clip.x + clip.width}
                y2={clip.endY ?? clip.y + clip.height}
                stroke={clip.strokeColor}
                strokeWidth={clip.strokeWidth}
                strokeDasharray={
                  clip.strokeStyle === "dashed"
                    ? "8 8"
                    : clip.strokeStyle === "dotted"
                      ? "4 6"
                      : undefined
                }
                filter={clip.shadowEnabled ? "url(#annotation-shadow)" : undefined}
              />
            )}

            {clip.annotationType === "callout" && (
              <g filter={clip.shadowEnabled ? "url(#annotation-shadow)" : undefined}>
                <rect
                  x={clip.x}
                  y={clip.y}
                  width={clip.width}
                  height={clip.height}
                  rx={clip.cornerRadius ?? 12}
                  stroke={clip.strokeColor}
                  strokeWidth={clip.strokeWidth}
                  fill={clip.fillColor}
                  fillOpacity={clip.fillOpacity}
                />
                <text
                  x={clip.x + clip.width / 2}
                  y={clip.y + clip.height / 2 + (clip.fontSize ?? 16) * 0.35}
                  textAnchor="middle"
                  fill={clip.textColor ?? "#ffffff"}
                  fontSize={clip.fontSize ?? 16}
                  fontWeight="bold"
                  fontFamily="sans-serif"
                >
                  {clip.text}
                </text>
              </g>
            )}

            {clip.annotationType === "badge" && (
              <g filter={clip.shadowEnabled ? "url(#annotation-shadow)" : undefined}>
                <rect
                  x={clip.x}
                  y={clip.y}
                  width={clip.width}
                  height={clip.height}
                  rx={8}
                  stroke={clip.strokeColor}
                  strokeWidth={clip.strokeWidth}
                  fill={clip.fillColor}
                  fillOpacity={clip.fillOpacity}
                />
                <text
                  x={clip.x + clip.width / 2}
                  y={clip.y + clip.height / 2 + 5}
                  textAnchor="middle"
                  fill={clip.textColor ?? "#ffffff"}
                  fontSize={clip.fontSize ?? 14}
                  fontWeight="bold"
                  letterSpacing="1px"
                  fontFamily="sans-serif"
                >
                  {clip.text}
                </text>
              </g>
            )}

            {/* Selection Bounding Box & Handles */}
            {isSelected && !clip.locked && (
              <g>
                <rect
                  x={clip.x - 4}
                  y={clip.y - 4}
                  width={clip.width + 8}
                  height={clip.height + 8}
                  fill="none"
                  stroke="#38bdf8"
                  strokeWidth="2"
                  strokeDasharray="4 4"
                />
                {/* Resize Handle SE */}
                <rect
                  x={clip.x + clip.width - 4}
                  y={clip.y + clip.height - 4}
                  width="12"
                  height="12"
                  fill="#38bdf8"
                  stroke="#ffffff"
                  strokeWidth="2"
                  rx="2"
                  className="cursor-nwse-resize pointer-events-auto"
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    beginShapeGesture(e, clip, "resize-se")
                  }}
                  onPointerMove={moveShapeGesture}
                  onPointerUp={finishShapeGesture}
                  onPointerCancel={finishShapeGesture}
                />
                {/* Resize Handle NW */}
                <rect
                  x={clip.x - 8}
                  y={clip.y - 8}
                  width="12"
                  height="12"
                  fill="#38bdf8"
                  stroke="#ffffff"
                  strokeWidth="2"
                  rx="2"
                  className="cursor-nwse-resize pointer-events-auto"
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    beginShapeGesture(e, clip, "resize-nw")
                  }}
                  onPointerMove={moveShapeGesture}
                  onPointerUp={finishShapeGesture}
                  onPointerCancel={finishShapeGesture}
                />
                {/* Arrow specific start/end handles */}
                {(clip.annotationType === "arrow" || clip.annotationType === "line") && (
                  <>
                    <circle
                      cx={clip.x}
                      cy={clip.y}
                      r="7"
                      fill="#38bdf8"
                      stroke="#ffffff"
                      strokeWidth="2"
                      className="cursor-grab pointer-events-auto"
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        beginShapeGesture(e, clip, "arrow-start")
                      }}
                      onPointerMove={moveShapeGesture}
                      onPointerUp={finishShapeGesture}
                      onPointerCancel={finishShapeGesture}
                    />
                    <circle
                      cx={clip.endX ?? clip.x + clip.width}
                      cy={clip.endY ?? clip.y + clip.height}
                      r="7"
                      fill="#e879f9"
                      stroke="#ffffff"
                      strokeWidth="2"
                      className="cursor-grab pointer-events-auto"
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        beginShapeGesture(e, clip, "arrow-end")
                      }}
                      onPointerMove={moveShapeGesture}
                      onPointerUp={finishShapeGesture}
                      onPointerCancel={finishShapeGesture}
                    />
                  </>
                )}
              </g>
            )}
          </g>
        )
      })}

      {/* Live Drawing Preview Ghost */}
      {drawState && (
        <rect
          x={Math.min(drawState.startX, drawState.currentX)}
          y={Math.min(drawState.startY, drawState.currentY)}
          width={Math.abs(drawState.currentX - drawState.startX)}
          height={Math.abs(drawState.currentY - drawState.startY)}
          stroke={drawColor}
          strokeWidth="3"
          strokeDasharray="6 6"
          fill={`${drawColor}25`}
        />
      )}
    </svg>
  )
}
