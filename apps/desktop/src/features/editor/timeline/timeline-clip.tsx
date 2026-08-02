import { useRef, useState } from "react"
import type { TimelineClip } from "@recordforge/contracts"
import { createMoveClipCommand, formatTime } from "@recordforge/editor-core"
import { useTimelineStore } from "../../../stores/timeline-store"

interface TimelineClipViewProps {
  clip: TimelineClip
  selected: boolean
  onSelect: (id: string) => void
}

function clipColor(kind: TimelineClip["kind"]): string {
  switch (kind) {
    case "screen":
      return "bg-blue-600"
    case "camera":
      return "bg-purple-600"
    case "audio":
      return "bg-green-600"
    case "caption":
      return "bg-yellow-500"
    default:
      return "bg-muted"
  }
}

// Single clip on a track. Supports pointer drag to move the clip.
export function TimelineClipView({ clip, selected, onSelect }: TimelineClipViewProps) {
  const store = useTimelineStore()
  const view = store.view
  const [isDragging, setIsDragging] = useState(false)
  const [dragOffset, setDragOffset] = useState(0)
  const dragRef = useRef({ startX: 0, originalStart: 0 })

  const left = clip.startMs / view.zoom
  const width = Math.max(4, clip.durationMs / view.zoom)

  function handlePointerDown(e: React.PointerEvent) {
    const trackLocked = store.engine?.history.present.tracks.some(
      (t) => t.clips.some((c) => c.id === clip.id) && t.locked,
    )
    if (trackLocked) return
    ;(e.target as Element).setPointerCapture(e.pointerId)
    setIsDragging(true)
    dragRef.current = { startX: e.clientX, originalStart: clip.startMs }
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!isDragging) return
    const dx = e.clientX - dragRef.current.startX
    if (dx !== dragOffset) {
      setDragOffset(dx)
    }
  }

  function handlePointerUp(e: React.PointerEvent) {
    setIsDragging(false)
    try {
      ;(e.target as Element).releasePointerCapture(e.pointerId)
    } catch {
      // releasePointerCapture can fail if the element already lost capture.
    }

    const newStart = Math.round(dragRef.current.originalStart + dragOffset * view.zoom)
    if (newStart !== clip.startMs) {
      store.execute(createMoveClipCommand(clip.id, Math.max(0, newStart)))
    }
    setDragOffset(0)
  }

  function handleClick() {
    onSelect(clip.id)
  }

  const displayText = clip.kind === "caption" ? clip.text : `${clip.kind} clip`

  return (
    <div
      className={`absolute top-1 h-[calc(100%-8px)] cursor-grab overflow-hidden rounded border border-white/20 px-1 py-0.5 text-[10px] text-white shadow-sm active:cursor-grabbing ${clipColor(clip.kind)} ${selected ? "ring-2 ring-primary ring-offset-1" : ""}`}
      style={{
        left: `${left}px`,
        width: `${width}px`,
        transform: isDragging ? `translateX(${dragOffset}px)` : "none",
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      aria-label={`${clip.kind} clip from ${formatTime(clip.startMs)}`}
    >
      <span className="block truncate">{displayText}</span>
    </div>
  )
}
