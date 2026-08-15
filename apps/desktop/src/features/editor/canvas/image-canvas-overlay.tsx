import { useRef } from "react"
import type { ImageClip } from "@recordforge/contracts"
import { cn } from "@recordforge/ui"

interface ImageCanvasOverlayProps {
  clips: ImageClip[]
  playheadMs: number
  canvasWidth: number
  canvasHeight: number
  selectedClipId?: string | null
  assetUrls?: Record<string, string>
  onSelectClip?: (clip: ImageClip) => void
  onUpdateClip?: (
    clipId: string,
    update: Partial<ImageClip>,
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
}

interface GestureState {
  clipId: string
  pointerId: number
  mode: "move" | "resize"
  startX: number
  startY: number
  initialClip: ImageClip
  moved: boolean
}

function isActive(clip: ImageClip, playheadMs: number): boolean {
  return (
    clip.enabled !== false &&
    playheadMs >= clip.startMs &&
    playheadMs < clip.startMs + clip.durationMs
  )
}

export function ImageCanvasOverlay({
  clips,
  playheadMs,
  canvasWidth,
  canvasHeight,
  selectedClipId,
  assetUrls = {},
  onSelectClip,
  onUpdateClip,
}: ImageCanvasOverlayProps) {
  const gestureRef = useRef<GestureState | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  function beginGesture(
    event: React.PointerEvent<HTMLDivElement>,
    clip: ImageClip,
    mode: GestureState["mode"],
  ) {
    if (event.button !== 0 || !isActive(clip, playheadMs) || clip.locked) return
    event.stopPropagation()
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
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

  function moveGesture(event: React.PointerEvent<HTMLDivElement>) {
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
    const update: Partial<ImageClip> = {}

    if (gesture.mode === "move") {
      update.x = Math.max(0, Math.min(canvasWidth - init.width, init.x + deltaX))
      update.y = Math.max(0, Math.min(canvasHeight - init.height, init.y + deltaY))
    } else if (gesture.mode === "resize") {
      update.width = Math.max(40, init.width + deltaX)
      update.height = Math.max(40, init.height + deltaY)
    }

    onUpdateClip(gesture.clipId, update, { phase: "draft" })
  }

  function finishGesture(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const wasCancelled = event.type === "pointercancel"
    const didMove = gesture.moved
    gestureRef.current = null
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
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
    const update: Partial<ImageClip> = {}

    if (gesture.mode === "move") {
      update.x = Math.max(0, Math.min(canvasWidth - init.width, init.x + deltaX))
      update.y = Math.max(0, Math.min(canvasHeight - init.height, init.y + deltaY))
    } else if (gesture.mode === "resize") {
      update.width = Math.max(40, init.width + deltaX)
      update.height = Math.max(40, init.height + deltaY)
    }

    onUpdateClip(gesture.clipId, update, { phase: "commit" })
  }

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-34 size-full pointer-events-none overflow-hidden"
    >
      {clips.map((clip) => {
        const active = isActive(clip, playheadMs)
        if (!active) return null
        const isSelected = selectedClipId === clip.id

        const leftPercent = (clip.x / canvasWidth) * 100
        const topPercent = (clip.y / canvasHeight) * 100
        const widthPercent = (clip.width / canvasWidth) * 100
        const heightPercent = (clip.height / canvasHeight) * 100

        const imageUrl = assetUrls[clip.assetId] || clip.assetId

        return (
          <div
            key={clip.id}
            role="button"
            tabIndex={0}
            aria-label="Image overlay"
            className={cn(
              "absolute pointer-events-auto cursor-move select-none transition-shadow",
              clip.locked && "cursor-default",
              isSelected && "ring-2 ring-info ring-offset-2 ring-offset-transparent",
            )}
            style={{
              left: `${leftPercent}%`,
              top: `${topPercent}%`,
              width: `${widthPercent}%`,
              height: `${heightPercent}%`,
              opacity: clip.opacity,
              borderRadius: `${clip.borderRadius}px`,
              border:
                clip.borderWidth > 0
                  ? `${clip.borderWidth}px solid ${clip.borderColor}`
                  : undefined,
              boxShadow: clip.shadowEnabled ? clip.shadowColor : undefined,
            }}
            onClick={(e) => {
              e.stopPropagation()
              onSelectClip?.(clip)
            }}
            onPointerDown={(e) => beginGesture(e, clip, "move")}
            onPointerMove={moveGesture}
            onPointerUp={finishGesture}
            onPointerCancel={finishGesture}
          >
            {imageUrl ? (
              <img
                src={imageUrl}
                alt="Overlay"
                className="size-full pointer-events-none select-none"
                style={{
                  objectFit: clip.fit,
                  borderRadius: `${clip.borderRadius}px`,
                }}
                onError={(e) => {
                  // Fallback visual if image file not resolved
                  const target = e.currentTarget
                  target.style.display = "none"
                }}
              />
            ) : (
              <div
                className="flex size-full items-center justify-center bg-cyan-950/40 border border-cyan-500/30 text-cyan-400 text-xs font-medium"
                style={{ borderRadius: `${clip.borderRadius}px` }}
              >
                Graphic Overlay
              </div>
            )}

            {/* Resize Handle */}
            {isSelected && !clip.locked && (
              <div
                role="button"
                tabIndex={0}
                aria-label="Resize image"
                className="absolute -bottom-1.5 -right-1.5 size-3.5 cursor-nwse-resize rounded-sm border-2 border-white bg-info shadow-e2 pointer-events-auto"
                onPointerDown={(e) => {
                  e.stopPropagation()
                  beginGesture(e, clip, "resize")
                }}
                onClick={(e) => e.stopPropagation()}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
