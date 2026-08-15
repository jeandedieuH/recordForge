import { useEffect, useState } from "react"
import {
  AppWindow,
  ChevronsDown,
  CircleAlert,
  Eye,
  EyeOff,
  Flag,
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
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  TooltipProvider,
} from "@recordforge/ui"
import {
  hideBoundaryOverlay,
  hideFloatingControls,
  openBoundaryOverlay,
  showMainWindow,
} from "../../lib/recorder"
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

// Compact toolbar shown in the separate floating Tauri window. It keeps the
// timer, live input indicators, and transport controls visible while the user
// is in another app. The whole left side doubles as the drag region.
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

  const [boundaryVisible, setBoundaryVisible] = useState(true)
  // Destructive discard confirms inline: this window is only 88px tall, so a
  // modal dialog would be clipped by the window bounds. Instead the whole
  // toolbar swaps to a confirmation strip until confirmed or cancelled.
  const [discardConfirming, setDiscardConfirming] = useState(false)

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  useEffect(() => {
    if (!discardConfirming) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        setDiscardConfirming(false)
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [discardConfirming])

  const isRecording = status?.state === "recording"
  const isPaused = status?.state === "paused"
  const isActive = isRecording || isPaused
  const duration = status?.recordedMs ?? 0
  const label = stateLabel(status?.state)

  async function handleMarker() {
    await addMarker("Marker")
  }

  async function handleToggleBoundary() {
    if (boundaryVisible) {
      await hideBoundaryOverlay()
      setBoundaryVisible(false)
    } else {
      await openBoundaryOverlay()
      setBoundaryVisible(true)
    }
  }

  async function handleDiscard() {
    await discard()
    setDiscardConfirming(false)
  }

  if (discardConfirming) {
    return (
      <div className="flex h-full w-full items-center justify-center px-2 py-1.5 select-none">
        <div
          className="flex h-full w-full items-center gap-3 overflow-hidden rounded-xl border border-recording/40 bg-surface/95 px-2.5 shadow-e3 backdrop-blur-xl"
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
              <Trash2 aria-hidden />
              Delete everything
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full w-full items-center justify-center px-2 py-1.5 select-none">
        <div className="flex h-full w-full items-center gap-3 overflow-hidden rounded-xl border border-border-strong/80 bg-surface/95 px-2.5 shadow-e3 backdrop-blur-xl">
          {/* Status + timer. Doubles as the window drag region. */}
          <div
            data-tauri-drag-region
            className="flex min-w-0 flex-1 items-center gap-3 pl-1"
            title="Drag to move"
          >
            <div
              className={`flex size-10 shrink-0 items-center justify-center rounded-xl border ${
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

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[11px] font-semibold leading-none text-foreground">
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
              <div className="mt-1 flex items-baseline gap-2">
                <span
                  className="tnum font-mono text-xl font-semibold leading-none tracking-tight text-foreground"
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

          {/* Transport actions */}
          <div className="flex shrink-0 items-center gap-1">
            <IconButton
              label="Add marker"
              shortcut="Ctrl+Shift+M"
              tooltipSide="top"
              disabled={!isActive || pendingAction != null}
              onClick={handleMarker}
            >
              <Flag />
            </IconButton>

            <IconButton
              label={isRecording ? "Pause" : "Resume"}
              shortcut="Ctrl+Shift+P"
              tooltipSide="top"
              variant="secondary"
              disabled={!isActive || pendingAction != null}
              loading={pendingAction === (isRecording ? "pause" : "resume")}
              onClick={isRecording ? pause : resume}
            >
              {isRecording ? <Pause /> : <Play className="fill-current" />}
            </IconButton>

            <IconButton
              label="Stop & save"
              tooltipSide="top"
              variant="destructive"
              disabled={!isActive || pendingAction != null}
              loading={pendingAction === "stop"}
              onClick={stop}
            >
              <Square className="fill-current" />
            </IconButton>
          </div>

          {/* Overflow actions */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label="More actions" tooltipSide="top" disabled={pendingAction != null}>
                <MoreVertical />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end" className="min-w-48">
              <DropdownMenuItem onSelect={() => void showMainWindow()}>
                <AppWindow className="size-4" aria-hidden />
                Open recordForge
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void handleToggleBoundary()}>
                {boundaryVisible ? (
                  <EyeOff className="size-4" aria-hidden />
                ) : (
                  <Eye className="size-4" aria-hidden />
                )}
                {boundaryVisible ? "Hide capture boundary" : "Show capture boundary"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {isActive ? (
                <DropdownMenuItem
                  disabled={pendingAction != null}
                  className="text-recording focus:bg-recording/10 focus:text-recording"
                  onSelect={() => setDiscardConfirming(true)}
                >
                  <Trash2 className="size-4" aria-hidden />
                  Discard recording…
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={() => void hideFloatingControls()}>
                <ChevronsDown className="size-4" aria-hidden />
                Hide this toolbar
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {error ? (
            <div
              className="flex min-w-0 max-w-44 items-center gap-1.5 rounded-lg border border-recording/30 bg-recording/10 px-2 text-recording"
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
        </div>
      </div>
    </TooltipProvider>
  )
}
