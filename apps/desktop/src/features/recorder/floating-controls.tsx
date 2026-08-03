import { useEffect } from "react"
import { Button } from "@recordforge/ui"
import { useRecorderStore, useRecorderPolling } from "../../hooks/use-recorder"

function formatDuration(ms: number) {
  const seconds = Math.floor((ms / 1000) % 60)
  const minutes = Math.floor((ms / 1000 / 60) % 60)
  const hours = Math.floor(ms / 1000 / 60 / 60)
  return [hours, minutes, seconds].map((v) => v.toString().padStart(2, "0")).join(":")
}

// Compact toolbar shown in the separate floating Tauri window. It keeps the
// timer and transport controls visible while the user is in another app.
export function FloatingControls() {
  useRecorderPolling()

  const {
    status,
    markers,
    pendingAction,
    error,
    refreshStatus,
    pause,
    resume,
    stop,
    addMarker,
    clearError,
  } = useRecorderStore()

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  const isRecording = status?.state === "recording"
  const isPaused = status?.state === "paused"
  const isActive = isRecording || isPaused
  const duration = status?.recordedMs ?? 0

  async function handleMarker() {
    await addMarker("Marker")
  }

  return (
    <div className="flex h-full items-center gap-3 px-3">
      <div className="flex flex-col">
        <span className="text-xs text-foreground/70">{status?.state ?? "idle"}</span>
        <span className="font-mono text-lg font-semibold tabular-nums" data-testid="floating-timer">
          {formatDuration(duration)}
        </span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        {isRecording ? (
          <Button variant="secondary" disabled={pendingAction === "pause"} onClick={pause}>
            {pendingAction === "pause" ? "Pausing…" : "Pause"}
          </Button>
        ) : isPaused ? (
          <Button variant="secondary" disabled={pendingAction === "resume"} onClick={resume}>
            {pendingAction === "resume" ? "Resuming…" : "Resume"}
          </Button>
        ) : null}

        <Button variant="secondary" disabled={!isActive || pendingAction === "stop"} onClick={stop}>
          {pendingAction === "stop" ? "Stopping…" : "Stop"}
        </Button>

        <Button disabled={!isActive || pendingAction != null} onClick={handleMarker}>
          Marker
        </Button>
      </div>

      {error ? (
        <div className="rounded bg-red-100 px-2 py-1 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
          <button type="button" className="ml-1 underline" onClick={clearError}>
            ×
          </button>
        </div>
      ) : null}

      {markers.length > 0 ? (
        <div className="text-xs text-foreground/70" title={markers.map((m) => m.label).join(", ")}>
          {markers.length} marker{markers.length === 1 ? "" : "s"}
        </div>
      ) : null}
    </div>
  )
}
