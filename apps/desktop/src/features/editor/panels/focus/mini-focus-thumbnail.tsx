import { memo } from "react"
import type { ZoomTarget } from "@recordforge/contracts"
import { cn } from "@recordforge/ui"

interface MiniFocusThumbnailProps {
  target: ZoomTarget
  canvas: { width: number; height: number }
  width?: number
  className?: string
}

/**
 * Compact 2D aspect preview showing the canvas frame and
 * the highlighted zoom crop area for rapid spatial orientation.
 */
export const MiniFocusThumbnail = memo(function MiniFocusThumbnail({
  target,
  canvas,
  width = 44,
  className,
}: MiniFocusThumbnailProps) {
  const canvasWidth = canvas.width || 1920
  const canvasHeight = canvas.height || 1080
  const aspectRatio = canvasHeight / canvasWidth
  const height = Math.round(width * aspectRatio)
  const scale = width / canvasWidth

  const left = Math.max(0, Math.min(width - 4, Math.round(target.x * scale)))
  const top = Math.max(0, Math.min(height - 4, Math.round(target.y * scale)))
  const boxWidth = Math.max(4, Math.min(width - left, Math.round(target.width * scale)))
  const boxHeight = Math.max(4, Math.min(height - top, Math.round(target.height * scale)))

  return (
    <div
      className={cn(
        "relative shrink-0 overflow-hidden rounded-xs border border-border-strong bg-black/60 shadow-inner",
        className,
      )}
      style={{ width: `${width}px`, height: `${height}px` }}
      aria-hidden
    >
      {/* Subtle rule of thirds grid */}
      <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3 opacity-15">
        <div className="border-b border-r border-dashed border-white/50" />
        <div className="border-b border-r border-dashed border-white/50" />
        <div className="border-b border-dashed border-white/50" />
        <div className="border-b border-r border-dashed border-white/50" />
        <div className="border-b border-r border-dashed border-white/50" />
        <div className="border-b border-dashed border-white/50" />
        <div className="border-r border-dashed border-white/50" />
        <div className="border-r border-dashed border-white/50" />
        <div />
      </div>

      {/* Target Focus Rectangle */}
      <div
        className="pointer-events-none absolute rounded-xs border border-primary bg-primary/35 shadow-xs"
        style={{
          left: `${left}px`,
          top: `${top}px`,
          width: `${boxWidth}px`,
          height: `${boxHeight}px`,
        }}
      >
        {/* Tiny focal center dot */}
        <div className="absolute left-1/2 top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-xs" />
      </div>
    </div>
  )
})
