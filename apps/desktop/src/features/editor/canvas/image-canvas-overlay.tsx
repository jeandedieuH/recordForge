import type { ImageClip } from "@recordforge/contracts"
import type { OverlayHandle } from "@recordforge/editor-core"
import type { OverlayInteraction } from "./use-overlay-interaction"
import { cn } from "@recordforge/ui"

interface ImageCanvasOverlayProps {
  clips: ImageClip[]
  playheadMs: number
  canvasWidth: number
  canvasHeight: number
  selectedClipId?: string | null
  assetUrls?: Record<string, string>
  interaction: OverlayInteraction
  onSelectClip?: (clip: ImageClip) => void
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
  interaction,
  onSelectClip,
}: ImageCanvasOverlayProps) {
  function beginGesture(
    event: React.PointerEvent<Element>,
    clip: ImageClip,
    handle: OverlayHandle,
  ) {
    interaction.beginGesture(event, clip, handle)
  }

  function moveGesture(event: React.PointerEvent<Element>) {
    interaction.moveGesture(event)
  }

  function finishGesture(event: React.PointerEvent<Element>) {
    interaction.finishGesture(event)
  }

  return (
    <div className="absolute inset-0 z-34 size-full pointer-events-none overflow-hidden">
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
              transform: `rotate(${clip.rotation}deg)`,
              transformOrigin: `${clip.anchorX * 100}% ${clip.anchorY * 100}%`,
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
            onFocus={() => onSelectClip?.(clip)}
            onPointerDown={(e) => beginGesture(e, clip, "body")}
            onPointerMove={moveGesture}
            onPointerUp={finishGesture}
            onPointerCancel={finishGesture}
            onLostPointerCapture={interaction.handleLostPointerCapture}
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
              <>
                {[
                  {
                    handle: "nw" as const,
                    left: "0%",
                    top: "0%",
                    cursor: "cursor-nwse-resize",
                    label: "Resize image northwest",
                  },
                  {
                    handle: "n" as const,
                    left: "50%",
                    top: "0%",
                    cursor: "cursor-n-resize",
                    label: "Resize image north",
                  },
                  {
                    handle: "ne" as const,
                    left: "100%",
                    top: "0%",
                    cursor: "cursor-nesw-resize",
                    label: "Resize image northeast",
                  },
                  {
                    handle: "e" as const,
                    left: "100%",
                    top: "50%",
                    cursor: "cursor-ew-resize",
                    label: "Resize image east",
                  },
                  {
                    handle: "se" as const,
                    left: "100%",
                    top: "100%",
                    cursor: "cursor-nwse-resize",
                    label: "Resize image southeast",
                  },
                  {
                    handle: "s" as const,
                    left: "50%",
                    top: "100%",
                    cursor: "cursor-s-resize",
                    label: "Resize image south",
                  },
                  {
                    handle: "sw" as const,
                    left: "0%",
                    top: "100%",
                    cursor: "cursor-nesw-resize",
                    label: "Resize image southwest",
                  },
                  {
                    handle: "w" as const,
                    left: "0%",
                    top: "50%",
                    cursor: "cursor-ew-resize",
                    label: "Resize image west",
                  },
                ].map(({ handle, left, top, cursor, label }) => (
                  <div
                    key={handle}
                    role="button"
                    tabIndex={0}
                    aria-label={label}
                    className={cn(
                      "absolute -translate-x-1/2 -translate-y-1/2 size-3.5 rounded-sm border-2 border-background bg-info shadow-e2 pointer-events-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info",
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
                  className="pointer-events-none absolute left-1/2 -top-6 h-6 w-px -translate-x-1/2 bg-info"
                />
                <div
                  role="button"
                  tabIndex={0}
                  aria-label="Rotate image"
                  className="absolute left-1/2 -top-8 size-3.5 -translate-x-1/2 cursor-grab rounded-full border-2 border-background bg-info shadow-e2 pointer-events-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info"
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
