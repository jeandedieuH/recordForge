import { useEffect, useState } from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import {
  AppWindow,
  ChevronLeft,
  ChevronsDown,
  CircleAlert,
  Flag,
  GripVertical,
  Mic,
  MoreVertical,
  Pause,
  Play,
  Square,
  Trash2,
  Video,
  Volume2,
  X,
} from "lucide-react"
import { Button } from "@recordforge/ui"
import { hideFloatingControls, showMainWindow } from "../../lib/recorder"
import { isTauri } from "../../lib/settings"
import { useRecorderStore, useRecorderPolling } from "../../hooks/use-recorder"

function formatDuration(ms: number) {
  const seconds = Math.floor((ms / 1000) % 60)
  const minutes = Math.floor((ms / 1000 / 60) % 60)
  const hours = Math.floor(ms / 1000 / 60 / 60)
  return [hours, minutes, seconds].map((v) => v.toString().padStart(2, "0")).join(":")
}

function stateLabel(state: string | undefined) {
  switch (state) {
    case "recording":
      return "Recording"
    case "paused":
      return "Paused"
    case "finalizing":
      return "Saving"
    case "countdown":
      return "Starting"
    default:
      return "Ready"
  }
}

interface InputChipProps {
  icon: React.ReactNode
  label: string
  active: boolean
}

// Compact active-input indicator (mic / system audio / camera) so the user can
// verify at a glance what is being captured without opening the main window.
function InputChip({ icon, label, active }: InputChipProps) {
  if (!active) return null
  return (
    <span
      className="flex size-5 items-center justify-center rounded-md bg-overlay text-muted-foreground"
      title={`Capturing ${label}`}
    >
      {icon}
    </span>
  )
}

// Compact draggable toolbar shown in the separate floating Tauri window. It keeps the
// timer, live input indicators, and transport controls visible while the user
// is in another app. The left grip and status area double as the drag region.
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
    discard,
    addMarker,
    clearError,
  } = useRecorderStore()

  // Destructive discard confirms inline: this window has tight bounds, so a
  // modal dialog would be clipped. The whole toolbar swaps to a confirmation strip.
  const [discardConfirming, setDiscardConfirming] = useState(false)
  // Secondary actions toggle inline inside the toolbar pill to avoid external popup clipping.
  const [moreActionsOpen, setMoreActionsOpen] = useState(false)

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        if (discardConfirming) {
          setDiscardConfirming(false)
        } else if (moreActionsOpen) {
          setMoreActionsOpen(false)
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [discardConfirming, moreActionsOpen])

  const isRecording = status?.state === "recording"
  const isPaused = status?.state === "paused"
  const isActive = isRecording || isPaused
  const duration = status?.recordedMs ?? 0
  const label = stateLabel(status?.state)

  async function handleMarker() {
    await addMarker("Marker")
  }

  async function handleDiscard() {
    await discard()
    setDiscardConfirming(false)
  }

  function handleDragStart(e: React.MouseEvent) {
    if (e.button === 0 && isTauri()) {
      void getCurrentWindow().startDragging()
    }
  }

  if (discardConfirming) {
    return (
      <div className="flex h-full w-full items-center justify-center px-3 py-2 select-none">
        <div
          className="flex h-full w-full items-center gap-3 overflow-hidden rounded-2xl border border-recording/40 bg-surface px-3 shadow-[0_4px_16px_rgba(0,0,0,0.45)]"
          role="alertdialog"
          aria-label="Confirm discard recording"
        >
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-recording/30 bg-recording/15 text-recording">
            <Trash2 className="size-4" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold leading-none text-foreground">
              Discard this recording?
            </div>
            <div className="mt-1 truncate text-[11px] leading-none text-muted-foreground">
              All video, audio, and markers will be permanently deleted. Nothing will be saved.
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={pendingAction === "discard"}
              onClick={() => setDiscardConfirming(false)}
            >
              Cancel
              <kbd className="ml-1 rounded bg-overlay px-1 font-mono text-[9px] text-subtle-foreground">
                Esc
              </kbd>
            </Button>
            <Button
              size="sm"
              loading={pendingAction === "discard"}
              onClick={() => void handleDiscard()}
              className="bg-recording text-white hover:bg-recording-hover"
            >
              <Trash2 className="size-3.5" aria-hidden />
              Delete everything
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full w-full items-center justify-center px-3 py-2 select-none">
      <div className="flex h-full w-full items-center gap-3 overflow-hidden rounded-2xl border border-border-strong/90 bg-surface px-3 shadow-[0_4px_16px_rgba(0,0,0,0.45)]">
        {/* Grip handle + Status + timer. Entire region supports native Tauri window drag. */}
        <div
          data-tauri-drag-region
          className="flex min-w-0 flex-1 cursor-grab active:cursor-grabbing items-center gap-2.5 pl-0.5"
          title="Drag to move toolbar"
          onMouseDown={handleDragStart}
        >
          {/* Visual Grip Handle */}
          <div
            data-tauri-drag-region
            className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground/50 transition-colors hover:text-foreground"
            aria-hidden
          >
            <GripVertical className="size-4" />
          </div>

          <div
            data-tauri-drag-region
            className={`flex size-9 shrink-0 items-center justify-center rounded-xl border ${
              isRecording
                ? "border-recording/30 bg-recording/15 text-recording"
                : isPaused
                  ? "border-warning/30 bg-warning/15 text-warning"
                  : "border-border bg-overlay text-muted-foreground"
            }`}
          >
            {isPaused ? (
              <Pause className="size-4" aria-hidden />
            ) : (
              <span
                className={`size-3 rounded-full ${
                  isRecording ? "animate-rec-pulse bg-recording" : "bg-muted-foreground/50"
                }`}
              />
            )}
          </div>

          <div data-tauri-drag-region className="min-w-0 flex-1">
            <div
              data-tauri-drag-region
              className="flex items-center gap-2 text-[11px] font-semibold leading-none text-foreground"
            >
              <span>{label}</span>
              <span className="text-subtle-foreground">·</span>
              <span className="truncate font-normal text-muted-foreground">
                {status?.sourceName || "Screen capture"}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <InputChip
                  active={!!status?.microphoneActive}
                  label="microphone"
                  icon={<Mic className="size-3" aria-hidden />}
                />
                <InputChip
                  active={!!status?.systemAudioActive}
                  label="system audio"
                  icon={<Volume2 className="size-3" aria-hidden />}
                />
                <InputChip
                  active={!!status?.webcamActive}
                  label="camera"
                  icon={<Video className="size-3" aria-hidden />}
                />
              </span>
            </div>
            <div data-tauri-drag-region className="mt-1 flex items-baseline gap-2">
              <span
                className="tnum font-mono text-lg font-semibold leading-none tracking-tight text-foreground"
                data-testid="floating-timer"
              >
                {formatDuration(duration)}
              </span>
              {markers.length > 0 ? (
                <span
                  className="flex items-center gap-1 rounded-md bg-overlay px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                  title={`${markers.length} marker${markers.length === 1 ? "" : "s"} placed`}
                >
                  <Flag className="size-3" aria-hidden />
                  <span className="tnum">{markers.length}</span>
                </span>
              ) : null}
            </div>
          </div>
        </div>

        {/* Actions Zone */}
        {moreActionsOpen ? (
          /* Inline Secondary Actions */
          <div className="flex shrink-0 items-center gap-1 animate-in fade-in-0 slide-in-from-right-2 duration-150">
            <Button
              size="icon"
              variant="ghost"
              title="Open RecordForge main window"
              aria-label="Open RecordForge"
              onClick={() => void showMainWindow()}
            >
              <AppWindow className="size-4" />
            </Button>

            {isActive ? (
              <Button
                size="icon"
                variant="ghost"
                title="Discard recording…"
                aria-label="Discard recording"
                disabled={pendingAction != null}
                className="text-recording hover:bg-recording/10 hover:text-recording"
                onClick={() => setDiscardConfirming(true)}
              >
                <Trash2 className="size-4" />
              </Button>
            ) : null}

            <Button
              size="icon"
              variant="ghost"
              title="Hide this toolbar"
              aria-label="Hide this toolbar"
              onClick={() => void hideFloatingControls()}
            >
              <ChevronsDown className="size-4" />
            </Button>

            <div className="mx-0.5 h-5 w-px bg-border" aria-hidden />

            <Button
              size="icon"
              variant="secondary"
              title="Back to recording controls (Esc)"
              aria-label="Back to recording controls"
              onClick={() => setMoreActionsOpen(false)}
            >
              <ChevronLeft className="size-4" />
            </Button>
          </div>
        ) : (
          /* Primary Transport Controls */
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              title="Add marker (Ctrl+Shift+M)"
              aria-label="Add marker"
              disabled={!isActive || pendingAction != null}
              onClick={handleMarker}
            >
              <Flag className="size-4" />
            </Button>

            <Button
              size="icon"
              variant="secondary"
              title={isRecording ? "Pause (Ctrl+Shift+P)" : "Resume (Ctrl+Shift+P)"}
              aria-label={isRecording ? "Pause" : "Resume"}
              disabled={!isActive || pendingAction != null}
              loading={pendingAction === (isRecording ? "pause" : "resume")}
              onClick={isRecording ? pause : resume}
            >
              {isRecording ? (
                <Pause className="size-4" />
              ) : (
                <Play className="size-4 fill-current" />
              )}
            </Button>

            <Button
              size="icon"
              variant="destructive"
              title="Stop & save recording"
              aria-label="Stop & save"
              disabled={!isActive || pendingAction != null}
              loading={pendingAction === "stop"}
              onClick={stop}
            >
              <Square className="size-4 fill-current" />
            </Button>

            <Button
              size="icon"
              variant="ghost"
              title="More actions"
              aria-label="More actions"
              disabled={pendingAction != null}
              onClick={() => setMoreActionsOpen(true)}
            >
              <MoreVertical className="size-4" />
            </Button>

            <Button
              size="icon"
              variant="ghost"
              title="Hide this toolbar"
              aria-label="Hide this toolbar"
              onClick={() => void hideFloatingControls()}
            >
              <ChevronsDown className="size-4 text-muted-foreground hover:text-foreground" />
            </Button>
          </div>
        )}

        {/* Error notification banner if any */}
        {error ? (
          <div
            className="flex min-w-0 max-w-44 items-center gap-1.5 rounded-lg border border-recording/30 bg-recording/10 px-2 py-1 text-recording"
            role="alert"
            title={error}
          >
            <CircleAlert className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate text-xs">{error}</span>
            <Button
              size="icon"
              variant="ghost"
              title="Dismiss error"
              aria-label="Dismiss error"
              className="size-5 p-0 text-recording hover:bg-recording/20"
              onClick={clearError}
            >
              <X className="size-3" />
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
