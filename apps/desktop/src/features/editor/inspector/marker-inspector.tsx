import { useEffect, useMemo, useRef, useState } from "react"
import type { TimelineMarker } from "@recordforge/contracts"
import {
  createDeleteMarkerCommand,
  createUpdateMarkerCommand,
  formatYouTubeChapters,
  getTotalDuration,
} from "@recordforge/editor-core"
import { Check, Copy, Flag as FlagIcon } from "lucide-react"
import { Button, ColorPicker, Input, NumberInputField } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"
import { formatTimelineTime } from "../timeline/timeline-ruler"

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
  // Escape reverts the label instead of committing it on the following blur.
  const cancelLabelEditRef = useRef(false)

  useEffect(() => {
    setMarkerLabel(marker.label)
  }, [marker])

  // Markers are chapter anchors: they must stay inside the media extent or
  // they would inflate the export range with a dead tail.
  const mediaEndMs = useMemo(() => {
    if (!timeline) return 0
    let end = 0
    for (const track of timeline.tracks) {
      for (const clip of track.clips) {
        end = Math.max(end, clip.startMs + clip.durationMs)
      }
    }
    return end
  }, [timeline])

  // YouTube only renders chapters when there are at least three entries and
  // every chapter spans 10+ seconds. The synthesized 0:00 intro counts.
  const chaptersMeetYouTubeRules = useMemo(() => {
    const times = (timeline?.markers ?? [])
      .map((candidate) => candidate.timeMs)
      .sort((a, b) => a - b)
    if (times.length === 0) return true
    const chapterStarts = times[0] === 0 ? times : [0, ...times]
    if (chapterStarts.length < 3) return false
    return chapterStarts.every(
      (time, index) => index === 0 || time - chapterStarts[index - 1]! >= 10_000,
    )
  }, [timeline])

  function commitLabel() {
    if (cancelLabelEditRef.current) {
      cancelLabelEditRef.current = false
      return
    }
    const nextLabel = markerLabel.trim()
    if (!nextLabel) {
      setMarkerLabel(marker.label)
      return
    }
    if (nextLabel !== marker.label) {
      execute(createUpdateMarkerCommand(marker.id, { label: nextLabel }))
    }
  }

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
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              event.currentTarget.blur()
            } else if (event.key === "Escape") {
              event.preventDefault()
              cancelLabelEditRef.current = true
              setMarkerLabel(marker.label)
              event.currentTarget.blur()
            }
          }}
          onBlur={commitLabel}
        />
        <div className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
          <span>Marker color</span>
          <ColorPicker
            aria-label="Marker color"
            size="sm"
            value={marker.color}
            onChange={(color) => execute(createUpdateMarkerCommand(marker.id, { color }))}
          />
        </div>
        <NumberInputField
          label="Marker time"
          unit="ms"
          min={0}
          max={mediaEndMs > 0 ? mediaEndMs : undefined}
          step={100}
          value={marker.timeMs}
          onChange={(timeMs) => execute(createUpdateMarkerCommand(marker.id, { timeMs }))}
        />
        <p className="font-mono text-xs tabular-nums text-subtle-foreground">
          {formatTimelineTime(marker.timeMs)}
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
        {!chaptersMeetYouTubeRules ? (
          <p className="text-[11px] leading-relaxed text-subtle-foreground">
            YouTube shows chapters only with 3+ markers spaced at least 10 seconds apart.
          </p>
        ) : null}
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
