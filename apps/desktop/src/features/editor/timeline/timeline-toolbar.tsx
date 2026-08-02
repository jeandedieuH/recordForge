import { Button } from "@recordforge/ui"
import { formatTime } from "@recordforge/editor-core"
import { useTimelineStore } from "../../../stores/timeline-store"

// Toolbar for playback, undo/redo, zoom and export.
export function TimelineToolbar() {
  const store = useTimelineStore()
  const engine = store.engine
  const view = store.view

  const canUndo = engine ? engine.history.past.length > 0 : false
  const canRedo = engine ? engine.history.future.length > 0 : false

  function handlePlayPause() {
    store.togglePlay()
  }

  function handleUndo() {
    store.undo()
  }

  function handleRedo() {
    store.redo()
  }

  function handleZoomIn() {
    store.setZoom(view.zoom / 1.25)
  }

  function handleZoomOut() {
    store.setZoom(view.zoom * 1.25)
  }

  function handleFit() {
    if (!engine || view.durationMs <= 0) return
    const containerWidth = Math.max(320, window.innerWidth - 64)
    store.setZoom(view.durationMs / containerWidth)
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted p-2">
      <Button variant={view.isPlaying ? "secondary" : "primary"} onClick={handlePlayPause}>
        {view.isPlaying ? "Pause" : "Play"}
      </Button>

      <div className="min-w-30 text-sm tabular-nums">
        {formatTime(view.playheadMs)} / {formatTime(view.durationMs)}
      </div>

      <Button variant="ghost" onClick={handleUndo} disabled={!canUndo}>
        Undo
      </Button>
      <Button variant="ghost" onClick={handleRedo} disabled={!canRedo}>
        Redo
      </Button>

      <div className="ml-auto flex items-center gap-2">
        <Button variant="ghost" onClick={handleZoomOut}>
          -
        </Button>
        <span className="w-16 text-center text-xs text-foreground/70">
          {Math.round(view.zoom)} ms/px
        </span>
        <Button variant="ghost" onClick={handleZoomIn}>
          +
        </Button>
        <Button variant="ghost" onClick={handleFit}>
          Fit
        </Button>
      </div>
    </div>
  )
}
