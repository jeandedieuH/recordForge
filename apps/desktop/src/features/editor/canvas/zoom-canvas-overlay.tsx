import { useCallback, useRef, useState } from "react"
import type { ManualZoomSegment, ZoomMode, ZoomTarget } from "@recordforge/contracts"
import { clampZoomTarget, zoomTargetForCursorPoint } from "@recordforge/cursor-core"
import { Button, cn } from "@recordforge/ui"
import {
  Crosshair,
  Lock,
  MousePointer,
  Move,
  Unlock,
  ZoomIn,
} from "lucide-react"

export interface ZoomCanvasOverlayProps {
  segment: ManualZoomSegment | null
  canvasWidth: number
  canvasHeight: number
  containerWidth: number
  containerHeight: number
  offsetX?: number
  offsetY?: number
  cursorPointAtPlayhead?: { x: number; y: number } | null
  onUpdateTarget?: (
    target: Partial<ZoomTarget>,
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
  onUpdateSegment?: (
    update: Partial<ManualZoomSegment>,
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
}

type HandleType =
  | "move"
  | "top-left"
  | "top"
  | "top-right"
  | "right"
  | "bottom-right"
  | "bottom"
  | "bottom-left"
  | "left"

interface DragState {
  pointerId: number
  handle: HandleType
  startX: number
  startY: number
  initialTarget: ZoomTarget
  moved: boolean
}

export function ZoomCanvasOverlay({
  segment,
  canvasWidth,
  canvasHeight,
  containerWidth,
  containerHeight,
  offsetX = 0,
  offsetY = 0,
  cursorPointAtPlayhead,
  onUpdateTarget,
  onUpdateSegment,
}: ZoomCanvasOverlayProps) {
  const [isInteracting, setIsInteracting] = useState(false)
  const dragStateRef = useRef<DragState | null>(null)

  const scaleX = containerWidth / Math.max(1, canvasWidth)
  const scaleY = containerHeight / Math.max(1, canvasHeight)

  const handlePointerDown = useCallback(
    (event: React.PointerEvent, handle: HandleType) => {
      if (!segment || segment.locked || event.button !== 0) return
      event.stopPropagation()
      event.preventDefault()

      const element = event.currentTarget as HTMLElement
      element.setPointerCapture(event.pointerId)

      dragStateRef.current = {
        pointerId: event.pointerId,
        handle,
        startX: event.clientX,
        startY: event.clientY,
        initialTarget: { ...segment.target },
        moved: false,
      }
      setIsInteracting(true)
    },
    [segment],
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      const state = dragStateRef.current
      if (!state || state.pointerId !== event.pointerId || !segment || !onUpdateTarget) return

      const deltaScreenX = event.clientX - state.startX
      const deltaScreenY = event.clientY - state.startY

      if (Math.abs(deltaScreenX) < 2 && Math.abs(deltaScreenY) < 2 && !state.moved) {
        return
      }

      state.moved = true
      event.preventDefault()

      const deltaCanvasX = deltaScreenX / Math.max(0.001, scaleX)
      const deltaCanvasY = deltaScreenY / Math.max(0.001, scaleY)

      const initial = state.initialTarget
      const canvasAspect = canvasWidth / Math.max(1, canvasHeight)

      let nextTarget: ZoomTarget = { ...initial }

      if (state.handle === "move") {
        nextTarget.x = initial.x + deltaCanvasX
        nextTarget.y = initial.y + deltaCanvasY
      } else {
        // Resize handling with aspect-ratio preservation
        let newWidth = initial.width
        let newHeight = initial.height
        let newX = initial.x
        let newY = initial.y

        if (state.handle === "right" || state.handle === "top-right" || state.handle === "bottom-right") {
          newWidth = Math.max(100, initial.width + deltaCanvasX)
        } else if (state.handle === "left" || state.handle === "top-left" || state.handle === "bottom-left") {
          const clampedDelta = Math.min(deltaCanvasX, initial.width - 100)
          newWidth = initial.width - clampedDelta
          newX = initial.x + clampedDelta
        }

        // Lock aspect ratio
        newHeight = newWidth / canvasAspect

        if (state.handle === "top-left" || state.handle === "top-right" || state.handle === "top") {
          newY = initial.y + (initial.height - newHeight)
        }

        nextTarget = {
          x: newX,
          y: newY,
          width: newWidth,
          height: newHeight,
        }
      }

      const clamped = clampZoomTarget(nextTarget, { width: canvasWidth, height: canvasHeight, padding: 0 })
      onUpdateTarget(clamped, { phase: "draft" })
    },
    [canvasHeight, canvasWidth, onUpdateTarget, scaleX, scaleY, segment],
  )

  const handlePointerUp = useCallback(
    (event: React.PointerEvent) => {
      const state = dragStateRef.current
      if (!state || state.pointerId !== event.pointerId) return

      const didMove = state.moved
      dragStateRef.current = null
      setIsInteracting(false)

      const element = event.currentTarget as HTMLElement
      if (element.hasPointerCapture(event.pointerId)) {
        element.releasePointerCapture(event.pointerId)
      }

      if (didMove && segment && onUpdateTarget) {
        onUpdateTarget(segment.target, { phase: "commit" })
      }
    },
    [onUpdateTarget, segment],
  )

  if (!segment || !segment.enabled) return null

  // Convert target to screen coordinates
  const frameLeft = offsetX + segment.target.x * scaleX
  const frameTop = offsetY + segment.target.y * scaleY
  const frameWidth = segment.target.width * scaleX
  const frameHeight = segment.target.height * scaleY

  const currentScale = (canvasWidth / Math.max(1, segment.target.width)).toFixed(1)

  function applyScalePreset(targetScale: number) {
    if (!segment) return
    const centerX = segment.target.x + segment.target.width / 2
    const centerY = segment.target.y + segment.target.height / 2
    const next = zoomTargetForCursorPoint(
      { x: centerX, y: centerY },
      { width: canvasWidth, height: canvasHeight, padding: 0 },
      targetScale,
    )
    if (onUpdateSegment) {
      onUpdateSegment({ target: next, scale: targetScale }, { phase: "commit" })
    } else if (onUpdateTarget) {
      onUpdateTarget(next, { phase: "commit" })
    }
  }

  function centerTarget() {
    if (!segment) return
    const targetScale = Math.max(1.1, canvasWidth / Math.max(1, segment.target.width))
    const next = zoomTargetForCursorPoint(
      { x: canvasWidth / 2, y: canvasHeight / 2 },
      { width: canvasWidth, height: canvasHeight, padding: 0 },
      targetScale,
    )
    if (onUpdateSegment) {
      onUpdateSegment({ target: next, scale: targetScale }, { phase: "commit" })
    } else if (onUpdateTarget) {
      onUpdateTarget(next, { phase: "commit" })
    }
  }

  function snapToCursor() {
    if (!segment || !cursorPointAtPlayhead) return
    const targetScale = Math.max(1.1, canvasWidth / Math.max(1, segment.target.width))
    const next = zoomTargetForCursorPoint(
      cursorPointAtPlayhead,
      { width: canvasWidth, height: canvasHeight, padding: 0 },
      targetScale,
    )
    if (onUpdateSegment) {
      onUpdateSegment({ target: next, scale: targetScale }, { phase: "commit" })
    } else if (onUpdateTarget) {
      onUpdateTarget(next, { phase: "commit" })
    }
  }

  function toggleMode() {
    if (!segment || !onUpdateSegment) return
    const nextMode: ZoomMode = segment.mode === "follow-cursor" ? "static" : "follow-cursor"
    onUpdateSegment({ mode: nextMode }, { phase: "commit" })
  }

  function toggleLock() {
    if (!segment || !onUpdateSegment) return
    onUpdateSegment({ locked: !segment.locked }, { phase: "commit" })
  }

  const handleBaseClass =
    "absolute size-3 rounded-full border-2 border-primary bg-background shadow-md transition-transform hover:scale-125 focus-visible:scale-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary z-30"

  return (
    <div
      className="pointer-events-auto absolute inset-0 z-20 select-none overflow-visible"
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {/* Zoom Focus Frame */}
      <div
        className={cn(
          "absolute rounded-lg border-2 border-primary shadow-[0_0_0_1px_rgba(255,255,255,0.2),0_8px_24px_rgba(0,0,0,0.6)] transition-all",
          isInteracting ? "ring-4 ring-primary/30" : "hover:border-primary",
          segment.locked && "border-subtle/70 opacity-70",
        )}
        style={{
          left: `${frameLeft}px`,
          top: `${frameTop}px`,
          width: `${frameWidth}px`,
          height: `${frameHeight}px`,
        }}
      >
        {/* Rule of Thirds Guides */}
        <div
          className={cn(
            "pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3 transition-opacity duration-200",
            isInteracting ? "opacity-40" : "opacity-15 hover:opacity-30",
          )}
        >
          <div className="border-b border-r border-dashed border-primary" />
          <div className="border-b border-r border-dashed border-primary" />
          <div className="border-b border-dashed border-primary" />
          <div className="border-b border-r border-dashed border-primary" />
          <div className="border-b border-r border-dashed border-primary" />
          <div className="border-b border-dashed border-primary" />
          <div className="border-r border-dashed border-primary" />
          <div className="border-r border-dashed border-primary" />
          <div />
        </div>

        {/* Center Drag Anchor */}
        {!segment.locked && (
          <button
            type="button"
            className="group absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center rounded-full border border-primary/40 bg-background/85 p-1.5 text-primary shadow-sm backdrop-blur transition-all active:cursor-grabbing hover:scale-110 hover:border-primary hover:bg-background"
            onPointerDown={(e) => handlePointerDown(e, "move")}
            title="Pan zoom focus area"
            aria-label="Pan zoom target"
          >
            <Move className="size-3.5" aria-hidden />
          </button>
        )}

        {/* Resize Handles */}
        {!segment.locked && (
          <>
            {/* Corners */}
            <button
              type="button"
              className={cn(handleBaseClass, "-left-1.5 -top-1.5 cursor-nwse-resize")}
              onPointerDown={(e) => handlePointerDown(e, "top-left")}
              aria-label="Resize top-left"
            />
            <button
              type="button"
              className={cn(handleBaseClass, "-right-1.5 -top-1.5 cursor-nesw-resize")}
              onPointerDown={(e) => handlePointerDown(e, "top-right")}
              aria-label="Resize top-right"
            />
            <button
              type="button"
              className={cn(handleBaseClass, "-bottom-1.5 -left-1.5 cursor-nesw-resize")}
              onPointerDown={(e) => handlePointerDown(e, "bottom-left")}
              aria-label="Resize bottom-left"
            />
            <button
              type="button"
              className={cn(handleBaseClass, "-bottom-1.5 -right-1.5 cursor-nwse-resize")}
              onPointerDown={(e) => handlePointerDown(e, "bottom-right")}
              aria-label="Resize bottom-right"
            />

            {/* Edges */}
            <button
              type="button"
              className={cn(handleBaseClass, "-top-1.5 left-1/2 -translate-x-1/2 cursor-ns-resize")}
              onPointerDown={(e) => handlePointerDown(e, "top")}
              aria-label="Resize top"
            />
            <button
              type="button"
              className={cn(handleBaseClass, "-bottom-1.5 left-1/2 -translate-x-1/2 cursor-ns-resize")}
              onPointerDown={(e) => handlePointerDown(e, "bottom")}
              aria-label="Resize bottom"
            />
            <button
              type="button"
              className={cn(handleBaseClass, "-left-1.5 top-1/2 -translate-y-1/2 cursor-ew-resize")}
              onPointerDown={(e) => handlePointerDown(e, "left")}
              aria-label="Resize left"
            />
            <button
              type="button"
              className={cn(handleBaseClass, "-right-1.5 top-1/2 -translate-y-1/2 cursor-ew-resize")}
              onPointerDown={(e) => handlePointerDown(e, "right")}
              aria-label="Resize right"
            />
          </>
        )}

        {/* Floating Contextual Quick HUD */}
        <div
          className={cn(
            "absolute left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-full border border-border bg-background/95 px-2 py-1 shadow-lg backdrop-blur text-[11px] z-40 transition-opacity whitespace-nowrap",
            frameTop > 45 ? "-top-10" : "-bottom-10",
          )}
        >
          <div className="flex items-center gap-1 border-r border-border pr-1.5 text-foreground font-semibold">
            <ZoomIn className="size-3 text-primary" aria-hidden />
            <span>{currentScale}×</span>
          </div>

          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[10px]"
              onClick={() => applyScalePreset(1.25)}
              disabled={segment.locked}
            >
              1.25×
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[10px]"
              onClick={() => applyScalePreset(1.5)}
              disabled={segment.locked}
            >
              1.5×
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[10px]"
              onClick={() => applyScalePreset(2.0)}
              disabled={segment.locked}
            >
              2.0×
            </Button>
          </div>

          <div className="flex items-center gap-0.5 border-l border-border pl-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[10px]"
              onClick={centerTarget}
              title="Center focus frame on canvas"
              disabled={segment.locked}
            >
              <Crosshair className="size-3" aria-hidden />
            </Button>

            {cursorPointAtPlayhead && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[10px]"
                onClick={snapToCursor}
                title="Snap focus frame to cursor position"
                disabled={segment.locked}
              >
                <MousePointer className="size-3" aria-hidden />
              </Button>
            )}

            <Button
              variant={segment.mode === "follow-cursor" ? "secondary" : "ghost"}
              size="sm"
              className="h-6 px-1.5 text-[10px]"
              onClick={toggleMode}
              title={segment.mode === "follow-cursor" ? "Mode: Follow Cursor" : "Mode: Static Area"}
              disabled={segment.locked}
            >
              {segment.mode === "follow-cursor" ? "Follow" : "Static"}
            </Button>

            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[10px]"
              onClick={toggleLock}
              title={segment.locked ? "Unlock zoom segment" : "Lock zoom segment"}
            >
              {segment.locked ? <Lock className="size-3" aria-hidden /> : <Unlock className="size-3 text-subtle-foreground" aria-hidden />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
