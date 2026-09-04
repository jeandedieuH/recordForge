import { useEffect, useState } from "react"
import type { TimelineMarker } from "@recordforge/contracts"
import {
  createDeleteMarkerCommand,
  createUpdateMarkerCommand,
  formatYouTubeChapters,
  getTotalDuration,
} from "@recordforge/editor-core"
import { Check, Copy, Flag as FlagIcon } from "lucide-react"
import { Button, Input, NumberInputField } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"

interface MarkerInspectorProps {
  marker: TimelineMarker
  onClear: () => void
}

export function MarkerInspector({ marker, onClear }: MarkerInspectorProps) {
  const execute = useTimelineStore((state) => state.execute)
  const timeline = useTimelineStore((state) => state.engine?.history.present)
  const recording = useTimelineStore((state) => state.recording)
  const [markerLabel, setMarkerLabel] = useState(marker.label)
  const [copiedTimestamps, setCopiedTimestamps] = useState(false)

  useEffect(() => {
    setMarkerLabel(marker.label)
  }, [marker])

  async function handleCopyYouTubeChapters() {
    if (!timeline || !timeline.markers || timeline.markers.length === 0) return
    const durationMs = getTotalDuration(timeline)
    const text = formatYouTubeChapters(
      timeline.markers,
      durationMs,
      recording?.name ?? timeline.name,
    )
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopiedTimestamps(true)
      setTimeout(() => setCopiedTimestamps(false), 2000)
    } catch {
      // Ignore clipboard error
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
        <NumberInputField
          label="Marker time"
          unit="ms"
          min={0}
          step={100}
          value={marker.timeMs}
          onChange={(timeMs) => execute(createUpdateMarkerCommand(marker.id, { timeMs }))}
        />
        <p className="font-mono text-xs tabular-nums text-subtle-foreground">
          {formatMarkerTime(marker.timeMs)}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={() => void handleCopyYouTubeChapters()}
        >
          {copiedTimestamps ? (
            <>
              <Check className="size-3.5 text-success" />
              <span>Copied YouTube timestamps</span>
            </>
          ) : (
            <>
              <Copy className="size-3.5" />
              <span>Copy all as YouTube timestamps</span>
            </>
          )}
        </Button>
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
    </div>
  )
}

function formatMarkerTime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const remainder = Math.floor(ms % 1000)
  return `${seconds}.${remainder.toString().padStart(3, "0")}s`
}
