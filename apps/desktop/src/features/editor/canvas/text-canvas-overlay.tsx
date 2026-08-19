import type { TextClip } from "@recordforge/contracts"
import type { OverlayHandle } from "@recordforge/editor-core"
import type { OverlayInteraction } from "./use-overlay-interaction"
import { cn } from "@recordforge/ui"

interface TextCanvasOverlayProps {
  clips: TextClip[]
  playheadMs: number
  canvasWidth: number
  canvasHeight: number
  selectedClipId?: string | null
  interaction: OverlayInteraction
  onSelectClip?: (clip: TextClip) => void
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
  interaction,
  onSelectClip,
}: TextCanvasOverlayProps) {
  function beginGesture(event: React.PointerEvent<Element>, clip: TextClip, handle: OverlayHandle) {
    interaction.beginGesture(event, clip, handle)
  }

  function moveGesture(event: React.PointerEvent<Element>) {
    interaction.moveGesture(event)
  }

  function finishGesture(event: React.PointerEvent<Element>) {
    interaction.finishGesture(event)
  }

  return (
    <div className="absolute inset-0 z-36 size-full pointer-events-none overflow-hidden">
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
              height: `${heightPercent}%`,
              transform: `rotate(${clip.rotation}deg)`,
              transformOrigin: `${clip.anchorX * 100}% ${clip.anchorY * 100}%`,
            }}
            onFocus={() => onSelectClip?.(clip)}
            onClick={(e) => {
              e.stopPropagation()
              onSelectClip?.(clip)
            }}
            onPointerDown={(e) => beginGesture(e, clip, "body")}
            onPointerMove={moveGesture}
            onPointerUp={finishGesture}
            onPointerCancel={finishGesture}
            onLostPointerCapture={interaction.handleLostPointerCapture}
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
                  "font-bold leading-tight drop-shadow-sm whitespace-pre-wrap break-words",
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
                    "mt-1 opacity-90 leading-snug whitespace-pre-wrap break-words",
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
              <>
                {[
                  {
                    handle: "nw" as const,
                    left: "0%",
                    top: "0%",
                    cursor: "cursor-nwse-resize",
                    label: "Resize title northwest",
                  },
                  {
                    handle: "n" as const,
                    left: "50%",
                    top: "0%",
                    cursor: "cursor-n-resize",
                    label: "Resize title north",
                  },
                  {
                    handle: "ne" as const,
                    left: "100%",
                    top: "0%",
                    cursor: "cursor-nesw-resize",
                    label: "Resize title northeast",
                  },
                  {
                    handle: "e" as const,
                    left: "100%",
                    top: "50%",
                    cursor: "cursor-ew-resize",
                    label: "Resize title east",
                  },
                  {
                    handle: "se" as const,
                    left: "100%",
                    top: "100%",
                    cursor: "cursor-nwse-resize",
                    label: "Resize title southeast",
                  },
                  {
                    handle: "s" as const,
                    left: "50%",
                    top: "100%",
                    cursor: "cursor-s-resize",
                    label: "Resize title south",
                  },
                  {
                    handle: "sw" as const,
                    left: "0%",
                    top: "100%",
                    cursor: "cursor-nesw-resize",
                    label: "Resize title southwest",
                  },
                  {
                    handle: "w" as const,
                    left: "0%",
                    top: "50%",
                    cursor: "cursor-ew-resize",
                    label: "Resize title west",
                  },
                ].map(({ handle, left, top, cursor, label }) => (
                  <div
                    key={handle}
                    role="button"
                    tabIndex={0}
                    aria-label={label}
                    className={cn(
                      "absolute -translate-x-1/2 -translate-y-1/2 size-3.5 rounded-sm border-2 border-background bg-warning shadow-e2 pointer-events-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning",
                      cursor,
                    )}
                    style={{ left, top }}
                    onPointerDown={(event) => {
                      event.stopPropagation()
                      beginGesture(event, clip, handle)
                    }}
                    onPointerMove={moveGesture}
                    onPointerUp={finishGesture}
                    onPointerCancel={finishGesture}
                    onLostPointerCapture={interaction.handleLostPointerCapture}
                    onClick={(event) => event.stopPropagation()}
                  />
                ))}
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute left-1/2 -top-6 h-6 w-px -translate-x-1/2 bg-warning"
                />
                <div
                  role="button"
                  tabIndex={0}
                  aria-label="Rotate title"
                  className="absolute left-1/2 -top-8 size-3.5 -translate-x-1/2 cursor-grab rounded-full border-2 border-background bg-warning shadow-e2 pointer-events-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning"
                  onPointerDown={(event) => {
                    event.stopPropagation()
                    beginGesture(event, clip, "rotate")
                  }}
                  onPointerMove={moveGesture}
                  onPointerUp={finishGesture}
                  onPointerCancel={finishGesture}
                  onLostPointerCapture={interaction.handleLostPointerCapture}
                  onClick={(event) => event.stopPropagation()}
                />
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
