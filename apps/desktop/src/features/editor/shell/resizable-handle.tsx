import { useCallback, useRef } from "react"
import { cn } from "@recordforge/ui"

interface ResizableHandleProps {
  direction: "horizontal" | "vertical"
  value: number
  min: number
  max: number
  onChange: (value: number) => void
  className?: string
}

/**
 * Small drag handle for resizable editor panels.
 *
 * Uses pointer events and a 2px hit area. The parent owns the current value
 * and clamping; the handle reports the delta and applies the appropriate
 * cursor for the drag direction.
 */
export function ResizableHandle({
  direction,
  value,
  min,
  max,
  onChange,
  className,
}: ResizableHandleProps) {
  const startValueRef = useRef(value)
  const startPosRef = useRef(0)

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      const target = event.currentTarget
      target.setPointerCapture(event.pointerId)
      startValueRef.current = value
      startPosRef.current = direction === "horizontal" ? event.clientX : event.clientY

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const currentPos = direction === "horizontal" ? moveEvent.clientX : moveEvent.clientY
        const delta = currentPos - startPosRef.current
        const isVertical = direction === "vertical"
        // For a bottom timeline, dragging down should increase the height,
        // so the delta sign is the same as the layout axis.
        const next = isVertical ? startValueRef.current + delta : startValueRef.current + delta
        onChange(Math.max(min, Math.min(max, next)))
      }

      const handlePointerUp = (upEvent: PointerEvent) => {
        target.releasePointerCapture(upEvent.pointerId)
        window.removeEventListener("pointermove", handlePointerMove)
        window.removeEventListener("pointerup", handlePointerUp)
      }

      window.addEventListener("pointermove", handlePointerMove)
      window.addEventListener("pointerup", handlePointerUp)
    },
    [direction, value, min, max, onChange],
  )

  return (
    <div
      role="separator"
      aria-orientation={direction === "horizontal" ? "vertical" : "horizontal"}
      aria-label={direction === "horizontal" ? "Resize panel width" : "Resize panel height"}
      onPointerDown={handlePointerDown}
      className={cn(
        "group z-10 flex shrink-0 items-center justify-center bg-transparent",
        direction === "horizontal"
          ? "h-full w-px cursor-ew-resize px-1"
          : "h-px w-full cursor-ns-resize py-1",
        className,
      )}
    >
      <span
        className={cn(
          "block rounded-full bg-border transition-colors duration-fast ease-forge group-hover:bg-subtle-foreground",
          direction === "horizontal" ? "h-8 w-0.5" : "h-0.5 w-8",
        )}
      />
    </div>
  )
}
