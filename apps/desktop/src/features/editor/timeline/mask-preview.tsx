import { useRef } from "react"
import type { MaskClip, MaskRect } from "@recordforge/contracts"

interface MaskPreviewProps {
  clips: MaskClip[]
  playheadMs: number
  canvasWidth: number
  canvasHeight: number
  onSelectMask?: (clip: MaskClip) => void
  onUpdateMask?: (
    clipId: string,
    rect: MaskRect,
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
}

interface MaskGesture {
  clipId: string
  pointerId: number
  mode: "move" | "resize"
  startX: number
  startY: number
  rect: MaskRect
  moved: boolean
}

function isActive(clip: MaskClip, playheadMs: number): boolean {
  return clip.enabled && playheadMs >= clip.startMs && playheadMs < clip.startMs + clip.durationMs
}

function clampRect(rect: MaskRect, canvasWidth: number, canvasHeight: number): MaskRect {
  const width = Math.min(Math.max(1, rect.width), canvasWidth)
  const height = Math.min(Math.max(1, rect.height), canvasHeight)
  return {
    x: Math.min(Math.max(0, rect.x), Math.max(0, canvasWidth - width)),
    y: Math.min(Math.max(0, rect.y), Math.max(0, canvasHeight - height)),
    width,
    height,
  }
}

function maskVisual(clip: MaskClip): React.CSSProperties {
  if (clip.mode === "redact") {
    return { backgroundColor: clip.redactColor, opacity: 0.98 }
  }
  if (clip.mode === "pixelate") {
    return {
      backgroundImage:
        "linear-gradient(45deg, rgb(255 255 255 / 0.14) 25%, transparent 25%, transparent 75%, rgb(255 255 255 / 0.14) 75%), linear-gradient(45deg, rgb(255 255 255 / 0.14) 25%, transparent 25%, transparent 75%, rgb(255 255 255 / 0.14) 75%)",
      backgroundPosition: "0 0, 6px 6px",
      backgroundSize: "12px 12px",
      backdropFilter: `blur(${Math.max(4, clip.pixelSize / 2)}px)`,
      backgroundColor: "rgb(20 24 32 / 0.2)",
    }
  }
  return {
    backdropFilter: `blur(${clip.blurRadius}px)`,
    backgroundColor: "rgb(20 24 32 / 0.16)",
  }
}

export function MaskPreview({
  clips,
  playheadMs,
  canvasWidth,
  canvasHeight,
  onSelectMask,
  onUpdateMask,
}: MaskPreviewProps) {
  const gestureRef = useRef<MaskGesture | null>(null)

  function beginGesture(
    event: React.PointerEvent<HTMLDivElement>,
    clip: MaskClip,
    mode: MaskGesture["mode"],
  ) {
    if (!onUpdateMask || event.button !== 0 || !isActive(clip, playheadMs)) return
    event.stopPropagation()
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureRef.current = {
      clipId: clip.id,
      pointerId: event.pointerId,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      rect: clip.rect,
      moved: false,
    }
  }

  function moveGesture(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId || !onUpdateMask) return
    const parent = event.currentTarget.parentElement
    if (!parent) return
    const deltaX =
      ((event.clientX - gesture.startX) / Math.max(1, parent.clientWidth)) * canvasWidth
    const deltaY =
      ((event.clientY - gesture.startY) / Math.max(1, parent.clientHeight)) * canvasHeight
    if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1 && !gesture.moved) return
    gesture.moved = true
    event.preventDefault()
    const next =
      gesture.mode === "resize"
        ? {
            ...gesture.rect,
            width: gesture.rect.width + deltaX,
            height: gesture.rect.height + deltaY,
          }
        : {
            ...gesture.rect,
            x: gesture.rect.x + deltaX,
            y: gesture.rect.y + deltaY,
          }
    onUpdateMask(gesture.clipId, clampRect(next, canvasWidth, canvasHeight), { phase: "draft" })
  }

  function finishGesture(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const wasCancelled = event.type === "pointercancel"
    const didMove = gesture.moved
    gestureRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!onUpdateMask) return

    if (wasCancelled || !didMove) {
      onUpdateMask(gesture.clipId, gesture.rect, { phase: "cancel" })
      return
    }

    const parent = event.currentTarget.parentElement
    if (!parent) return
    const deltaX =
      ((event.clientX - gesture.startX) / Math.max(1, parent.clientWidth)) * canvasWidth
    const deltaY =
      ((event.clientY - gesture.startY) / Math.max(1, parent.clientHeight)) * canvasHeight
    const next =
      gesture.mode === "resize"
        ? {
            ...gesture.rect,
            width: gesture.rect.width + deltaX,
            height: gesture.rect.height + deltaY,
          }
        : {
            ...gesture.rect,
            x: gesture.rect.x + deltaX,
            y: gesture.rect.y + deltaY,
          }
    onUpdateMask(gesture.clipId, clampRect(next, canvasWidth, canvasHeight), { phase: "commit" })
  }

  return (
    <>
      {clips.map((clip) => {
        const active = isActive(clip, playheadMs)
        const rect = clampRect(clip.rect, canvasWidth, canvasHeight)
        return (
          <div
            key={clip.id}
            role="button"
            tabIndex={active ? 0 : -1}
            aria-label={`${clip.mode} privacy mask`}
            className="absolute z-30 overflow-visible rounded-sm border border-warning/80 outline-none focus-visible:ring-2 focus-visible:ring-warning"
            style={{
              left: `${(rect.x / canvasWidth) * 100}%`,
              top: `${(rect.y / canvasHeight) * 100}%`,
              width: `${(rect.width / canvasWidth) * 100}%`,
              height: `${(rect.height / canvasHeight) * 100}%`,
              ...maskVisual(clip),
              opacity: active ? 1 : 0,
              pointerEvents: active && onUpdateMask ? "auto" : "none",
            }}
            onClick={(event) => {
              event.stopPropagation()
              onSelectMask?.(clip)
            }}
            onPointerDown={(event) => beginGesture(event, clip, "move")}
            onPointerMove={moveGesture}
            onPointerUp={finishGesture}
            onPointerCancel={finishGesture}
          >
            {active && onUpdateMask ? (
              <div
                role="button"
                tabIndex={0}
                aria-label={`Resize ${clip.mode} mask`}
                className="absolute -bottom-1.5 -right-1.5 size-3 cursor-nwse-resize rounded-sm border border-warning bg-warning shadow-e2"
                onPointerDown={(event) => {
                  event.stopPropagation()
                  beginGesture(event, clip, "resize")
                }}
                onClick={(event) => event.stopPropagation()}
              />
            ) : null}
          </div>
        )
      })}
    </>
  )
}
