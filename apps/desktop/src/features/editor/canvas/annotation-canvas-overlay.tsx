import { useRef, useState } from "react"
import type { AnnotationClip, AnnotationType } from "@recordforge/contracts"
import { createAnnotationClip } from "@recordforge/editor-core"
import type { OverlayHandle } from "@recordforge/editor-core"
import { wrapTextToLines } from "@recordforge/overlay-core"
import type { OverlayInteraction } from "./use-overlay-interaction"
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
  interaction: OverlayInteraction
  onSelectClip?: (clip: AnnotationClip) => void
  onCreateClip?: (clip: AnnotationClip) => void
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
  interaction,
  onSelectClip,
  onCreateClip,
}: AnnotationCanvasOverlayProps) {
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
    event: React.PointerEvent<Element>,
    clip: AnnotationClip,
    handle: OverlayHandle,
  ) {
    if (drawMode) return
    interaction.beginGesture(event, clip, handle)
  }

  function moveShapeGesture(event: React.PointerEvent<Element>) {
    interaction.moveGesture(event)
  }

  function finishShapeGesture(event: React.PointerEvent<Element>) {
    interaction.finishGesture(event)
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
            onPointerDown={(e) => beginShapeGesture(e, clip, "body")}
            tabIndex={0}
            role="button"
            aria-label={`${clip.annotationType} annotation`}
            onFocus={() => onSelectClip?.(clip)}
            onPointerMove={moveShapeGesture}
            onPointerUp={finishShapeGesture}
            onPointerCancel={finishShapeGesture}
            onLostPointerCapture={interaction.handleLostPointerCapture}
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
                  transform={`rotate(${clip.rotation} ${clip.x + clip.width * clip.anchorX} ${clip.y + clip.height * clip.anchorY})`}
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

            <g
              transform={`rotate(${clip.rotation} ${clip.x + clip.width * clip.anchorX} ${clip.y + clip.height * clip.anchorY})`}
            >
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
                  {clip.text
                    ? (() => {
                        const fontSize = clip.fontSize ?? 16
                        const maxLineWidth = Math.max(20, clip.width - fontSize * 1.5)
                        const lines = wrapTextToLines(
                          clip.text,
                          maxLineWidth,
                          (str) => str.length * fontSize * 0.58,
                        )
                        const lineHeight = fontSize * 1.25
                        const totalHeight = (lines.length - 1) * lineHeight
                        const startY = clip.y + clip.height / 2 + fontSize * 0.35 - totalHeight / 2
                        return (
                          <text
                            x={clip.x + clip.width / 2}
                            y={startY}
                            textAnchor="middle"
                            fill={clip.textColor ?? "#ffffff"}
                            fontSize={fontSize}
                            fontWeight="bold"
                            fontFamily="sans-serif"
                          >
                            {lines.map((line, idx) => (
                              <tspan
                                key={idx}
                                x={clip.x + clip.width / 2}
                                dy={idx === 0 ? 0 : lineHeight}
                              >
                                {line}
                              </tspan>
                            ))}
                          </text>
                        )
                      })()
                    : null}
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
                  {clip.text
                    ? (() => {
                        const fontSize = clip.fontSize ?? 14
                        const maxLineWidth = Math.max(20, clip.width - 24)
                        const lines = wrapTextToLines(
                          clip.text,
                          maxLineWidth,
                          (str) => str.length * fontSize * 0.58,
                        )
                        const lineHeight = fontSize * 1.25
                        const totalHeight = (lines.length - 1) * lineHeight
                        const startY = clip.y + clip.height / 2 + 5 - totalHeight / 2
                        return (
                          <text
                            x={clip.x + clip.width / 2}
                            y={startY}
                            textAnchor="middle"
                            fill={clip.textColor ?? "#ffffff"}
                            fontSize={fontSize}
                            fontWeight="bold"
                            letterSpacing="1px"
                            fontFamily="sans-serif"
                          >
                            {lines.map((line, idx) => (
                              <tspan
                                key={idx}
                                x={clip.x + clip.width / 2}
                                dy={idx === 0 ? 0 : lineHeight}
                              >
                                {line}
                              </tspan>
                            ))}
                          </text>
                        )
                      })()
                    : null}
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
                    className="fill-none stroke-primary"
                    strokeWidth={2}
                    strokeDasharray="4 4"
                    pointerEvents="none"
                  />
                  {/* Resize Handle SE */}
                  {/* Resize Handle NW */}
                  {[
                    {
                      handle: "nw" as const,
                      x: clip.x - 6,
                      y: clip.y - 6,
                      cursor: "cursor-nwse-resize",
                      label: "Resize annotation northwest",
                    },
                    {
                      handle: "n" as const,
                      x: clip.x + clip.width / 2 - 6,
                      y: clip.y - 6,
                      cursor: "cursor-n-resize",
                      label: "Resize annotation north",
                    },
                    {
                      handle: "ne" as const,
                      x: clip.x + clip.width - 6,
                      y: clip.y - 6,
                      cursor: "cursor-nesw-resize",
                      label: "Resize annotation northeast",
                    },
                    {
                      handle: "e" as const,
                      x: clip.x + clip.width - 6,
                      y: clip.y + clip.height / 2 - 6,
                      cursor: "cursor-ew-resize",
                      label: "Resize annotation east",
                    },
                    {
                      handle: "se" as const,
                      x: clip.x + clip.width - 6,
                      y: clip.y + clip.height - 6,
                      cursor: "cursor-nwse-resize",
                      label: "Resize annotation southeast",
                    },
                    {
                      handle: "s" as const,
                      x: clip.x + clip.width / 2 - 6,
                      y: clip.y + clip.height - 6,
                      cursor: "cursor-s-resize",
                      label: "Resize annotation south",
                    },
                    {
                      handle: "sw" as const,
                      x: clip.x - 6,
                      y: clip.y + clip.height - 6,
                      cursor: "cursor-nesw-resize",
                      label: "Resize annotation southwest",
                    },
                    {
                      handle: "w" as const,
                      x: clip.x - 6,
                      y: clip.y + clip.height / 2 - 6,
                      cursor: "cursor-ew-resize",
                      label: "Resize annotation west",
                    },
                  ].map(({ handle, x, y, cursor, label }) => (
                    <rect
                      key={handle}
                      x={x}
                      y={y}
                      width={12}
                      height={12}
                      rx={2}
                      className={cn(
                        "pointer-events-auto fill-primary stroke-background focus-visible:outline-none",
                        cursor,
                      )}
                      strokeWidth={2}
                      role="button"
                      tabIndex={0}
                      aria-label={label}
                      onPointerDown={(event) => {
                        event.stopPropagation()
                        beginShapeGesture(event, clip, handle)
                      }}
                      onPointerMove={moveShapeGesture}
                      onPointerUp={finishShapeGesture}
                      onPointerCancel={finishShapeGesture}
                      onLostPointerCapture={interaction.handleLostPointerCapture}
                    />
                  ))}
                  {clip.annotationType !== "arrow" && clip.annotationType !== "line" && (
                    <>
                      <line
                        x1={clip.x + clip.width / 2}
                        y1={clip.y}
                        x2={clip.x + clip.width / 2}
                        y2={clip.y - 24}
                        className="pointer-events-none stroke-primary"
                        strokeWidth={2}
                      />
                      <circle
                        cx={clip.x + clip.width / 2}
                        cy={clip.y - 30}
                        r={7}
                        className="pointer-events-auto fill-primary stroke-background focus-visible:outline-none cursor-grab"
                        strokeWidth={2}
                        role="button"
                        tabIndex={0}
                        aria-label="Rotate annotation"
                        onPointerDown={(event) => {
                          event.stopPropagation()
                          beginShapeGesture(event, clip, "rotate")
                        }}
                        onPointerMove={moveShapeGesture}
                        onPointerUp={finishShapeGesture}
                        onPointerCancel={finishShapeGesture}
                        onLostPointerCapture={interaction.handleLostPointerCapture}
                      />
                    </>
                  )}
                  {/* Arrow specific start/end handles */}
                  {(clip.annotationType === "arrow" || clip.annotationType === "line") && (
                    <>
                      <circle
                        cx={clip.x}
                        cy={clip.y}
                        r={7}
                        className="pointer-events-auto fill-primary stroke-background focus-visible:outline-none cursor-grab"
                        strokeWidth={2}
                        role="button"
                        tabIndex={0}
                        aria-label="Move annotation start point"
                        onPointerDown={(event) => {
                          event.stopPropagation()
                          beginShapeGesture(event, clip, "arrow-start")
                        }}
                        onPointerMove={moveShapeGesture}
                        onPointerUp={finishShapeGesture}
                        onPointerCancel={finishShapeGesture}
                        onLostPointerCapture={interaction.handleLostPointerCapture}
                      />
                      <circle
                        cx={clip.endX ?? clip.x + clip.width}
                        cy={clip.endY ?? clip.y + clip.height}
                        r={7}
                        className="pointer-events-auto fill-warning stroke-background focus-visible:outline-none cursor-grab"
                        strokeWidth={2}
                        role="button"
                        tabIndex={0}
                        aria-label="Move annotation end point"
                        onPointerDown={(event) => {
                          event.stopPropagation()
                          beginShapeGesture(event, clip, "arrow-end")
                        }}
                        onPointerMove={moveShapeGesture}
                        onPointerUp={finishShapeGesture}
                        onPointerCancel={finishShapeGesture}
                        onLostPointerCapture={interaction.handleLostPointerCapture}
                      />
                    </>
                  )}
                </g>
              )}
            </g>
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
