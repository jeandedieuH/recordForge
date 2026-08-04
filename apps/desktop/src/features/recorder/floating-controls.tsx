import { useEffect } from "react"
import { CircleAlert, Flag, GripHorizontal, Pause, Play, Radio, Square, X } from "lucide-react"
import { IconButton, TooltipProvider } from "@recordforge/ui"
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
  const stateLabel = isRecording ? "Recording" : isPaused ? "Paused" : "Ready"

  async function handleMarker() {
    await addMarker("Marker")
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full w-full items-center justify-center px-2 py-1.5 select-none">
        <div className="flex h-full w-full items-center gap-3 overflow-hidden rounded-xl border border-border-strong/80 bg-surface/95 px-2 shadow-e3 backdrop-blur-xl">
          <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2.5 pl-1.5">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-recording/30 bg-recording/15 text-recording">
              <Radio className="size-4" aria-hidden />
            </div>

            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <span
                  className={`size-1.5 rounded-full ${
                    isRecording
                      ? "animate-rec-pulse bg-recording"
                      : isPaused
                        ? "bg-warning"
                        : "bg-muted-foreground"
                  }`}
                />
                <span>{stateLabel}</span>
                <span className="text-subtle-foreground">·</span>
                <span className="truncate font-normal text-muted-foreground">Screen capture</span>
              </div>
              <div
                className="tnum font-mono text-xl font-semibold leading-none tracking-tight text-foreground"
                data-testid="floating-timer"
              >
                {formatDuration(duration)}
              </div>
            </div>

            <GripHorizontal
              className="ml-auto size-4 shrink-0 text-subtle-foreground/70"
              aria-hidden
            />
          </div>

          <div className="h-7 w-px shrink-0 bg-border" />

          <div className="flex shrink-0 items-center gap-1">
            <IconButton
              label="Add marker"
              tooltipSide="top"
              disabled={!isActive || pendingAction != null}
              onClick={handleMarker}
            >
              <Flag />
            </IconButton>

            <IconButton
              label={isRecording ? "Pause recording" : "Resume recording"}
              tooltipSide="top"
              variant="secondary"
              disabled={!isActive || pendingAction != null}
              loading={pendingAction === (isRecording ? "pause" : "resume")}
              onClick={isRecording ? pause : resume}
            >
              {isRecording ? <Pause /> : <Play />}
            </IconButton>

            <IconButton
              label="Stop recording"
              tooltipSide="top"
              variant="destructive"
              disabled={!isActive || pendingAction != null}
              loading={pendingAction === "stop"}
              onClick={stop}
            >
              <Square className="fill-current" />
            </IconButton>
          </div>

          {error ? (
            <div
              className="flex min-w-0 max-w-48 items-center gap-1.5 rounded-lg border border-recording/30 bg-recording/10 px-2 text-recording"
              role="alert"
              title={error}
            >
              <CircleAlert className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate text-xs">{error}</span>
              <IconButton label="Dismiss error" tooltipSide="top" onClick={clearError}>
                <X />
              </IconButton>
            </div>
          ) : null}

          {markers.length > 0 ? (
            <div
              className="flex shrink-0 items-center gap-1 rounded-md bg-overlay px-2 py-1 text-xs font-medium text-muted-foreground"
              title={`${markers.length} marker${markers.length === 1 ? "" : "s"}`}
            >
              <Flag className="size-3.5" aria-hidden />
              <span className="tnum">{markers.length}</span>
            </div>
          ) : null}
        </div>
      </div>
    </TooltipProvider>
  )
}
