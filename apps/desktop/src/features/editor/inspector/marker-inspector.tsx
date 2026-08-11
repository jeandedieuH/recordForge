import { useEffect, useState } from "react"
import type { TimelineMarker } from "@recordforge/contracts"
import { createDeleteMarkerCommand, createUpdateMarkerCommand } from "@recordforge/editor-core"
import { Flag as FlagIcon } from "lucide-react"
import { Button, Input } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"

interface MarkerInspectorProps {
  marker: TimelineMarker
  onClear: () => void
}

export function MarkerInspector({ marker, onClear }: MarkerInspectorProps) {
  const execute = useTimelineStore((state) => state.execute)
  const [markerLabel, setMarkerLabel] = useState(marker.label)
  const [markerTimeText, setMarkerTimeText] = useState(String(marker.timeMs))

  useEffect(() => {
    setMarkerLabel(marker.label)
    setMarkerTimeText(String(marker.timeMs))
  }, [marker])

  function handleTimeBlur() {
    const timeMs = Number.parseInt(markerTimeText, 10)
    if (Number.isFinite(timeMs) && timeMs >= 0) {
      execute(createUpdateMarkerCommand(marker.id, { timeMs }))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between border-b border-border pb-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <FlagIcon className="size-4 text-primary" aria-hidden />
          <span>Marker</span>
        </div>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onClear}>
          Clear
        </Button>
      </div>
      <div className="flex flex-col gap-3">
        <Input
          aria-label="Marker label"
          value={markerLabel}
          onChange={(event) => setMarkerLabel(event.target.value)}
          onBlur={() => execute(createUpdateMarkerCommand(marker.id, { label: markerLabel }))}
        />
        <Input
          aria-label="Marker time in milliseconds"
          type="number"
          min={0}
          value={markerTimeText}
          onChange={(event) => setMarkerTimeText(event.target.value)}
          onBlur={handleTimeBlur}
        />
        <p className="font-mono text-xs tabular-nums text-subtle-foreground">
          {formatMarkerTime(marker.timeMs)}
        </p>
      </div>
      <Button
        variant="destructive"
        size="sm"
        onClick={() => {
          execute(createDeleteMarkerCommand(marker.id))
          onClear()
        }}
      >
        Delete marker
      </Button>
    </div>
  )
}

function formatMarkerTime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const remainder = Math.floor(ms % 1000)
  return `${seconds}.${remainder.toString().padStart(3, "0")}s`
}
