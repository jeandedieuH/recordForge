import type { ReactNode } from "react"
import type { CameraFrameShape } from "@recordforge/contracts"
import type { ResolvedCameraFrame } from "@recordforge/editor-core"
import { cn } from "@recordforge/ui"
import { Circle, Square } from "lucide-react"
import { BorderOverlay } from "../canvas/border-overlay"
import {
  borderRingRadiusPx,
  cssBorderRadius,
  cssShadow,
  cssSolidBorder,
} from "./camera-frame-style"

export type SnapPosition = "TL" | "TR" | "BL" | "BR"

export interface CameraFrameViewProps {
  /** Resolved camera frame in canvas px (ADR 023 — same resolver as export). */
  frame: ResolvedCameraFrame
  canvasWidth: number
  canvasHeight: number
  /** CSS px per canvas px at the current preview zoom. */
  previewScale: number
  /** A clip is active at the playhead (controls interaction, not the lane). */
  active: boolean
  locked: boolean
  selected: boolean
  /** Transform editing is wired (`onUpdateTransform` provided). */
  interactive: boolean
  /** Corner snap buttons make sense for free overlay placement only. */
  showCornerSnaps?: boolean
  children: ReactNode
  onSelect: () => void
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void
  onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void
  /** Resize handles start the same drag as move, with a corner attached. */
  onResizeHandleDown: (
    event: React.PointerEvent<HTMLDivElement>,
    handle: "nw" | "ne" | "se" | "sw",
  ) => void
  onSnapPreset: (position: SnapPosition) => void
  onSetShape: (shape: CameraFrameShape) => void
}

/**
 * Presentational camera frame: the percentage-positioned outer box from the
 * resolved rect, the rounded/bordered/shadowed inner surface (px lengths
 * scaled by `previewScale`), the SVG ring for non-solid borders, and the
 * selection chrome. All media elements arrive as `children` so the surface
 * keeps owning playback, matte, LUT, and crop logic.
 */
export function CameraFrameView({
  frame,
  canvasWidth,
  canvasHeight,
  previewScale,
  active,
  locked,
  selected,
  interactive,
  showCornerSnaps = true,
  children,
  onSelect,
  onKeyDown,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onResizeHandleDown,
  onSnapPreset,
  onSetShape,
}: CameraFrameViewProps) {
  const { rect, style } = frame
  const cssBorder = cssSolidBorder(style, previewScale)
  const borderStyle = style.borderStyle ?? "solid"
  // A hidden lane window (opacity 0) must not swallow pointer events.
  const interactiveOnScreen = active && frame.visible && frame.opacity > 0

  return (
    <div
      role="button"
      tabIndex={active ? 0 : -1}
      aria-label={
        locked ? "Camera overlay, select to edit" : "Camera overlay, drag to move or resize"
      }
      aria-hidden={!active}
      aria-disabled={false}
      className={cn(
        "group absolute z-30 overflow-visible",
        active && (locked ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"),
        "focus-visible:outline-none",
      )}
      style={{
        left: `${(rect.x / canvasWidth) * 100}%`,
        top: `${(rect.y / canvasHeight) * 100}%`,
        width: `${(rect.width / canvasWidth) * 100}%`,
        height: `${(rect.height / canvasHeight) * 100}%`,
        opacity: active ? frame.opacity : 0,
        pointerEvents: interactiveOnScreen ? "auto" : "none",
      }}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {/* Camera video surface — children are the stream's media elements. */}
      <div
        className="relative size-full overflow-hidden"
        style={{
          borderRadius: cssBorderRadius(frame.shape, frame.radius, previewScale),
          border: cssBorder,
          boxShadow: cssShadow(style, previewScale),
        }}
      >
        {children}
        {style.borderWidth && borderStyle !== "solid" ? (
          <BorderOverlay
            width={rect.width * previewScale}
            height={rect.height * previewScale}
            radius={borderRingRadiusPx(frame.shape, frame.radius, previewScale)}
            circular={frame.shape === "circle"}
            borderWidth={style.borderWidth * previewScale}
            style={borderStyle}
            color={style.borderColor}
            opacity={style.borderOpacity}
            gradient={style.borderGradient}
          />
        ) : null}
      </div>

      {/* Selection ring & on-canvas direct-manipulation handles. */}
      {selected && (
        <div className="pointer-events-none absolute inset-0 rounded-[inherit] ring-2 ring-primary ring-offset-1 ring-offset-background/40" />
      )}

      {selected && !locked && interactive ? (
        <>
          {/* 4 corner resize handles */}
          <div
            role="button"
            tabIndex={0}
            aria-label="Resize camera northwest"
            className="absolute -top-1.5 -left-1.5 z-40 size-3 cursor-nwse-resize rounded-full border-2 border-primary bg-background shadow-e2"
            onPointerDown={(e) => onResizeHandleDown(e, "nw")}
            onClick={(e) => e.stopPropagation()}
          />
          <div
            role="button"
            tabIndex={0}
            aria-label="Resize camera northeast"
            className="absolute -top-1.5 -right-1.5 z-40 size-3 cursor-nesw-resize rounded-full border-2 border-primary bg-background shadow-e2"
            onPointerDown={(e) => onResizeHandleDown(e, "ne")}
            onClick={(e) => e.stopPropagation()}
          />
          <div
            role="button"
            tabIndex={0}
            aria-label="Resize camera southwest"
            className="absolute -bottom-1.5 -left-1.5 z-40 size-3 cursor-nesw-resize rounded-full border-2 border-primary bg-background shadow-e2"
            onPointerDown={(e) => onResizeHandleDown(e, "sw")}
            onClick={(e) => e.stopPropagation()}
          />
          <div
            role="button"
            tabIndex={0}
            aria-label="Resize camera southeast"
            className="absolute -bottom-1.5 -right-1.5 z-40 size-3 cursor-nwse-resize rounded-full border-2 border-primary bg-background shadow-e2"
            onPointerDown={(e) => onResizeHandleDown(e, "se")}
            onClick={(e) => e.stopPropagation()}
          />

          {/* Floating direct action toolbar */}
          <div
            className="absolute -top-8 left-1/2 -translate-x-1/2 z-40 flex items-center gap-1 rounded-full border border-border/80 bg-background/90 px-2 py-0.5 shadow-e3 backdrop-blur-md"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {/* Shape switchers */}
            <button
              type="button"
              title="Circle Shape"
              aria-label="Circle Shape"
              onClick={() => onSetShape("circle")}
              className={cn(
                "flex size-5 items-center justify-center rounded transition-colors",
                frame.shape === "circle"
                  ? "bg-primary text-primary-foreground font-bold"
                  : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
              )}
            >
              <Circle className="size-2.5" aria-hidden />
            </button>
            <button
              type="button"
              title="Rounded Shape"
              aria-label="Rounded Shape"
              onClick={() => onSetShape("rounded")}
              className={cn(
                "flex size-5 items-center justify-center rounded transition-colors",
                frame.shape === "rounded"
                  ? "bg-primary text-primary-foreground font-bold"
                  : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
              )}
            >
              <Square className="size-2.5 rounded-xs" aria-hidden />
            </button>
            <button
              type="button"
              title="Rectangle Shape"
              aria-label="Rectangle Shape"
              onClick={() => onSetShape("rectangle")}
              className={cn(
                "flex size-5 items-center justify-center rounded transition-colors",
                frame.shape === "rectangle"
                  ? "bg-primary text-primary-foreground font-bold"
                  : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
              )}
            >
              <Square className="size-2.5" aria-hidden />
            </button>

            {showCornerSnaps ? (
              <>
                <div className="h-3 w-px bg-border/80 mx-0.5" aria-hidden />

                {/* Corner snap buttons */}
                <button
                  type="button"
                  title="Snap Top-Left"
                  onClick={() => onSnapPreset("TL")}
                  className="px-1 py-0.5 font-mono text-[9px] font-semibold text-muted-foreground hover:bg-surface-hover hover:text-foreground rounded"
                >
                  TL
                </button>
                <button
                  type="button"
                  title="Snap Top-Right"
                  onClick={() => onSnapPreset("TR")}
                  className="px-1 py-0.5 font-mono text-[9px] font-semibold text-muted-foreground hover:bg-surface-hover hover:text-foreground rounded"
                >
                  TR
                </button>
                <button
                  type="button"
                  title="Snap Bottom-Left"
                  onClick={() => onSnapPreset("BL")}
                  className="px-1 py-0.5 font-mono text-[9px] font-semibold text-muted-foreground hover:bg-surface-hover hover:text-foreground rounded"
                >
                  BL
                </button>
                <button
                  type="button"
                  title="Snap Bottom-Right"
                  onClick={() => onSnapPreset("BR")}
                  className="px-1 py-0.5 font-mono text-[9px] font-semibold text-muted-foreground hover:bg-surface-hover hover:text-foreground rounded"
                >
                  BR
                </button>
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  )
}
