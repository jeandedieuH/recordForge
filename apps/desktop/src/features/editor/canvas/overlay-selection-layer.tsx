import type { OverlayClip, OverlayHandle, OverlayResizeHandle } from "@recordforge/editor-core"
import { createDeleteClipCommand } from "@recordforge/editor-core"
import { cn } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"
import { usePlayheadMs } from "../timeline/use-playback-state"
import type { OverlayInteraction } from "./use-overlay-interaction"

interface OverlaySelectionLayerProps {
  clips: OverlayClip[]
  canvasWidth: number
  canvasHeight: number
  selectedClipId?: string | null
  interaction: OverlayInteraction
  onSelectClip: (clip: OverlayClip) => void
  onDeleteClip?: (clip: OverlayClip) => void
  drawMode?: boolean
  className?: string
}

const RESIZE_HANDLES: Array<{
  handle: OverlayResizeHandle
  left: string
  top: string
  cursor: string
  label: string
}> = [
  { handle: "nw", left: "0%", top: "0%", cursor: "cursor-nwse-resize", label: "Resize northwest" },
  { handle: "n", left: "50%", top: "0%", cursor: "cursor-n-resize", label: "Resize north" },
  {
    handle: "ne",
    left: "100%",
    top: "0%",
    cursor: "cursor-nesw-resize",
    label: "Resize northeast",
  },
  { handle: "e", left: "100%", top: "50%", cursor: "cursor-ew-resize", label: "Resize east" },
  {
    handle: "se",
    left: "100%",
    top: "100%",
    cursor: "cursor-nwse-resize",
    label: "Resize southeast",
  },
  { handle: "s", left: "50%", top: "100%", cursor: "cursor-s-resize", label: "Resize south" },
  {
    handle: "sw",
    left: "0%",
    top: "100%",
    cursor: "cursor-nesw-resize",
    label: "Resize southwest",
  },
  { handle: "w", left: "0%", top: "50%", cursor: "cursor-ew-resize", label: "Resize west" },
]

function isActive(clip: OverlayClip, playheadMs: number): boolean {
  return (
    clip.enabled !== false &&
    playheadMs >= clip.startMs &&
    playheadMs < clip.startMs + clip.durationMs
  )
}

interface OverlayRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Lines store their start in `x`/`y` and may point up or left, so the drawn
 * endpoints only span a positive rect after normalizing. The selection box and
 * its hit area must cover the real line, not the quadrant right/below it.
 */
function overlayDisplayRect(clip: OverlayClip): OverlayRect {
  if (
    clip.kind === "annotation" &&
    (clip.annotationType === "arrow" || clip.annotationType === "line")
  ) {
    const endX = clip.endX ?? clip.x + clip.width
    const endY = clip.endY ?? clip.y + clip.height
    return {
      x: Math.min(clip.x, endX),
      y: Math.min(clip.y, endY),
      width: Math.max(1, Math.abs(endX - clip.x)),
      height: Math.max(1, Math.abs(endY - clip.y)),
    }
  }
  return { x: clip.x, y: clip.y, width: clip.width, height: clip.height }
}

export function OverlaySelectionLayer({
  clips,
  canvasWidth,
  canvasHeight,
  selectedClipId,
  interaction,
  onSelectClip,
  onDeleteClip,
  drawMode = false,
  className,
}: OverlaySelectionLayerProps) {
  const playheadMs = usePlayheadMs()
  const execute = useTimelineStore((state) => state.execute)
  const visibleClips = clips
    .filter((clip) => isActive(clip, playheadMs))
    .slice()
    .sort((left, right) => effectiveZIndex(left) - effectiveZIndex(right))

  function handleClipKeyDown(event: React.KeyboardEvent<HTMLDivElement>, clip: OverlayClip) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      onSelectClip(clip)
      return
    }

    if (event.key === "Escape") {
      event.preventDefault()
      interaction.cancel()
      return
    }

    if (clip.locked) return

    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault()
      if (onDeleteClip) {
        onDeleteClip(clip)
      } else {
        execute(createDeleteClipCommand(clip.id))
      }
      return
    }

    if (event.key === "r" || event.key === "R") {
      event.preventDefault()
      const delta = event.shiftKey ? -15 : 15
      interaction.rotateSelected(clip.id, delta)
      return
    }

    const step = event.shiftKey ? 10 : 1
    const isModifier = event.ctrlKey || event.metaKey
    const isLine =
      clip.kind === "annotation" &&
      (clip.annotationType === "arrow" || clip.annotationType === "line")
    // Line endpoints are edited with their handles; a box resize has no visual
    // effect on a connector, so do not create a misleading history entry.
    if (isLine && isModifier) return

    if (event.key === "ArrowLeft") {
      event.preventDefault()
      if (isModifier) {
        interaction.resizeSelected(clip.id, -step, 0)
      } else {
        interaction.nudgeSelected(clip.id, -step, 0)
      }
    } else if (event.key === "ArrowRight") {
      event.preventDefault()
      if (isModifier) {
        interaction.resizeSelected(clip.id, step, 0)
      } else {
        interaction.nudgeSelected(clip.id, step, 0)
      }
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      if (isModifier) {
        interaction.resizeSelected(clip.id, 0, -step)
      } else {
        interaction.nudgeSelected(clip.id, 0, -step)
      }
    } else if (event.key === "ArrowDown") {
      event.preventDefault()
      if (isModifier) {
        interaction.resizeSelected(clip.id, 0, step)
      } else {
        interaction.nudgeSelected(clip.id, 0, step)
      }
    }
  }

  return (
    <div
      className={cn("pointer-events-none absolute inset-0 overflow-visible", className)}
      aria-label="Overlay selection layer"
    >
      {drawMode
        ? null
        : visibleClips.map((clip) => {
            const isSelected = selectedClipId === clip.id
            const rect = overlayDisplayRect(clip)
            const leftPercent = (rect.x / Math.max(1, canvasWidth)) * 100
            const topPercent = (rect.y / Math.max(1, canvasHeight)) * 100
            const widthPercent = (rect.width / Math.max(1, canvasWidth)) * 100
            const heightPercent = (rect.height / Math.max(1, canvasHeight)) * 100
            // The normalized line rect differs from the stored start-relative
            // box, so derive the anchor from the real clip, not the rect.
            const originXPercent =
              ((clip.x + clip.width * clip.anchorX - rect.x) / Math.max(1, rect.width)) * 100
            const originYPercent =
              ((clip.y + clip.height * clip.anchorY - rect.y) / Math.max(1, rect.height)) * 100

            return (
              <div
                key={clip.id}
                role="button"
                tabIndex={0}
                aria-roledescription="overlay clip"
                aria-label={overlayDetailedLabel(clip)}
                aria-pressed={isSelected}
                className={cn(
                  "absolute pointer-events-auto select-none outline-none motion-reduce:transition-none",
                  !clip.locked && "cursor-move",
                  clip.locked && "cursor-default",
                )}
                style={{
                  left: `${leftPercent}%`,
                  top: `${topPercent}%`,
                  width: `${widthPercent}%`,
                  height: `${heightPercent}%`,
                  transform: `rotate(${clip.rotation}deg)`,
                  transformOrigin: `${originXPercent}% ${originYPercent}%`,
                }}
                onClick={(event) => {
                  event.stopPropagation()
                  onSelectClip(clip)
                }}
                onFocus={() => onSelectClip(clip)}
                onKeyDown={(event) => handleClipKeyDown(event, clip)}
                onPointerDown={(event) => {
                  event.stopPropagation()
                  onSelectClip(clip)
                  interaction.beginGesture(event, clip, "body")
                }}
                onPointerMove={interaction.moveGesture}
                onPointerUp={interaction.finishGesture}
                onPointerCancel={interaction.finishGesture}
                onLostPointerCapture={interaction.handleLostPointerCapture}
              >
                {isSelected ? (
                  <SelectionControls clip={clip} rect={rect} interaction={interaction} />
                ) : null}
              </div>
            )
          })}
    </div>
  )
}

function SelectionControls({
  clip,
  rect,
  interaction,
}: {
  clip: OverlayClip
  rect: OverlayRect
  interaction: OverlayInteraction
}) {
  if (clip.locked) {
    return <div className="pointer-events-none absolute inset-0 rounded-sm ring-2 ring-muted" />
  }

  const isLine =
    clip.kind === "annotation" &&
    (clip.annotationType === "arrow" || clip.annotationType === "line")

  return (
    <>
      <div className="pointer-events-none absolute inset-0 rounded-sm border-2 border-dashed border-warning ring-2 ring-warning/20" />
      {!isLine
        ? RESIZE_HANDLES.map(({ handle, left, top, cursor, label }) => (
            <Handle
              key={handle}
              label={`${label} ${overlayKindLabel(clip)}`}
              className={cursor}
              style={{ left, top }}
              onPointerDown={(event) => beginHandleGesture(event, clip, handle, interaction)}
              onPointerMove={interaction.moveGesture}
              onPointerUp={interaction.finishGesture}
              onPointerCancel={interaction.finishGesture}
              onLostPointerCapture={interaction.handleLostPointerCapture}
            />
          ))
        : null}
      {clip.kind === "annotation" && isLine ? (
        <ArrowEndpointHandles clip={clip} rect={rect} interaction={interaction} />
      ) : (
        <RotationHandle clip={clip} interaction={interaction} />
      )}
      {clip.kind === "annotation" &&
      clip.annotationType === "callout" &&
      clip.endX !== undefined &&
      clip.endY !== undefined ? (
        <CalloutTargetHandle clip={clip} interaction={interaction} />
      ) : null}
    </>
  )
}

function CalloutTargetHandle({
  clip,
  interaction,
}: {
  clip: Extract<OverlayClip, { kind: "annotation" }>
  interaction: OverlayInteraction
}) {
  const width = Math.max(1, clip.width)
  const height = Math.max(1, clip.height)
  // The leader tip usually sits outside the box; overflow is intentional.
  const endX = clip.endX ?? clip.x + width / 2
  const endY = clip.endY ?? clip.y + height

  return (
    <Handle
      label="Move callout pointer target"
      className="cursor-grab rounded-full bg-warning"
      style={{
        left: `${((endX - clip.x) / width) * 100}%`,
        top: `${((endY - clip.y) / height) * 100}%`,
      }}
      onPointerDown={(event) => beginHandleGesture(event, clip, "arrow-end", interaction)}
      onPointerMove={interaction.moveGesture}
      onPointerUp={interaction.finishGesture}
      onPointerCancel={interaction.finishGesture}
      onLostPointerCapture={interaction.handleLostPointerCapture}
    />
  )
}

function RotationHandle({
  clip,
  interaction,
}: {
  clip: OverlayClip
  interaction: OverlayInteraction
}) {
  return (
    <>
      <div className="pointer-events-none absolute left-1/2 -top-6 h-6 w-px -translate-x-1/2 bg-warning" />
      <Handle
        label={`Rotate ${overlayKindLabel(clip)}`}
        className="cursor-grab rounded-full"
        style={{ left: "50%", top: "-24px" }}
        onPointerDown={(event) => beginHandleGesture(event, clip, "rotate", interaction)}
        onPointerMove={interaction.moveGesture}
        onPointerUp={interaction.finishGesture}
        onPointerCancel={interaction.finishGesture}
        onLostPointerCapture={interaction.handleLostPointerCapture}
      />
    </>
  )
}

function ArrowEndpointHandles({
  clip,
  rect,
  interaction,
}: {
  clip: Extract<OverlayClip, { kind: "annotation" }>
  rect: OverlayRect
  interaction: OverlayInteraction
}) {
  const endX = clip.endX ?? clip.x + clip.width
  const endY = clip.endY ?? clip.y + clip.height
  const width = Math.max(1, rect.width)
  const height = Math.max(1, rect.height)

  return (
    <>
      <Handle
        label="Move annotation start point"
        className="cursor-grab rounded-full bg-primary"
        style={{
          left: `${((clip.x - rect.x) / width) * 100}%`,
          top: `${((clip.y - rect.y) / height) * 100}%`,
        }}
        onPointerDown={(event) => beginHandleGesture(event, clip, "arrow-start", interaction)}
        onPointerMove={interaction.moveGesture}
        onPointerUp={interaction.finishGesture}
        onPointerCancel={interaction.finishGesture}
        onLostPointerCapture={interaction.handleLostPointerCapture}
      />
      <Handle
        label="Move annotation end point"
        className="cursor-grab rounded-full bg-warning"
        style={{
          left: `${((endX - rect.x) / width) * 100}%`,
          top: `${((endY - rect.y) / height) * 100}%`,
        }}
        onPointerDown={(event) => beginHandleGesture(event, clip, "arrow-end", interaction)}
        onPointerMove={interaction.moveGesture}
        onPointerUp={interaction.finishGesture}
        onPointerCancel={interaction.finishGesture}
        onLostPointerCapture={interaction.handleLostPointerCapture}
      />
    </>
  )
}

function Handle({
  label,
  className,
  style,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
}: {
  label: string
  className: string
  style?: React.CSSProperties
  onPointerDown: React.PointerEventHandler<HTMLDivElement>
  onPointerMove: React.PointerEventHandler<HTMLDivElement>
  onPointerUp: React.PointerEventHandler<HTMLDivElement>
  onPointerCancel: React.PointerEventHandler<HTMLDivElement>
  onLostPointerCapture: React.PointerEventHandler<HTMLDivElement>
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      className={cn(
        "absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border-2 border-background bg-warning shadow-e2 pointer-events-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning",
        className,
      )}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
      onClick={(event) => event.stopPropagation()}
    />
  )
}

function beginHandleGesture(
  event: React.PointerEvent<HTMLDivElement>,
  clip: OverlayClip,
  handle: OverlayHandle,
  interaction: OverlayInteraction,
): void {
  event.stopPropagation()
  interaction.beginGesture(event, clip, handle)
}

function effectiveZIndex(clip: OverlayClip): number {
  const groupOffset = clip.kind === "image" ? 0 : clip.kind === "annotation" ? 1_000_000 : 2_000_000
  return groupOffset + clip.zIndex
}

function overlayKindLabel(clip: OverlayClip): string {
  if (clip.kind === "annotation") return `${clip.annotationType} annotation`
  if (clip.kind === "text") return "title"
  return "image overlay"
}

function overlayLabel(clip: OverlayClip): string {
  if (clip.kind === "annotation") return `${clip.annotationType} annotation`
  if (clip.kind === "text") return `Title: ${clip.primaryText}`
  return "Image overlay"
}

function overlayDetailedLabel(clip: OverlayClip): string {
  const base = overlayLabel(clip)
  const pos = `X ${Math.round(clip.x)}px, Y ${Math.round(clip.y)}px, ${Math.round(clip.width)} by ${Math.round(clip.height)}px`
  const rot = clip.rotation !== 0 ? `, rotated ${Math.round(clip.rotation)} degrees` : ""
  const lock = clip.locked ? ", locked" : ""
  return `${base}, ${pos}${rot}${lock}. Use arrow keys to nudge, Ctrl+arrow to resize, R to rotate, Delete to remove.`
}
