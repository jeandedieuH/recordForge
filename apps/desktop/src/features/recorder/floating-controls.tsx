import { useEffect, useState } from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import {
  AppWindow,
  ChevronLeft,
  ChevronsDown,
  ChevronsUp,
  CircleAlert,
  Flag,
  Loader2,
  Minimize2,
  MoreVertical,
  Pause,
  Play,
  Square,
  Trash2,
  Video,
} from "lucide-react"
import { Button, IconButton } from "@recordforge/ui"
import {
  hideFloatingControls,
  hideWebcamPreview,
  openWebcamPreview,
  setFloatingControlsCompact,
  showMainWindow,
} from "../../lib/recorder"
import { isTauri, getSetting, setSetting } from "../../lib/settings"
import { MODIFIER_NAME } from "../../lib/platform"
import { toErrorMessage } from "../../lib/errors"
import { useRecorderStore, useRecorderPolling } from "../../hooks/use-recorder"
import { useAudioLevelEvents } from "./hud/use-audio-level-events"
import { useHudWarnings } from "./hud/use-hud-warnings"
import { hudSourceLabel } from "./hud/hud-eval"
import { HudMicMeter } from "./hud/hud-mic-meter"

function formatDuration(ms: number) {
  const seconds = Math.floor((ms / 1000) % 60)
  const minutes = Math.floor((ms / 1000 / 60) % 60)
  const hours = Math.floor(ms / 1000 / 60 / 60)
  return [hours, minutes, seconds].map((v) => v.toString().padStart(2, "0")).join(":")
}

// Compact draggable toolbar shown in the separate floating Tauri window. A
// single row keeps the timer and transport visible without covering the app
// being recorded; source and inputs live in tooltips and the actions panel.
export function FloatingControls() {
  useRecorderPolling()
  // Feeds the live mic meter; mounted only in this window.
  useAudioLevelEvents()
  const { warning, dismiss: dismissWarning } = useHudWarnings()

  const {
    status,
    markers,
    pendingAction,
    finalizationProgress,
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
  const [cameraPreviewOpen, setCameraPreviewOpen] = useState(true)
  // One-time pointer to the drag handle and the marker shortcut — the toolbar
  // is the only recording UI once the setup dialog closes, so its affordances
  // have to be discoverable at least once.
  const [showHint, setShowHint] = useState(false)
  // Compact mode is persisted because it is a working-style preference: people
  // who record a lot want the smallest possible overlay every time.
  const [compact, setCompact] = useState(false)

  useEffect(() => {
    if (!isTauri()) return
    void getSetting("floatingCompact").then((value) => {
      if (value !== "true") return
      // Resize first: the window is not click-through, so the DOM and the
      // native bounds must agree before the compact pill paints.
      void setFloatingControlsCompact(true)
        .then(() => setCompact(true))
        .catch(() => {})
    })
  }, [])

  async function applyCompact(next: boolean) {
    try {
      await setFloatingControlsCompact(next)
      setCompact(next)
      void setSetting("floatingCompact", String(next))
    } catch (error) {
      useRecorderStore.setState({ error: toErrorMessage(error) })
    }
  }

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    void getSetting("floatingHintSeen").then((value) => {
      if (cancelled || value === "true") return
      setShowHint(true)
      void setSetting("floatingHintSeen", "true")
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!showHint) return
    const timer = window.setTimeout(() => setShowHint(false), 9_000)
    return () => window.clearTimeout(timer)
  }, [showHint])

  async function handleToggleCameraPreview() {
    try {
      if (cameraPreviewOpen) {
        await hideWebcamPreview()
        setCameraPreviewOpen(false)
      } else {
        await openWebcamPreview()
        setCameraPreviewOpen(true)
      }
    } catch (error) {
      // Backend rejections (e.g. preview disabled for this recording) surface
      // through the shared store so the banner shows the real reason.
      useRecorderStore.setState({ error: toErrorMessage(error) })
    }
  }

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
  const isFinalizing =
    pendingAction === "stop" || status?.state === "finalizing" || Boolean(finalizationProgress)
  const duration = status?.recordedMs ?? 0
  const sourceLabel = hudSourceLabel(status)
  const stageLabel = finalizationProgress?.stageLabel || "Assembling video…"
  const progressPercent = Math.max(8, Math.min(100, finalizationProgress?.percent ?? 15))

  async function handleMarker() {
    // Empty label: the Rust side auto-numbers it ("Marker N") so button,
    // global-shortcut, and tray markers all share one naming scheme.
    await addMarker("")
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
    // Single row: the old two-line block assumed the 620px toolbar. The
    // consequence copy moves into the destructive button's tooltip so the
    // decision still has its warning without a second text line.
    return (
      <div className="flex h-full w-full items-center justify-center p-1.5 select-none">
        <div
          className="animate-in fade-in-0 flex h-full w-full items-center gap-2 overflow-hidden rounded-2xl border border-recording/40 bg-surface/95 px-2.5 shadow-e1 backdrop-blur-xl duration-fast"
          role="alertdialog"
          aria-label="Discard recording? Video, audio, and markers are permanently deleted."
        >
          <Trash2 className="size-4 shrink-0 text-recording" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-foreground">
            Discard recording?
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={pendingAction === "discard"}
            onClick={() => setDiscardConfirming(false)}
            title="Keep recording (Esc)"
            className="h-7 shrink-0 px-2.5 text-xs"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            loading={pendingAction === "discard"}
            onClick={() => void handleDiscard()}
            title="Permanently deletes the video, audio, and markers. Nothing is saved."
            className="h-7 shrink-0 gap-1.5 bg-recording px-2.5 text-xs text-white hover:bg-recording-hover"
          >
            Delete
          </Button>
        </div>
      </div>
    )
  }

  // Compact pill: timer + transport only, for people who keep the toolbar up
  // over the app they are recording. The native window is resized with it.
  if (compact) {
    return (
      <div className="flex h-full w-full items-center justify-center p-1.5 select-none">
        <div className="animate-in zoom-in-95 fade-in-0 flex h-full w-full items-center gap-2 rounded-2xl border border-border-strong/90 bg-surface/95 px-2.5 shadow-e1 backdrop-blur-xl duration-base">
          <div
            data-tauri-drag-region
            className="flex min-w-0 cursor-grab items-center gap-2 active:cursor-grabbing"
            title="Drag to move toolbar"
            onMouseDown={handleDragStart}
          >
            {isFinalizing ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin text-recording" aria-hidden />
            ) : (
              <span
                className={`size-2.5 shrink-0 rounded-full ${
                  isRecording
                    ? "animate-rec-pulse bg-recording"
                    : isPaused
                      ? "bg-warning"
                      : "bg-muted-foreground/50"
                }`}
                aria-hidden
              />
            )}
            <span
              className="tnum truncate font-mono text-sm font-semibold leading-none text-foreground"
              data-testid="floating-timer"
            >
              {isFinalizing ? `${finalizationProgress?.percent ?? 15}%` : formatDuration(duration)}
            </span>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            {error || status?.error ? (
              <IconButton
                label="Show recording details"
                onClick={() => void applyCompact(false)}
                className="text-recording hover:bg-recording/10"
              >
                <CircleAlert className="size-3.5" />
              </IconButton>
            ) : null}
            <IconButton
              label={isRecording ? "Pause" : "Resume"}
              variant="outline"
              className="text-foreground"
              disabled={!isActive || pendingAction != null}
              loading={pendingAction === (isRecording ? "pause" : "resume")}
              onClick={isRecording ? pause : resume}
            >
              {isRecording ? (
                <Pause className="size-4" />
              ) : (
                <Play className="size-4 fill-current" />
              )}
            </IconButton>
            <Button
              size="icon"
              variant="destructive"
              aria-label="Stop & save"
              title="Stop & save recording"
              disabled={!isActive || pendingAction != null}
              onClick={stop}
              className="size-8 [&_svg]:size-4"
            >
              {pendingAction === "stop" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Square className="size-3.5 fill-current" />
              )}
            </Button>
            <IconButton label="Expand toolbar" onClick={() => void applyCompact(false)}>
              <ChevronsUp className="size-3.5" />
            </IconButton>
          </div>
        </div>
      </div>
    )
  }

  // One compact line: alert (only when something is wrong), transport, more,
  // hide. Marker count rides next to the timer so no second row is needed.
  const alertMessage = error ?? status?.error ?? warning?.message ?? null
  const alertIsError = Boolean(error || status?.error)
  const dismissAlert = () => {
    if (error) clearError()
    else if (warning) dismissWarning()
  }
  const dragTooltip = showHint
    ? `Drag to move · ${MODIFIER_NAME}+Shift+M marker`
    : `${sourceLabel.state} · ${sourceLabel.name}${status?.webcamActive ? " · camera" : ""}`

  return (
    <div className="flex h-full w-full items-center justify-center p-1.5 select-none">
      <div className="animate-in fade-in-0 slide-in-from-bottom-2 flex h-full w-full items-center gap-2 overflow-hidden rounded-2xl border border-border-strong/90 bg-surface/95 px-2.5 shadow-e1 backdrop-blur-xl duration-base">
        {isFinalizing ? (
          /* Finalization: stage label + percentage bar fill the row. */
          <div
            data-tauri-drag-region
            className="flex min-w-0 flex-1 cursor-grab items-center gap-2 active:cursor-grabbing"
            title="Finalizing recording…"
            onMouseDown={handleDragStart}
          >
            <Loader2 className="size-3.5 shrink-0 animate-spin text-recording" aria-hidden />
            <div data-tauri-drag-region className="min-w-0 flex-1">
              <div data-tauri-drag-region className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[11px] font-semibold text-foreground">
                  {stageLabel}
                </span>
                <span className="tnum shrink-0 font-mono text-[10px] font-medium text-muted-foreground">
                  {finalizationProgress ? `${finalizationProgress.percent}%` : "15%"}
                </span>
              </div>
              <div
                data-tauri-drag-region
                className="mt-1 h-1 w-full overflow-hidden rounded-full border border-border/40 bg-overlay"
              >
                <div
                  className="h-full rounded-full bg-recording transition-all duration-300 ease-out"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          </div>
        ) : (
          /* State dot + timer + live mic meter. The whole strip is the window
             drag handle; source and inputs are in its tooltip, so no label row. */
          <div
            data-tauri-drag-region
            className="flex min-w-0 flex-1 cursor-grab items-center gap-2 active:cursor-grabbing"
            title={dragTooltip}
            onMouseDown={handleDragStart}
          >
            <span
              data-tauri-drag-region
              className={`size-2.5 shrink-0 rounded-full ${
                isRecording
                  ? "animate-rec-pulse bg-recording"
                  : isPaused
                    ? "bg-warning"
                    : "bg-muted-foreground/50"
              }`}
              aria-hidden
            />
            <span
              data-tauri-drag-region
              className={`tnum font-mono text-base font-semibold leading-none tracking-tight ${
                isPaused ? "text-warning" : "text-foreground"
              }`}
              data-testid="floating-timer"
            >
              {formatDuration(duration)}
            </span>
            <HudMicMeter visible={Boolean(status?.microphoneActive) && isRecording} />
            {markers.length > 0 ? (
              <span
                className="flex shrink-0 items-center gap-0.5 text-[10px] font-medium text-muted-foreground"
                title={`${markers.length} marker${markers.length === 1 ? "" : "s"} placed`}
              >
                <Flag className="size-2.5" aria-hidden />
                <span className="tnum">{markers.length}</span>
              </span>
            ) : null}
          </div>
        )}

        {/* Actions */}
        {moreActionsOpen ? (
          /* Inline Secondary Actions */
          <div className="flex shrink-0 animate-in items-center gap-0.5 fade-in-0 slide-in-from-right-2 duration-150">
            <Button
              size="icon"
              variant="ghost"
              title="Open RecordForge main window"
              aria-label="Open RecordForge"
              onClick={() => void showMainWindow()}
              className="size-7 [&_svg]:size-3.5"
            >
              <AppWindow />
            </Button>

            {status?.webcamActive && status?.webcamPreviewUrl ? (
              <Button
                size="icon"
                variant="ghost"
                title={cameraPreviewOpen ? "Hide camera preview" : "Show camera preview"}
                aria-label={cameraPreviewOpen ? "Hide camera preview" : "Show camera preview"}
                onClick={() => void handleToggleCameraPreview()}
                className="size-7 [&_svg]:size-3.5"
              >
                <Video />
              </Button>
            ) : null}

            {isActive ? (
              <Button
                size="icon"
                variant="ghost"
                title="Discard recording…"
                aria-label="Discard recording"
                disabled={pendingAction != null}
                className="size-7 text-recording hover:bg-recording/10 hover:text-recording [&_svg]:size-3.5"
                onClick={() => setDiscardConfirming(true)}
              >
                <Trash2 />
              </Button>
            ) : null}

            <Button
              size="icon"
              variant="ghost"
              title="Compact toolbar"
              aria-label="Compact toolbar"
              onClick={() => void applyCompact(true)}
              className="size-7 [&_svg]:size-3.5"
            >
              <Minimize2 />
            </Button>

            <Button
              size="icon"
              variant="ghost"
              title="Hide this toolbar"
              aria-label="Hide this toolbar"
              onClick={() => void hideFloatingControls()}
              className="size-7 [&_svg]:size-3.5"
            >
              <ChevronsDown />
            </Button>

            <div className="mx-0.5 h-4 w-px bg-border" aria-hidden />

            <Button
              size="icon"
              variant="outline"
              title="Back to recording controls (Esc)"
              aria-label="Back to recording controls"
              onClick={() => setMoreActionsOpen(false)}
              className="size-7 [&_svg]:size-3.5"
            >
              <ChevronLeft />
            </Button>
          </div>
        ) : (
          /* Primary Transport Controls */
          <div className="flex shrink-0 items-center gap-0.5">
            {alertMessage ? (
              <IconButton
                label={alertMessage}
                onClick={dismissAlert}
                className={`size-7 [&_svg]:size-3.5 ${
                  alertIsError
                    ? "text-recording hover:bg-recording/10"
                    : "text-warning hover:bg-warning/10"
                }`}
              >
                <CircleAlert />
              </IconButton>
            ) : null}

            <Button
              size="icon"
              variant="ghost"
              title={`Add marker (${MODIFIER_NAME}+Shift+M)`}
              aria-label="Add marker"
              disabled={!isActive || pendingAction != null}
              onClick={handleMarker}
              className="size-7 [&_svg]:size-3.5"
            >
              <Flag />
            </Button>

            <Button
              size="icon"
              variant="outline"
              title={
                isRecording
                  ? `Pause (${MODIFIER_NAME}+Shift+P)`
                  : `Resume (${MODIFIER_NAME}+Shift+P)`
              }
              aria-label={isRecording ? "Pause" : "Resume"}
              disabled={!isActive || pendingAction != null}
              loading={pendingAction === (isRecording ? "pause" : "resume")}
              onClick={isRecording ? pause : resume}
              className="size-7 [&_svg]:size-3.5"
            >
              {isRecording ? <Pause className="fill-current" /> : <Play className="fill-current" />}
            </Button>

            <Button
              size="icon"
              variant="destructive"
              title="Stop & save recording"
              aria-label="Stop & save"
              disabled={!isActive || pendingAction != null}
              onClick={stop}
              className="size-7 [&_svg]:size-3.5"
            >
              {pendingAction === "stop" ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Square className="fill-current" />
              )}
            </Button>

            <Button
              size="icon"
              variant="ghost"
              title="More actions"
              aria-label="More actions"
              disabled={pendingAction != null}
              onClick={() => setMoreActionsOpen(true)}
              className="size-7 [&_svg]:size-3.5"
            >
              <MoreVertical />
            </Button>

            <Button
              size="icon"
              variant="ghost"
              title="Hide this toolbar"
              aria-label="Hide this toolbar"
              onClick={() => void hideFloatingControls()}
              className="size-7 text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
            >
              <ChevronsDown />
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
