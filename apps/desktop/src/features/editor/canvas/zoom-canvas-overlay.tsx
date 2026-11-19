import { useCallback, useRef, useState } from "react"
import type { LoupeSettings, ManualZoomSegment, ZoomTarget } from "@recordforge/contracts"
import {
  canonicalizeZoomTarget,
  clampZoomTarget,
  zoomTargetForCursorPoint,
} from "@recordforge/cursor-core"
import { Badge, Button, IconButton, ToggleGroup, ToggleGroupItem, cn } from "@recordforge/ui"
import { Crosshair, Lock, MousePointer, Move, Unlock, ZoomIn } from "lucide-react"
import {
  loupeOffsetAfterDrag,
  loupeSizeAfterResize,
  resolveLoupeSettings,
  zoomPointToScreenRect,
  type CanvasRect,
} from "@recordforge/editor-core"

/**
 * Segment patch shape: `loupe` is a partial so a drag can patch one lens field
 * without restating the whole settings object.
 */
type SegmentUpdate = Partial<Omit<ManualZoomSegment, "loupe">> & {
  loupe?: Partial<LoupeSettings>
}

export interface ZoomCanvasOverlayProps {
  segment: ManualZoomSegment | null
  canvasWidth: number
  canvasHeight: number
  containerWidth: number
  containerHeight: number
  offsetX?: number
  offsetY?: number
  /** Uniform CSS-px-per-canvas-px ratio used by canvas-space handles (loupe). */
  canvasScale?: number
  /** Fitted screen video rect on the canvas, in canvas pixels. */
  screenRect?: CanvasRect
  cursorPointAtPlayhead?: { x: number; y: number } | null
  /** Displayed cursor tip in canvas pixels (after any active frame zoom). */
  displayCursorPoint?: { x: number; y: number } | null
  /**
   * Framing mode: the screen renders unzoomed so the frame rect is accurate.
   * The overlay dims everything outside the frame to mark the crop.
   */
  dimOutsideFrame?: boolean
  onUpdateTarget?: (
    target: Partial<ZoomTarget>,
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
  onUpdateSegment?: (
    update: SegmentUpdate,
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
  currentTarget: ZoomTarget
  moved: boolean
}

const SCALE_CHIPS = [1.25, 1.5, 2]

export function ZoomCanvasOverlay({
  segment,
  canvasWidth,
  canvasHeight,
  containerWidth,
  containerHeight,
  offsetX = 0,
  offsetY = 0,
  canvasScale,
  screenRect,
  cursorPointAtPlayhead,
  displayCursorPoint,
  dimOutsideFrame = false,
  onUpdateTarget,
  onUpdateSegment,
}: ZoomCanvasOverlayProps) {
  const [isInteracting, setIsInteracting] = useState(false)
  const dragStateRef = useRef<DragState | null>(null)
  const normalizedTarget = segment
    ? canonicalizeZoomTarget(
        segment.target,
        { width: canvasWidth, height: canvasHeight, padding: 0 },
        segment.scale,
      )
    : null

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
        initialTarget: { ...(normalizedTarget ?? segment.target) },
        currentTarget: { ...(normalizedTarget ?? segment.target) },
        moved: false,
      }
      setIsInteracting(true)
    },
    [normalizedTarget, segment],
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
        let newX = initial.x
        let newY = initial.y

        if (
          state.handle === "right" ||
          state.handle === "top-right" ||
          state.handle === "bottom-right"
        ) {
          newWidth = Math.max(100, initial.width + deltaCanvasX)
        } else if (
          state.handle === "left" ||
          state.handle === "top-left" ||
          state.handle === "bottom-left"
        ) {
          const clampedDelta = Math.min(deltaCanvasX, initial.width - 100)
          newWidth = initial.width - clampedDelta
          newX = initial.x + clampedDelta
        } else if (state.handle === "bottom") {
          const minHeight = 100 / canvasAspect
          const nextHeight = Math.max(minHeight, initial.height + deltaCanvasY)
          newWidth = nextHeight * canvasAspect
          newX = initial.x + (initial.width - newWidth) / 2
        } else if (state.handle === "top") {
          const minHeight = 100 / canvasAspect
          const nextHeight = Math.max(minHeight, initial.height - deltaCanvasY)
          newWidth = nextHeight * canvasAspect
          newX = initial.x + (initial.width - newWidth) / 2
        }

        // Lock aspect ratio
        const newHeight = newWidth / canvasAspect

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

      const clamped = clampZoomTarget(nextTarget, {
        width: canvasWidth,
        height: canvasHeight,
        padding: 0,
      })
      state.currentTarget = clamped
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

      if (didMove && onUpdateTarget) {
        onUpdateTarget(state.currentTarget, { phase: "commit" })
      }
    },
    [onUpdateTarget],
  )

  if (!segment || !segment.enabled) return null

  // A Glass Loupe edits a lens, not a frame crop: the frame stays put, so the
  // frame-target chrome (dim, crop handles, HUD) would be lying. Drag the lens
  // itself instead.
  if (segment.style === "loupe") {
    const resolvedCanvasScale = Math.max(0.0001, canvasScale ?? scaleX)
    const resolvedScreenRect = screenRect ?? {
      x: offsetX / resolvedCanvasScale,
      y: offsetY / resolvedCanvasScale,
      width: containerWidth / resolvedCanvasScale,
      height: containerHeight / resolvedCanvasScale,
    }
    return (
      <LensHandle
        segment={segment}
        canvasWidth={canvasWidth}
        canvasHeight={canvasHeight}
        canvasScale={resolvedCanvasScale}
        screenRect={resolvedScreenRect}
        cursorPoint={cursorPointAtPlayhead}
        displayCursorPoint={displayCursorPoint}
        onUpdate={onUpdateSegment}
      />
    )
  }

  // Convert the canonical target to screen coordinates so the edit affordance
  // describes the same crop that preview and export actually render.
  const displayTarget = normalizedTarget ?? segment.target
  const frameLeft = offsetX + displayTarget.x * scaleX
  const frameTop = offsetY + displayTarget.y * scaleY
  const frameWidth = displayTarget.width * scaleX
  const frameHeight = displayTarget.height * scaleY

  const currentScale = (canvasWidth / Math.max(1, displayTarget.width)).toFixed(1)
  const isFollowMode = segment.mode === "follow-cursor"

  function applyScalePreset(targetScale: number) {
    if (!segment) return
    const centerX = displayTarget.x + displayTarget.width / 2
    const centerY = displayTarget.y + displayTarget.height / 2
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
    const targetScale = Math.max(1.1, canvasWidth / Math.max(1, displayTarget.width))
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
    const targetScale = Math.max(1.1, canvasWidth / Math.max(1, displayTarget.width))
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

  function setCameraMode(mode: "follow-cursor" | "static") {
    if (!segment || !onUpdateSegment || isFollowMode === (mode === "follow-cursor")) return
    onUpdateSegment({ mode }, { phase: "commit" })
  }

  function toggleLock() {
    if (!segment || !onUpdateSegment) return
    onUpdateSegment({ locked: !segment.locked }, { phase: "commit" })
  }

  const handleBaseClass =
    "absolute size-3 rounded-full border-2 border-primary bg-background shadow-md transition-transform hover:scale-125 focus-visible:scale-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary z-30 p-0"

  return (
    <div
      className="pointer-events-auto absolute inset-0 z-20 select-none overflow-visible"
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {/* Dim everything outside the frame while framing mode shows the
          unzoomed source — tokens only, four rects act as a mask hole. */}
      {dimOutsideFrame ? (
        <>
          <div
            className="pointer-events-none absolute inset-x-0 top-0 bg-background/70"
            style={{ height: frameTop }}
          />
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 bg-background/70"
            style={{ top: frameTop + frameHeight }}
          />
          <div
            className="pointer-events-none absolute left-0 bg-background/70"
            style={{ top: frameTop, width: frameLeft, height: frameHeight }}
          />
          <div
            className="pointer-events-none absolute right-0 bg-background/70"
            style={{ top: frameTop, height: frameHeight, left: frameLeft + frameWidth }}
          />
        </>
      ) : null}

      {/* Zoom Focus Frame — no transition-all here: it makes dragging laggy. */}
      <div
        className={cn(
          "absolute rounded-lg border-2 border-primary shadow-e2",
          isInteracting ? "ring-4 ring-primary/30" : "hover:border-primary",
          segment.locked && "border-border-strong opacity-70",
        )}
        style={{
          left: `${frameLeft}px`,
          top: `${frameTop}px`,
          width: `${frameWidth}px`,
          height: `${frameHeight}px`,
        }}
      >
        {/* In follow mode the camera tracks the cursor, so the frame only
            describes where tracking starts. */}
        {isFollowMode ? (
          <Badge
            variant="outline"
            className="pointer-events-none absolute left-2 top-2 z-40 bg-background/80 text-[9px] font-semibold"
          >
            Starting framing
          </Badge>
        ) : null}

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

        {/* Center Drag Anchor — a plain button: IconButton tooltips would fire
            while scrubbing, and drag handles only need an aria-label. */}
        {!segment.locked && (
          <button
            type="button"
            className="group absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center rounded-full border border-primary/40 bg-background/85 p-1.5 text-primary shadow-sm backdrop-blur transition-transform active:cursor-grabbing hover:scale-110 hover:border-primary hover:bg-background"
            onPointerDown={(e) => handlePointerDown(e, "move")}
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
              className={cn(
                handleBaseClass,
                "-bottom-1.5 left-1/2 -translate-x-1/2 cursor-ns-resize",
              )}
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
              className={cn(
                handleBaseClass,
                "-right-1.5 top-1/2 -translate-y-1/2 cursor-ew-resize",
              )}
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
            {SCALE_CHIPS.map((chipScale) => (
              <Button
                key={chipScale}
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[10px]"
                onClick={() => applyScalePreset(chipScale)}
                disabled={segment.locked}
              >
                {chipScale}×
              </Button>
            ))}
          </div>

          <div className="flex items-center gap-0.5 border-l border-border pl-1.5">
            <IconButton
              label="Center focus frame on canvas"
              variant="ghost"
              size="sm"
              className="size-6"
              onClick={centerTarget}
              disabled={segment.locked}
            >
              <Crosshair className="size-3" aria-hidden />
            </IconButton>

            {cursorPointAtPlayhead ? (
              <IconButton
                label="Snap focus frame to cursor position"
                variant="ghost"
                size="sm"
                className="size-6"
                onClick={snapToCursor}
                disabled={segment.locked}
              >
                <MousePointer className="size-3" aria-hidden />
              </IconButton>
            ) : null}

            <ToggleGroup
              type="single"
              aria-label="Camera mode"
              value={isFollowMode ? "follow-cursor" : "static"}
              disabled={segment.locked}
              onValueChange={(value) => {
                if (value === "follow-cursor" || value === "static") setCameraMode(value)
              }}
              className="flex rounded-md border border-border"
            >
              <ToggleGroupItem
                value="follow-cursor"
                className="h-6 px-1.5 text-[10px] data-[state=on]:bg-primary/15 data-[state=on]:text-primary"
              >
                Follow
              </ToggleGroupItem>
              <ToggleGroupItem
                value="static"
                className="h-6 px-1.5 text-[10px] data-[state=on]:bg-primary/15 data-[state=on]:text-primary"
              >
                Fixed
              </ToggleGroupItem>
            </ToggleGroup>

            <IconButton
              label={segment.locked ? "Unlock zoom segment" : "Lock zoom segment"}
              variant="ghost"
              size="sm"
              className="size-6"
              onClick={toggleLock}
            >
              {segment.locked ? (
                <Lock className="size-3" aria-hidden />
              ) : (
                <Unlock className="size-3 text-subtle-foreground" aria-hidden />
              )}
            </IconButton>
          </div>
        </div>
      </div>
    </div>
  )
}

interface LensHandleProps {
  segment: ManualZoomSegment
  canvasWidth: number
  canvasHeight: number
  canvasScale: number
  screenRect: CanvasRect
  /** Cursor tip in zoom space — fallback when `displayCursorPoint` is absent. */
  cursorPoint?: { x: number; y: number } | null
  /** Displayed cursor tip in canvas coords (after any active frame zoom). */
  displayCursorPoint?: { x: number; y: number } | null
  onUpdate?: ZoomCanvasOverlayProps["onUpdateSegment"]
}

interface LensGesture {
  pointerId: number
  mode: "move" | "resize"
  startX: number
  startY: number
  /** `loupe.offset` when the drag began; the move gesture accumulates on it. */
  offsetX: number
  offsetY: number
  sizePx: number
  moved: boolean
  last: SegmentUpdate
}

/**
 * Direct manipulation for a Glass Loupe: the lens always rides the cursor, so
 * dragging the lens writes a nudge onto `loupe.offset` (the pose's centre is
 * cursor point plus offset) and dragging its corner handle resizes it
 * (`loupe.size`). Positioned in uniform canvas space (`canvasScale`) so the
 * handle aligns 1:1 with `LoupeOverlay` on 9:16, padded, and split canvases.
 */
function LensHandle({
  segment,
  canvasWidth,
  canvasHeight,
  canvasScale,
  screenRect,
  cursorPoint,
  displayCursorPoint,
  onUpdate,
}: LensHandleProps) {
  const gestureRef = useRef<LensGesture | null>(null)
  const settings = resolveLoupeSettings(segment.loupe)
  const shortEdge = Math.max(1, Math.min(canvasWidth, canvasHeight))
  const surfaceScale = { x: canvasScale, y: canvasScale }
  const diameter = settings.size * shortEdge
  const radius = diameter / 2
  const canvasSize = { width: canvasWidth, height: canvasHeight }
  // Same fallback chain `resolveLoupeAt` applies in canvas pixels: displayed
  // cursor tip, then unzoomed cursor mapped to screenRect, then parked
  // `loupe.center`, then the canonical target centre mapped to screenRect.
  const base =
    displayCursorPoint ??
    (cursorPoint ? zoomPointToScreenRect(cursorPoint, canvasSize, screenRect) : null) ??
    settings.center ??
    zoomPointToScreenRect(
      {
        x: segment.target.x + segment.target.width / 2,
        y: segment.target.y + segment.target.height / 2,
      },
      canvasSize,
      screenRect,
    )
  const centreX = Math.min(
    Math.max(radius, canvasWidth - radius),
    Math.max(radius, base.x + (settings.offset?.x ?? 0)),
  )
  const centreY = Math.min(
    Math.max(radius, canvasHeight - radius),
    Math.max(radius, base.y + (settings.offset?.y ?? 0)),
  )
  const sizePx = Math.max(24, diameter * canvasScale)
  const left = centreX * canvasScale - sizePx / 2
  const top = centreY * canvasScale - sizePx / 2
  const borderRadiusPx =
    settings.shape === "circle" ? sizePx / 2 : (settings.cornerRadius * sizePx) / 2
  const locked = Boolean(segment.locked)

  function begin(event: React.PointerEvent<HTMLElement>, mode: "move" | "resize") {
    if (locked || !onUpdate || event.button !== 0) return
    event.stopPropagation()
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureRef.current = {
      pointerId: event.pointerId,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: settings.offset?.x ?? 0,
      offsetY: settings.offset?.y ?? 0,
      sizePx,
      moved: false,
      last: {},
    }
  }

  function move(event: React.PointerEvent<HTMLElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId || !onUpdate) return
    const dx = event.clientX - gesture.startX
    const dy = event.clientY - gesture.startY
    if (!gesture.moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return
    gesture.moved = true
    event.preventDefault()
    const update: SegmentUpdate =
      gesture.mode === "move"
        ? {
            loupe: {
              offset: loupeOffsetAfterDrag(
                { x: gesture.offsetX, y: gesture.offsetY },
                { x: dx, y: dy },
                surfaceScale,
              ),
            },
          }
        : {
            loupe: {
              size: loupeSizeAfterResize(gesture.sizePx, dx, surfaceScale.x, shortEdge),
            },
          }
    gesture.last = update
    onUpdate(update, { phase: "draft" })
  }

  function finish(event: React.PointerEvent<HTMLElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    gestureRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!onUpdate) return
    if (event.type === "pointercancel" || !gesture.moved) {
      // Nothing moved: restore the offset/size the lens had before the drag.
      onUpdate(
        gesture.mode === "move"
          ? { loupe: { offset: { x: gesture.offsetX, y: gesture.offsetY } } }
          : { loupe: { size: loupeSizeAfterResize(gesture.sizePx, 0, surfaceScale.x, shortEdge) } },
        { phase: "cancel" },
      )
      return
    }
    onUpdate(gesture.last, { phase: "commit" })
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-40">
      <div
        role="presentation"
        aria-label="Glass Loupe lens"
        className={cn(
          "absolute border-2 border-dashed border-primary/80 bg-primary/5",
          locked ? "cursor-default" : "cursor-move",
        )}
        style={{
          left: `${left}px`,
          top: `${top}px`,
          width: `${sizePx}px`,
          height: `${sizePx}px`,
          borderRadius: `${borderRadiusPx}px`,
          pointerEvents: locked ? "none" : "auto",
          touchAction: "none",
        }}
        onPointerDown={(event) => begin(event, "move")}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={finish}
      >
        <span className="pointer-events-none absolute left-1/2 top-1 -translate-x-1/2 rounded bg-primary px-1 font-mono text-[9px] font-semibold uppercase tracking-wider text-primary-foreground">
          loupe
        </span>
        {locked ? null : (
          <span
            role="presentation"
            aria-label="Resize Glass Loupe"
            className="absolute -bottom-1.5 -right-1.5 size-3 cursor-nwse-resize rounded-sm border border-primary bg-primary"
            style={{ touchAction: "none" }}
            onPointerDown={(event) => begin(event, "resize")}
            onPointerMove={move}
            onPointerUp={finish}
            onPointerCancel={finish}
          />
        )}
      </div>
    </div>
  )
}
