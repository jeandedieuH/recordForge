import { useEffect, useMemo, useState } from "react"
import {
  createDeleteClipCommand,
  createRippleDeleteClipCommand,
  createSplitClipCommand,
  createTrimClipCommand,
  formatTime,
} from "@recordforge/editor-core"
import { Button, Input } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"

interface ClipInspectorProps {
  clipId: string
  onClear: () => void
}

// Actions and source trim controls for the selected clip.
export function ClipInspector({ clipId, onClear }: ClipInspectorProps) {
  const store = useTimelineStore()
  const view = store.view
  const clip = useMemo(() => {
    for (const track of store.engine?.history.present.tracks ?? []) {
      const found = track.clips.find((c) => c.id === clipId)
      if (found) return found
    }
    return null
  }, [store.engine, clipId])

  const [sourceIn, setSourceIn] = useState("")
  const [sourceOut, setSourceOut] = useState("")

  useEffect(() => {
    if (clip) {
      setSourceIn(String(clip.sourceInMs))
      setSourceOut(String(clip.sourceOutMs))
    }
  }, [clip])

  if (!clip) {
    return <p className="text-sm text-foreground/70">Select a clip to edit.</p>
  }

  const selectedClip = clip

  function handleSplitAtPlayhead() {
    store.execute(createSplitClipCommand(selectedClip.id, view.playheadMs))
    onClear()
  }

  function handleDelete() {
    store.execute(createDeleteClipCommand(selectedClip.id))
    onClear()
  }

  function handleRippleDelete() {
    store.execute(createRippleDeleteClipCommand(selectedClip.id))
    onClear()
  }

  function handleTrim() {
    const start = Number.parseInt(sourceIn, 10)
    const end = Number.parseInt(sourceOut, 10)
    if (Number.isNaN(start) || Number.isNaN(end)) return
    store.execute(createTrimClipCommand(selectedClip.id, start, end))
    onClear()
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted p-4 text-sm">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">
          {clip.kind} clip — {formatTime(clip.startMs)} to{" "}
          {formatTime(clip.startMs + clip.durationMs)}
        </h3>
        <button
          type="button"
          className="text-foreground/60 hover:text-foreground"
          onClick={onClear}
        >
          Close
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={handleSplitAtPlayhead}>Split at playhead</Button>
        <Button variant="secondary" onClick={handleDelete}>
          Delete
        </Button>
        <Button variant="secondary" onClick={handleRippleDelete}>
          Ripple delete
        </Button>
      </div>

      {clip.kind !== "caption" ? (
        <div className="space-y-2">
          <h4 className="text-xs font-medium uppercase text-foreground/70">Source trim</h4>
          <div className="grid grid-cols-2 gap-2">
            <Input
              type="number"
              placeholder="Source in (ms)"
              value={sourceIn}
              onChange={(e) => setSourceIn(e.target.value)}
            />
            <Input
              type="number"
              placeholder="Source out (ms)"
              value={sourceOut}
              onChange={(e) => setSourceOut(e.target.value)}
            />
          </div>
          <Button onClick={handleTrim} variant="secondary">
            Apply trim
          </Button>
        </div>
      ) : null}
    </div>
  )
}
