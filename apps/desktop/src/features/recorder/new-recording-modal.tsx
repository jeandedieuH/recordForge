import { useEffect, useRef, useState } from "react"
import { AlertTriangle, ScrollText, Settings2, Video } from "lucide-react"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  IconButton,
  Kbd,
  useToast,
} from "@recordforge/ui"
import { openRegionPicker, openTeleprompter } from "../../lib/recorder"
import { toErrorMessage } from "../../lib/errors"
import { isMac } from "../../lib/platform"
import { useRecorderStore } from "../../hooks/use-recorder"
import { useLicenseStore } from "../../stores/license-store"
import { ProBadge } from "../licensing/pro-badge"
import { SourceModeSwitcher, type SourceMode } from "./modal/source-mode-switcher"
import { ScreenSourcePanel } from "./modal/screen-source-panel"
import { AudioInputCards } from "./modal/audio-input-cards"
import { WebcamOverlayCard } from "./modal/webcam-overlay-card"
import { AdvancedSection } from "./modal/advanced-section"
import { CountdownChip } from "./modal/countdown-chip"
import { StartSummary } from "./modal/start-summary"
import { prefetchSourcePreviews } from "./modal/source-preview-cache"
import { CameraSourcePanel, type CameraStartBlocker } from "./camera/camera-source-panel"
import { PermissionsBanner } from "./modal/permissions-banner"
import { useRegionListener } from "./modal/use-region-listener"
import { LOW_DISK_BYTES } from "./camera/camera-quality-picker"
import { useCameraPreview } from "./camera/use-camera-preview"
import { useStorageInfo } from "./camera/use-camera-plans"

interface NewRecordingModalProps {
  open: boolean
  onClose: () => void
  onStart: () => void | Promise<void>
  onNavigateToSettings?: () => void
  // Applied once each time the modal opens (e.g. the titlebar camera button).
  initialSourceType?: "screen" | "camera"
}

export function NewRecordingModal({
  open,
  onClose,
  onStart,
  onNavigateToSettings,
  initialSourceType,
}: NewRecordingModalProps) {
  const { toast } = useToast()
  const isPro = useLicenseStore((state) => state.status.tier === "pro")
  const openUpgradeDialog = useLicenseStore((state) => state.openUpgradeDialog)
  const {
    sources,
    videoDevices,
    videoDevicesLoaded,
    selectedSource,
    selectedSourceType,
    selectedCameraId,
    selectedWebcamId,
    preferences,
    pendingAction,
    error,
    permissions,
    loadCountdownSeconds,
    setSelectedSource,
    setSelectedSourceType,
    loadSources,
    loadAudioDevices,
    loadVideoDevices,
    loadProfiles,
    loadPermissions,
    clearError,
  } = useRecorderStore()

  const cameraMode = selectedSourceType === "camera"
  const webcams = videoDevices.filter((d) => d.kind === "webcam")
  const cameraName = webcams.find((w) => w.id === selectedCameraId)?.name ?? selectedCameraId
  const isStarting = pendingAction === "start"
  const webcamEnabled = Boolean(selectedWebcamId)

  // Local "arming" state covers the gap between the click and the native
  // prepare call: the preview is released here, so the button must acknowledge
  // the click before this dialog unmounts.
  const [arming, setArming] = useState(false)
  const startButtonRef = useRef<HTMLButtonElement>(null)

  // The setup preview lives in the orchestrator so the start flow can
  // `await preview.release()` before FFmpeg grabs the DirectShow device.
  const preview = useCameraPreview({
    deviceName: cameraName,
    enabled: open && cameraMode && !isStarting && !arming,
  })
  const { freeBytes, loaded: storageLoaded } = useStorageInfo()

  // Tracks whether the user picked a mode themselves during the open-cycle
  // loads — an explicit pick beats the `initialSourceType` prop.
  const userPickedMode = useRef(false)

  // Clear stale errors and reset the arming handshake each time the dialog opens.
  useEffect(() => {
    if (open) {
      clearError()
      setArming(false)
    }
  }, [open, clearError])

  useRegionListener(open)

  function handleOpenRegionPicker() {
    openRegionPicker().catch((error) => {
      toast({ title: "Could not open the region picker", description: toErrorMessage(error) })
    })
  }

  // Teleprompter (Pro): capture-protected notes window — the Rust side
  // re-checks the entitlement so this badge is purely informational.
  function handleOpenTeleprompter() {
    if (!isPro) {
      openUpgradeDialog(["teleprompter"])
      return
    }
    openTeleprompter().catch((error) => {
      toast({ title: "Could not open the teleprompter", description: toErrorMessage(error) })
    })
  }

  // Load sources, devices, profiles, and the persisted start delay when the
  // modal opens, then apply `initialSourceType` AFTER the loaders settle —
  // their reconcilers would otherwise overwrite it with the persisted mode.
  // An explicit user pick during the loads wins over the prop.
  useEffect(() => {
    if (!open) {
      userPickedMode.current = false
      return
    }
    let cancelled = false
    void Promise.allSettled([
      loadSources(),
      loadAudioDevices(),
      loadVideoDevices(),
      loadProfiles(),
      loadPermissions(),
      loadCountdownSeconds(),
    ]).then(() => {
      if (!cancelled && initialSourceType && !userPickedMode.current) {
        setSelectedSourceType(initialSourceType)
      }
    })
    return () => {
      cancelled = true
    }
  }, [
    open,
    initialSourceType,
    loadSources,
    loadAudioDevices,
    loadVideoDevices,
    loadProfiles,
    loadPermissions,
    loadCountdownSeconds,
    setSelectedSourceType,
  ])

  const displaySources = sources.filter((s) => s.kind === "display")
  const windowSources = sources.filter((s) => s.kind === "window")

  // Warm the stills for every switchable display in a single native call, so
  // changing monitors does not pay an FFmpeg spawn per click. A single display
  // needs no prefetch — its card requests its own still.
  useEffect(() => {
    if (!open) return
    const displays = sources.filter((source) => source.kind === "display")
    if (displays.length < 2) return
    void prefetchSourcePreviews(displays)
  }, [open, sources])

  // Default to primary display source if none selected
  useEffect(() => {
    if (open && !selectedSource && sources.length > 0) {
      const defaultSource = displaySources[0] || sources[0]
      if (defaultSource) setSelectedSource(defaultSource)
    }
  }, [open, selectedSource, sources, displaySources, setSelectedSource])

  function handleSourceTypeChange(type: SourceMode) {
    userPickedMode.current = true
    setSelectedSourceType(type)
    if (type === "screen") {
      const display =
        (preferences.sourceId && displaySources.find((s) => s.id === preferences.sourceId)) ||
        displaySources[0] ||
        sources.find((s) => s.kind === "display")
      if (display) setSelectedSource(display)
    } else if (type === "window") {
      const window =
        (preferences.sourceId && windowSources.find((s) => s.id === preferences.sourceId)) ||
        windowSources[0] ||
        sources.find((s) => s.kind === "window")
      if (window) setSelectedSource(window)
    } else if (type === "region") {
      if (preferences.regionBounds) {
        setSelectedSource({
          kind: "region",
          id: `region-${preferences.regionBounds.x}-${preferences.regionBounds.y}-${preferences.regionBounds.width}-${preferences.regionBounds.height}`,
          name: `Region ${preferences.regionBounds.width}×${preferences.regionBounds.height}`,
          bounds: preferences.regionBounds,
        })
      }
    }
  }

  const regionSource = selectedSource?.kind === "region" ? selectedSource : null
  const hasMatchingSource =
    (selectedSourceType === "screen" && selectedSource?.kind === "display") ||
    (selectedSourceType === "window" && selectedSource?.kind === "window") ||
    (selectedSourceType === "region" && Boolean(regionSource))

  // Camera-mode start gates: a real device and enough disk (the Rust
  // prepare() enforces the same 1 GiB floor — this mirrors it in the UI).
  const noCamera = videoDevicesLoaded && webcams.length === 0
  const diskBlocked = storageLoaded && freeBytes != null && freeBytes < LOW_DISK_BYTES
  const startBlocker: CameraStartBlocker = noCamera ? "no-camera" : diskBlocked ? "low-disk" : null
  // macOS gate: a missing screen-recording grant makes ffmpeg fail deep in
  // the capture path — block the start and let the banner explain why.
  // `permissions === null` (report still loading) never blocks.
  const screenPermissionBlocked =
    isMac && !cameraMode && permissions != null && permissions.screenRecording !== "granted"
  const canStart = cameraMode
    ? !startBlocker && !isStarting && !arming
    : Boolean(hasMatchingSource) && !isStarting && !arming

  // Why the primary action is unavailable — shown inline instead of hidden in
  // a `title` tooltip, which never appears on a disabled button.
  const blockReason = cameraMode
    ? startBlocker === "no-camera"
      ? "Connect a camera to start"
      : startBlocker === "low-disk"
        ? "Free up at least 1 GB of disk space to start"
        : null
    : screenPermissionBlocked
      ? "Grant Screen Recording permission in System Settings to start"
      : !hasMatchingSource
        ? selectedSourceType === "region"
          ? "Select an area on screen to start"
          : `Choose a ${selectedSourceType} to start`
        : null

  const stageLabel = cameraMode
    ? "Releasing camera…"
    : webcamEnabled
      ? "Releasing webcam…"
      : "Starting…"

  // `start()` reports its own failures through the store; this only covers
  // guard failures that throw (e.g. unsaved editor changes).
  function reportStartFailure(cause: unknown) {
    useRecorderStore.setState({ error: toErrorMessage(cause) })
  }

  async function handleStartRecording() {
    if (!canStart) return
    setArming(true)
    if (cameraMode) {
      // The browser preview holds the DirectShow device — release its tracks
      // and settle BEFORE closing so FFmpeg can open the camera immediately.
      // A failed release must never strand the dialog.
      try {
        await preview.release()
      } catch {
        // Releasing is best-effort; the capture start reports the real error.
      } finally {
        onClose()
        void Promise.resolve(onStart()).catch(reportStartFailure)
      }
      return
    }
    if (webcamEnabled) {
      // Close first so the sidecar preview's tracks are released, then give
      // DirectShow a moment before FFmpeg opens the device.
      onClose()
      await new Promise((resolve) => setTimeout(resolve, 400))
      void Promise.resolve(onStart()).catch(reportStartFailure)
      return
    }
    // No device contention: stay open so "Arming capture…" is visible while
    // the native side creates the session and shows the start capsule.
    try {
      await onStart()
      // `start()` reports failures through the store instead of throwing.
      if (useRecorderStore.getState().error) {
        setArming(false)
        return
      }
      onClose()
    } catch (cause) {
      reportStartFailure(cause)
      setArming(false)
    }
  }

  function handleRefreshCameras() {
    void loadVideoDevices()
    preview.retry()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        // Once a start is committed the preview release must finish; letting
        // Esc close the dialog here would race the capture startup.
        if (!v && !arming) onClose()
      }}
    >
      <DialogContent
        onOpenAutoFocus={(event) => {
          // Land on the primary action so the ↵ hint below is truthful.
          event.preventDefault()
          startButtonRef.current?.focus()
        }}
        className={`flex max-h-[90vh] flex-col gap-0 overflow-hidden rounded-xl border border-border-strong bg-surface p-0 text-foreground shadow-e3 ${
          cameraMode ? "max-w-4xl" : "max-w-3xl"
        }`}
      >
        {/* Header — padding-right leaves room for the Radix close button. */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-6 py-4 pr-14">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-recording/10 text-recording">
              <Video className="size-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <DialogTitle asChild>
                <h2 className="font-serif text-xl font-bold tracking-tight text-foreground">
                  New recording
                </h2>
              </DialogTitle>
              <DialogDescription className="truncate text-xs text-subtle-foreground">
                {cameraMode
                  ? "Check your framing and inputs, then start the take."
                  : "Choose what to capture, confirm the inputs, then start."}
              </DialogDescription>
            </div>
          </div>
          {onNavigateToSettings ? (
            <IconButton
              label="Recording settings"
              onClick={() => {
                onClose()
                onNavigateToSettings()
              }}
              className="shrink-0 text-muted-foreground"
            >
              <Settings2 />
            </IconButton>
          ) : null}
        </div>

        {error ? (
          <div
            role="alert"
            className="mx-6 mt-4 flex shrink-0 items-center justify-between gap-3 rounded-md border border-recording/40 bg-recording/10 px-3 py-2 text-xs text-recording"
          >
            <span className="min-w-0">{error}</span>
            <button
              type="button"
              onClick={clearError}
              className="shrink-0 cursor-pointer underline underline-offset-2"
            >
              Dismiss
            </button>
          </div>
        ) : null}

        {/* Body — the scroll container, so header and footer stay pinned. */}
        <div
          aria-busy={arming}
          className={`flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain p-6 transition-opacity duration-fast ${
            arming ? "pointer-events-none opacity-40" : ""
          }`}
        >
          <PermissionsBanner cameraMode={cameraMode} />
          <SourceModeSwitcher value={selectedSourceType} onChange={handleSourceTypeChange} />

          {cameraMode ? (
            <CameraSourcePanel
              preview={preview}
              blocker={startBlocker}
              freeBytes={freeBytes}
              storageLoaded={storageLoaded}
              onOpenTeleprompter={handleOpenTeleprompter}
              onRefreshDevices={handleRefreshCameras}
            />
          ) : (
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <ScreenSourcePanel onOpenRegionPicker={handleOpenRegionPicker} />
              <div className="flex flex-col gap-4">
                <h3 className="font-label text-xs font-bold tracking-wider uppercase text-subtle-foreground">
                  Additional Inputs
                </h3>
                <AudioInputCards />
                <WebcamOverlayCard isStarting={isStarting || arming} />
              </div>
              <div className="md:col-span-2">
                <AdvancedSection />
              </div>
            </div>
          )}
        </div>

        {/* Footer — summary + start delay above, actions below. */}
        <div className="flex shrink-0 flex-col gap-3 border-t border-border bg-background px-6 py-4">
          <div className="flex items-center justify-between gap-4">
            <StartSummary cameraMode={cameraMode} />
            <CountdownChip />
          </div>

          {blockReason && !arming ? (
            <p role="status" className="flex items-center gap-1.5 text-[11px] text-warning">
              <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
              <span>{blockReason}</span>
            </p>
          ) : null}

          <div className="flex items-center justify-between gap-3">
            <Button
              variant="ghost"
              onClick={handleOpenTeleprompter}
              disabled={arming}
              className="h-8 gap-1.5 px-2.5 text-xs text-muted-foreground"
            >
              <ScrollText className="size-3.5" aria-hidden />
              Teleprompter
              {!isPro ? <ProBadge /> : null}
            </Button>

            <div className="flex items-center gap-2">
              {arming ? (
                <span role="status" className="mr-1 text-[11px] text-muted-foreground">
                  {stageLabel}
                </span>
              ) : null}
              <Button variant="outline" onClick={onClose} disabled={arming} className="h-9 text-xs">
                Cancel
              </Button>
              <Button
                ref={startButtonRef}
                onClick={() => void handleStartRecording()}
                loading={isStarting || arming}
                disabled={!canStart}
                className="h-9 gap-2 px-4 text-xs font-semibold shadow-e1"
              >
                {arming ? null : (
                  <span className="size-2 shrink-0 rounded-full bg-recording" aria-hidden />
                )}
                <span>{arming ? "Starting…" : "Start recording"}</span>
                {arming ? null : <Kbd className="border-white/25 bg-white/15 text-white/80">↵</Kbd>}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
