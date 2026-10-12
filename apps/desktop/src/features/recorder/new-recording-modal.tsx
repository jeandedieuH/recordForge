import { useEffect, useRef } from "react"
import { ScrollText, Video } from "lucide-react"
import { Button, Dialog, DialogContent, useToast } from "@recordforge/ui"
import { openRegionPicker, openTeleprompter } from "../../lib/recorder"
import { toErrorMessage } from "../../lib/errors"
import { isMac, MODIFIER_NAME } from "../../lib/platform"
import { useRecorderStore } from "../../hooks/use-recorder"
import { useLicenseStore } from "../../stores/license-store"
import { ProBadge } from "../licensing/pro-badge"
import { SourceModeSwitcher, type SourceMode } from "./modal/source-mode-switcher"
import { ScreenSourcePanel } from "./modal/screen-source-panel"
import { AudioInputCards } from "./modal/audio-input-cards"
import { WebcamOverlayCard } from "./modal/webcam-overlay-card"
import { ScreenProcessingSection } from "./modal/screen-processing-section"
import { CameraSourcePanel, type CameraStartBlocker } from "./camera/camera-source-panel"
import { PermissionsBanner } from "./modal/permissions-banner"
import { useRegionListener } from "./modal/use-region-listener"
import { LOW_DISK_BYTES } from "./camera/camera-quality-picker"
import { useCameraPreview } from "./camera/use-camera-preview"
import { useStorageInfo } from "./camera/use-camera-plans"

interface NewRecordingModalProps {
  open: boolean
  onClose: () => void
  onStart: () => void
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

  // The setup preview lives in the orchestrator so the start flow can
  // `await preview.release()` before FFmpeg grabs the DirectShow device.
  const preview = useCameraPreview({
    deviceName: cameraName,
    enabled: open && cameraMode && !isStarting,
  })
  const { freeBytes, loaded: storageLoaded } = useStorageInfo()

  // Tracks whether the user picked a mode themselves during the open-cycle
  // loads — an explicit pick beats the `initialSourceType` prop.
  const userPickedMode = useRef(false)

  // Clear stale errors when modal opens
  useEffect(() => {
    if (open) {
      clearError()
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

  // Load sources, devices, and profiles when the modal opens, then apply
  // `initialSourceType` AFTER the loaders settle — their reconcilers would
  // otherwise overwrite it with the persisted mode. An explicit user pick
  // during the loads wins over the prop.
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
    setSelectedSourceType,
  ])

  const displaySources = sources.filter((s) => s.kind === "display")
  const windowSources = sources.filter((s) => s.kind === "window")

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
  const startBlockReason =
    startBlocker === "no-camera"
      ? "Connect a camera to start"
      : startBlocker === "low-disk"
        ? "Free up disk space to start"
        : null
  // macOS gate: a missing screen-recording grant makes ffmpeg fail deep in
  // the capture path — block the start and let the banner explain why.
  // `permissions === null` (report still loading) never blocks.
  const screenPermissionBlocked =
    isMac && !cameraMode && permissions != null && permissions.screenRecording !== "granted"
  const screenBlockReason = screenPermissionBlocked
    ? "Grant Screen Recording permission in System Settings to start"
    : null
  const canStart = cameraMode
    ? !startBlocker && !isStarting
    : Boolean(hasMatchingSource) && !isStarting && !screenPermissionBlocked

  function handleStartRecording() {
    if (!canStart) return
    if (cameraMode) {
      // The browser preview holds the DirectShow device — release its tracks
      // and settle BEFORE closing so FFmpeg can open the camera immediately.
      // A failed release must never strand the dialog.
      void (async () => {
        try {
          await preview.release()
        } finally {
          onClose()
          onStart()
        }
      })()
      return
    }
    if (!selectedSource && sources.length > 0) {
      setSelectedSource(sources[0])
    }
    // Close the modal first, then defer the start command so React can unmount
    // the live webcam preview and the DirectShow device has time to release.
    // A slightly longer delay is used when the webcam is active because
    // getUserMedia tracks can hold the camera for a few hundred milliseconds
    // after they are stopped.
    onClose()
    const startDelay = webcamEnabled ? 500 : 0
    setTimeout(() => onStart(), startDelay)
  }

  function handleRefreshCameras() {
    void loadVideoDevices()
    preview.retry()
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className={`flex max-h-[90vh] flex-col gap-0 overflow-hidden rounded-xl border border-border-strong bg-surface p-0 text-foreground shadow-2xl ${
          cameraMode ? "max-w-4xl" : "max-w-3xl"
        }`}
      >
        {/* Header - padding-right 12 to make room for Radix native close button */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-6 py-4 pr-12">
          <div className="flex items-center gap-2.5">
            <Video className="size-5 text-recording" />
            <h2 className="font-serif text-xl font-bold tracking-tight text-foreground">
              New Recording
            </h2>
          </div>
        </div>

        {error ? (
          <div
            role="alert"
            className="mx-6 mt-4 flex shrink-0 items-center justify-between rounded-md border border-red-200 bg-red-50 p-2.5 text-xs text-red-600 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
          >
            <span>{error}</span>
            <button type="button" onClick={clearError} className="underline text-xs cursor-pointer">
              Dismiss
            </button>
          </div>
        ) : null}

        {/* Modal Body — this area is the scroll container so the header and
            footer stay pinned when the window is shorter than the content. */}
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain p-6">
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
                <WebcamOverlayCard isStarting={isStarting} />
              </div>
              <ScreenProcessingSection />
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex shrink-0 items-center justify-between border-t border-border bg-background px-6 py-4">
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                onClose()
                onNavigateToSettings?.()
              }}
              className="border-border bg-surface-dim text-xs font-medium text-muted-foreground hover:bg-overlay hover:text-foreground cursor-pointer"
            >
              Advanced Settings
            </Button>
            <Button
              variant="secondary"
              onClick={handleOpenTeleprompter}
              className="border-border bg-surface-dim text-xs font-medium text-muted-foreground hover:bg-overlay hover:text-foreground cursor-pointer"
            >
              <ScrollText className="size-3.5" aria-hidden />
              Teleprompter
              {!isPro ? <ProBadge /> : null}
            </Button>
          </div>

          <div className="flex items-center gap-2.5">
            <Button
              onClick={handleStartRecording}
              loading={isStarting}
              disabled={!canStart}
              title={startBlockReason ?? screenBlockReason ?? undefined}
              className="flex items-center gap-3 rounded-lg bg-recording px-5 py-2 text-xs font-semibold text-white shadow-lg transition-all hover:bg-recording-hover cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="size-2 rounded-full bg-white motion-safe:animate-pulse" />
              <span>Start Recording</span>
              <div className="ml-1 flex items-center gap-1 rounded bg-black/20 px-1.5 py-0.5 text-[10px] font-mono text-white/90">
                <span>{MODIFIER_NAME}</span>
                <span>Shift</span>
                <span>R</span>
              </div>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
