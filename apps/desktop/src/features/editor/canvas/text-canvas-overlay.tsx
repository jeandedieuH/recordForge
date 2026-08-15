import { useRef } from "react"
import type { TextClip } from "@recordforge/contracts"
import { cn } from "@recordforge/ui"

interface TextCanvasOverlayProps {
  clips: TextClip[]
  playheadMs: number
  canvasWidth: number
  canvasHeight: number
  selectedClipId?: string | null
  onSelectClip?: (clip: TextClip) => void
  onUpdateClip?: (
    clipId: string,
    update: Partial<TextClip>,
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
}

interface GestureState {
  clipId: string
  pointerId: number
  mode: "move" | "resize"
  startX: number
  startY: number
  initialClip: TextClip
  moved: boolean
}

function isActive(clip: TextClip, playheadMs: number): boolean {
  return (
    clip.enabled !== false &&
    playheadMs >= clip.startMs &&
    playheadMs < clip.startMs + clip.durationMs
  )
}

export function TextCanvasOverlay({
  clips,
  playheadMs,
  canvasWidth,
  canvasHeight,
  selectedClipId,
  onSelectClip,
  onUpdateClip,
}: TextCanvasOverlayProps) {
  const gestureRef = useRef<GestureState | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  function beginGesture(
    event: React.PointerEvent<HTMLDivElement>,
    clip: TextClip,
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
    const update: Partial<TextClip> = {}

    if (gesture.mode === "move") {
      update.x = Math.max(0, Math.min(canvasWidth - init.width, init.x + deltaX))
      update.y = Math.max(0, Math.min(canvasHeight - init.height, init.y + deltaY))
    } else if (gesture.mode === "resize") {
      update.width = Math.max(80, init.width + deltaX)
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
    const update: Partial<TextClip> = {}

    if (gesture.mode === "move") {
      update.x = Math.max(0, Math.min(canvasWidth - init.width, init.x + deltaX))
      update.y = Math.max(0, Math.min(canvasHeight - init.height, init.y + deltaY))
    } else if (gesture.mode === "resize") {
      update.width = Math.max(80, init.width + deltaX)
      update.height = Math.max(40, init.height + deltaY)
    }

    onUpdateClip(gesture.clipId, update, { phase: "commit" })
  }

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-36 size-full pointer-events-none overflow-hidden"
    >
      {clips.map((clip) => {
        const active = isActive(clip, playheadMs)
        if (!active) return null
        const isSelected = selectedClipId === clip.id

        // Compute percentage placement based on canvas coordinates
        const leftPercent = (clip.x / canvasWidth) * 100
        const topPercent = (clip.y / canvasHeight) * 100
        const widthPercent = (clip.width / canvasWidth) * 100
        const heightPercent = (clip.height / canvasHeight) * 100

        // Backdrop visual styles
        const backdropStyle: React.CSSProperties = {
          backgroundColor:
            clip.backdropStyle === "none"
              ? "transparent"
              : clip.backdropStyle === "glass"
                ? `rgba(15, 23, 42, ${clip.backdropOpacity ?? 0.8})`
                : clip.backdropColor,
          backdropFilter:
            clip.backdropStyle === "glass" ? `blur(${clip.backdropBlur ?? 16}px)` : undefined,
          borderRadius: `${clip.backdropBorderRadius}px`,
          padding: `${clip.backdropPaddingY ?? 12}px ${clip.backdropPaddingX ?? 20}px`,
          boxShadow: clip.shadowEnabled ? clip.shadowColor : undefined,
          border:
            clip.backdropStyle === "glass" || clip.backdropStyle === "outline"
              ? `1px solid ${clip.accentColor}35`
              : undefined,
        }

        return (
          <div
            key={clip.id}
            role="button"
            tabIndex={0}
            aria-label={`Title: ${clip.primaryText}`}
            className={cn(
              "absolute pointer-events-auto cursor-move select-none transition-shadow",
              clip.locked && "cursor-default",
              isSelected && "ring-2 ring-warning ring-offset-2 ring-offset-transparent",
            )}
            style={{
              left: `${leftPercent}%`,
              top: `${topPercent}%`,
              width: `${widthPercent}%`,
              minHeight: `${heightPercent}%`,
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
            {/* Backdrop Card */}
            <div
              className={cn(
                "relative flex size-full flex-col justify-center overflow-hidden",
                clip.alignment === "center" && "items-center text-center",
                clip.alignment === "right" && "items-end text-right",
                clip.alignment === "left" && "items-start text-left",
              )}
              style={backdropStyle}
            >
              {/* Left Accent Bar */}
              {clip.backdropStyle === "accent-bar" ? (
                <div
                  className="absolute left-0 top-0 bottom-0 w-2"
                  style={{ backgroundColor: clip.accentColor }}
                />
              ) : null}

              {/* Tag / Badge */}
              {clip.tagText ? (
                <span
                  className="mb-1 inline-flex w-fit items-center rounded px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider"
                  style={{
                    backgroundColor: `${clip.accentColor}25`,
                    color: clip.accentColor,
                    border: `1px solid ${clip.accentColor}50`,
                  }}
                >
                  {clip.tagText}
                </span>
              ) : null}

              {/* Primary Main Title */}
              <div
                className={cn(
                  "font-bold leading-tight drop-shadow-sm",
                  clip.fontFamily === "serif" && "font-serif",
                  clip.fontFamily === "mono" && "font-mono",
                )}
                style={{
                  color: clip.textColor,
                  fontSize: `${clip.fontSize}px`,
                  fontWeight: clip.fontWeight,
                }}
              >
                {clip.primaryText}
              </div>

              {/* Secondary Subtitle */}
              {clip.secondaryText ? (
                <div
                  className={cn(
                    "mt-1 opacity-90 leading-snug",
                    clip.fontFamily === "serif" && "font-serif",
                    clip.fontFamily === "mono" && "font-mono",
                  )}
                  style={{
                    color: clip.secondaryTextColor ?? "#94a3b8",
                    fontSize: `${Math.max(12, Math.round(clip.fontSize * 0.55))}px`,
                  }}
                >
                  {clip.secondaryText}
                </div>
              ) : null}
            </div>

            {/* Resize Handle for Selected Clip */}
            {isSelected && !clip.locked && (
              <div
                role="button"
                tabIndex={0}
                aria-label="Resize title"
                className="absolute -bottom-1.5 -right-1.5 size-3.5 cursor-nwse-resize rounded-sm border-2 border-white bg-warning shadow-e2 pointer-events-auto"
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
