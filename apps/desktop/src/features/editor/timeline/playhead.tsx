import { useRef, useState } from "react"
import { useTimelineStore } from "../../../stores/timeline-store"

// Draggable playhead indicator.
export function Playhead() {
  const store = useTimelineStore()
  const view = store.view
  const [isDragging, setIsDragging] = useState(false)
  const dragRef = useRef({ startX: 0, startMs: 0 })

  const left = view.playheadMs / view.zoom

  function handlePointerDown(e: React.PointerEvent) {
    ;(e.target as Element).setPointerCapture(e.pointerId)
    setIsDragging(true)
    dragRef.current = { startX: e.clientX, startMs: view.playheadMs }
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!isDragging) return
    const dx = e.clientX - dragRef.current.startX
    const newMs = Math.max(0, Math.round(dragRef.current.startMs + dx * view.zoom))
    store.seek(newMs)
  }

  function handlePointerUp(e: React.PointerEvent) {
    setIsDragging(false)
    try {
      ;(e.target as Element).releasePointerCapture(e.pointerId)
    } catch {
      // releasePointerCapture can fail if the element already lost capture.
    }
  }

  return (
    <div
      className="absolute top-0 z-10 h-full w-0.5 cursor-ew-resize bg-red-500"
      style={{ left: `${left}px` }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      aria-label="Playhead"
      role="slider"
    >
      <div className="absolute -top-1 -left-1.5 h-3 w-3 -rotate-45 transform bg-red-500" />
    </div>
  )
}
