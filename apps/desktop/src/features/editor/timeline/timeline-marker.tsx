import type { TimelineMarker } from "@recordforge/contracts"
import { useTimelineStore } from "../../../stores/timeline-store"

interface TimelineMarkerProps {
  marker: TimelineMarker
  onClick?: (marker: TimelineMarker) => void
}

// Visual marker/chapter indicator on the timeline.
export function TimelineMarkerView({ marker, onClick }: TimelineMarkerProps) {
  const view = useTimelineStore((state) => state.view)
  const left = marker.timeMs / view.zoom

  return (
    <button
      type="button"
      onClick={() => onClick?.(marker)}
      className="absolute top-0 z-10 flex -translate-x-1/2 flex-col items-center text-[10px] font-medium"
      style={{ left: `${left}px`, color: marker.color }}
      title={marker.label}
    >
      <span className="truncate max-w-[120px] px-1">{marker.label}</span>
      <div className="h-2 w-0.5" style={{ backgroundColor: marker.color }} />
    </button>
  )
}
