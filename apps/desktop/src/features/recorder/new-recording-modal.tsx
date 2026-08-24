import { useEffect, useState } from "react"
import { listen } from "@tauri-apps/api/event"
import { Crop, Mic, Monitor, MonitorUp, Pencil, Sparkles, Video, Volume2, X } from "lucide-react"
import {
  AudioLevelMeter,
  Button,
  Dialog,
  DialogContent,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  useToast,
} from "@recordforge/ui"
import type { Bounds, RecordingConfig } from "@recordforge/contracts"
import { boundsSchema } from "@recordforge/contracts"
import { openRegionPicker } from "../../lib/recorder"
import { toErrorMessage } from "../../lib/errors"
import { useRecorderStore } from "../../hooks/use-recorder"
import { WebcamPreview } from "./webcam-preview"

interface NewRecordingModalProps {
  open: boolean
  onClose: () => void
  onStart: () => void
  onNavigateToSettings?: () => void
}

export function NewRecordingModal({
  open,
  onClose,
  onStart,
  onNavigateToSettings,
}: NewRecordingModalProps) {
  const { toast } = useToast()
  const {
    sources,
    sourcesLoaded,
    audioDevices,
    audioDevicesLoaded,
    videoDevices,
    videoDevicesLoaded,
    profiles,
    profilesLoaded,
    selectedSource,
    selectedSourceType,
    selectedProfileId,
    selectedMicrophoneId,
    selectedSystemAudioId,
    selectedWebcamId,
    preferences,
    error,
    setSelectedSource,
    setSelectedSourceType,
    setSelectedProfileId,
    setSelectedMicrophoneId,
    setMicrophoneEnabled,
    setSelectedSystemAudioId,
    setSystemAudioEnabled,
    setSelectedWebcamId,
    setWebcamEnabled,
    loadSources,
    loadAudioDevices,
    loadVideoDevices,
    loadProfiles,
    clearError,
  } = useRecorderStore()

  const [audioLevel, setAudioLevel] = useState(0.45)

  // Clear stale errors when modal opens
  useEffect(() => {
    if (open) {
      clearError()
    }
  }, [open, clearError])

  // The region picker is a separate fullscreen Tauri window; its selection
  // arrives as a `region-selected` event in absolute physical coordinates.
  useEffect(() => {
    if (!open) return
    let unlisten: (() => void) | undefined
    let active = true

    listen<{ bounds: unknown }>("region-selected", (event) => {
      const parsed = boundsSchema.safeParse(event.payload?.bounds)
      if (!parsed.success) return
      const bounds: Bounds = parsed.data
      setSelectedSource({
        kind: "region",
        id: `region-${bounds.x}-${bounds.y}-${bounds.width}-${bounds.height}`,
        name: `Region ${bounds.width}×${bounds.height}`,
        bounds,
      })
    }).then((fn) => {
      if (active) unlisten = fn
      else fn()
    })

    return () => {
      active = false
      unlisten?.()
    }
  }, [open, setSelectedSource])

  function handleOpenRegionPicker() {
    openRegionPicker().catch((error) => {
      toast({ title: "Could not open the region picker", description: toErrorMessage(error) })
    })
  }

  // Load sources, devices, and profiles when the modal opens
  useEffect(() => {
    if (open) {
      void loadSources()
      void loadAudioDevices()
      void loadVideoDevices()
      void loadProfiles()
    }
  }, [open, loadSources, loadAudioDevices, loadVideoDevices, loadProfiles])

  // Filter sources and devices
  const displaySources = sources.filter((s) => s.kind === "display")
  const windowSources = sources.filter((s) => s.kind === "window")
  const microphones = audioDevices.filter((d) => d.kind === "microphone")
  const systemAudios = audioDevices.filter((d) => d.kind === "system")
  const webcams = videoDevices.filter((d) => d.kind === "webcam")

  // Default to primary display source if none selected
  useEffect(() => {
    if (open && !selectedSource && sources.length > 0) {
      const defaultSource = displaySources[0] || sources[0]
      if (defaultSource) setSelectedSource(defaultSource)
    }
  }, [open, selectedSource, sources, displaySources, setSelectedSource])

  // Dynamic audio meter effect when microphone is active
  useEffect(() => {
    if (!selectedMicrophoneId || !open) return
    const interval = setInterval(() => {
      setAudioLevel(0.25 + Math.random() * 0.45)
    }, 250)
    return () => clearInterval(interval)
  }, [selectedMicrophoneId, open])

  // Input states derived from store
  const micEnabled = Boolean(selectedMicrophoneId)
  const systemAudioEnabled = Boolean(selectedSystemAudioId)
  const webcamEnabled = Boolean(selectedWebcamId)

  function handleMicToggle(enabled: boolean) {
    setMicrophoneEnabled(enabled)
  }

  function handleSystemAudioToggle(enabled: boolean) {
    setSystemAudioEnabled(enabled)
  }

  function handleWebcamToggle(enabled: boolean) {
    setWebcamEnabled(enabled)
  }

  function handleSourceTypeChange(type: "screen" | "window" | "region") {
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

  function handleStartRecording() {
    if (selectedSourceType === "region" && !regionSource) return
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

  const selectedDisplayResolution = selectedSource?.bounds
    ? `${selectedSource.bounds.width}×${selectedSource.bounds.height}`
    : "2560×1440"

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="max-w-2xl border border-border-strong bg-surface text-foreground p-0 rounded-xl overflow-hidden shadow-2xl">
          {/* Header - padding-right 12 to make room for Radix native close button */}
          <div className="flex items-center justify-between border-b border-border px-6 py-4 pr-12">
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
              className="mx-6 mt-4 rounded-md border border-red-200 bg-red-50 p-2.5 text-xs text-red-600 dark:border-red-900 dark:bg-red-950 dark:text-red-300 flex items-center justify-between"
            >
              <span>{error}</span>
              <button
                type="button"
                onClick={clearError}
                className="underline text-xs cursor-pointer"
              >
                Dismiss
              </button>
            </div>
          ) : null}

          {/* Modal Body */}
          <div className="grid grid-cols-1 gap-6 p-6 md:grid-cols-2">
            {/* Left Column: VIDEO SOURCE */}
            <div className="flex flex-col gap-4">
              <h3 className="font-label text-xs font-bold tracking-wider uppercase text-subtle-foreground">
                Video Source
              </h3>

              {/* Source Type Switcher Cards */}
              <div className="grid grid-cols-3 gap-2.5">
                <button
                  type="button"
                  onClick={() => handleSourceTypeChange("screen")}
                  className={`flex flex-col items-center justify-center gap-2 rounded-lg border p-3 text-xs font-medium transition-all cursor-pointer ${
                    selectedSourceType === "screen"
                      ? "border-primary bg-primary/20 text-foreground shadow-sm"
                      : "border-border bg-surface-dim text-muted-foreground hover:border-border-strong hover:text-foreground"
                  }`}
                >
                  <Monitor className="size-5" />
                  <span>Entire Screen</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleSourceTypeChange("window")}
                  className={`flex flex-col items-center justify-center gap-2 rounded-lg border p-3 text-xs font-medium transition-all cursor-pointer ${
                    selectedSourceType === "window"
                      ? "border-primary bg-primary/20 text-foreground shadow-sm"
                      : "border-border bg-surface-dim text-muted-foreground hover:border-border-strong hover:text-foreground"
                  }`}
                >
                  <MonitorUp className="size-5" />
                  <span>Window</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleSourceTypeChange("region")}
                  className={`flex flex-col items-center justify-center gap-2 rounded-lg border p-3 text-xs font-medium transition-all cursor-pointer ${
                    selectedSourceType === "region"
                      ? "border-primary bg-primary/20 text-foreground shadow-sm"
                      : "border-border bg-surface-dim text-muted-foreground hover:border-border-strong hover:text-foreground"
                  }`}
                >
                  <Crop className="size-5" />
                  <span>Region</span>
                </button>
              </div>

              {/* Display Preview Thumbnail Container */}
              <div className="flex flex-col gap-1.5">
                <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg border border-border bg-background">
                  <div className="absolute inset-0 opacity-20 bg-[radial-gradient(var(--color-primary)_1px,transparent_1px)] bg-size-[16px_16px]" />
                  <div className="relative z-10 flex flex-col items-center gap-2 rounded-md border border-border-strong bg-surface/90 px-4 py-2 text-xs font-medium text-foreground backdrop-blur text-center max-w-[85%]">
                    {!sourcesLoaded && !selectedSource ? (
                      <Skeleton className="h-4 w-40 rounded" />
                    ) : (
                      <span className="truncate">
                        {selectedSourceType === "region"
                          ? regionSource
                            ? regionSource.name
                            : "No region selected yet"
                          : `${selectedSource?.name || "Display 1"} (${selectedDisplayResolution})`}
                      </span>
                    )}
                  </div>
                </div>

                {/* Source Selector Dropdown if multiple displays or window selection */}
                {selectedSourceType === "screen" && displaySources.length > 1 ? (
                  <Select
                    value={selectedSource?.id || displaySources[0]?.id || ""}
                    onValueChange={(val) => {
                      const source = displaySources.find((s) => s.id === val)
                      if (source) setSelectedSource(source)
                    }}
                  >
                    <SelectTrigger className="border-border bg-surface-dim text-xs text-foreground mt-1">
                      <SelectValue placeholder="Select display" />
                    </SelectTrigger>
                    <SelectContent>
                      {displaySources.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name} ({s.bounds.width}×{s.bounds.height})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}

                {selectedSourceType === "window" ? (
                  !sourcesLoaded ? (
                    <Skeleton className="mt-1 h-9 w-full rounded-md" />
                  ) : windowSources.length > 0 ? (
                    <Select
                      value={selectedSource?.id || windowSources[0]?.id || ""}
                      onValueChange={(val) => {
                        const source = windowSources.find((s) => s.id === val)
                        if (source) setSelectedSource(source)
                      }}
                    >
                      <SelectTrigger className="border-border bg-surface-dim text-xs text-foreground mt-1">
                        <SelectValue placeholder="Select window" />
                      </SelectTrigger>
                      <SelectContent>
                        {windowSources.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <p className="text-[11px] text-subtle-foreground mt-1">
                      No open windows detected.
                    </p>
                  )
                ) : null}

                {selectedSourceType === "region" ? (
                  regionSource ? (
                    <div className="mt-1 flex items-center gap-2 rounded-lg border border-primary/50 bg-primary/10 px-3 py-2">
                      <Crop className="size-4 shrink-0 text-primary" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-semibold text-foreground">
                          {regionSource.bounds.width}×{regionSource.bounds.height} region selected
                        </div>
                        <div className="truncate font-mono text-[10px] text-subtle-foreground">
                          at x={regionSource.bounds.x}, y={regionSource.bounds.y} (physical px)
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleOpenRegionPicker}
                        className="h-7 cursor-pointer gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                      >
                        <Pencil className="size-3" aria-hidden />
                        Redraw
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          const display =
                            displaySources[0] || sources.find((s) => s.kind === "display")
                          if (display) {
                            setSelectedSource(display)
                            setSelectedSourceType("screen")
                          }
                        }}
                        className="h-7 cursor-pointer px-2 text-muted-foreground hover:text-foreground"
                        aria-label="Clear region selection"
                      >
                        <X className="size-3.5" aria-hidden />
                      </Button>
                    </div>
                  ) : (
                    <Button
                      onClick={handleOpenRegionPicker}
                      className="mt-1 flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-border-strong bg-surface-dim px-3 py-3 text-xs font-semibold text-foreground shadow-none transition-all hover:bg-overlay"
                    >
                      <Crop className="size-4 text-primary" aria-hidden />
                      <span>Select Area on Screen</span>
                    </Button>
                  )
                ) : null}
              </div>

              {/* Quality Profile Select */}
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="modal-quality-profile"
                  className="font-label text-xs font-bold tracking-wider uppercase text-subtle-foreground"
                >
                  Quality Profile
                </label>
                {!profilesLoaded && profiles.length === 0 ? (
                  <Skeleton className="h-9 w-full rounded-md" />
                ) : (
                  <Select
                    value={selectedProfileId}
                    onValueChange={(val) => setSelectedProfileId(val as RecordingConfig["profile"])}
                  >
                    <SelectTrigger
                      id="modal-quality-profile"
                      className="border-border bg-surface-dim text-xs text-foreground"
                    >
                      <SelectValue placeholder="Select quality profile" />
                    </SelectTrigger>
                    <SelectContent>
                      {profiles.length > 0 ? (
                        profiles.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.label} ({p.width}×{p.height}, {p.fps}fps)
                          </SelectItem>
                        ))
                      ) : (
                        <SelectItem value="balanced">Balanced (1080p, 30fps)</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>

            {/* Right Column: ADDITIONAL INPUTS */}
            <div className="flex flex-col gap-4">
              <h3 className="font-label text-xs font-bold tracking-wider uppercase text-subtle-foreground">
                Additional Inputs
              </h3>

              {/* Microphone Input Card */}
              <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface-dim p-3.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0 flex-1 pr-2">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-overlay text-muted-foreground">
                      <Mic className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-foreground">Microphone</div>
                      <div className="text-xs text-subtle-foreground truncate">
                        {micEnabled ? (
                          !audioDevicesLoaded ? (
                            <Skeleton className="h-3 w-28 rounded mt-1" />
                          ) : (
                            microphones.find((m) => m.id === selectedMicrophoneId)?.name ||
                            microphones[0]?.name ||
                            "Default Microphone"
                          )
                        ) : (
                          "Disabled"
                        )}
                      </div>
                    </div>
                  </div>
                  <Switch checked={micEnabled} onCheckedChange={handleMicToggle} />
                </div>

                {micEnabled ? (
                  <div className="flex flex-col gap-2 border-t border-border/40 pt-2.5 min-w-0">
                    {!audioDevicesLoaded ? (
                      <Skeleton className="h-9 w-full rounded-md" />
                    ) : (
                      <Select
                        value={selectedMicrophoneId}
                        onValueChange={(val) => setSelectedMicrophoneId(val)}
                      >
                        <SelectTrigger className="w-full min-w-0 border-border bg-surface text-xs text-foreground">
                          <SelectValue placeholder="Select microphone" />
                        </SelectTrigger>
                        <SelectContent>
                          {microphones.length > 0 ? (
                            microphones.map((m) => (
                              <SelectItem key={m.id} value={m.id}>
                                {m.name} {m.isDefault ? "(default)" : ""}
                              </SelectItem>
                            ))
                          ) : (
                            <SelectItem value="default">Default Microphone</SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                    )}

                    <AudioLevelMeter level={audioLevel} className="h-2 rounded bg-background" />
                  </div>
                ) : null}
              </div>

              {/* System Audio Input Card */}
              <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface-dim p-3.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0 flex-1 pr-2">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-overlay text-muted-foreground">
                      <Volume2 className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-foreground">System Audio</div>
                      <div className="text-xs text-subtle-foreground truncate">
                        {systemAudioEnabled ? (
                          !audioDevicesLoaded ? (
                            <Skeleton className="h-3 w-28 rounded mt-1" />
                          ) : (
                            systemAudios.find((s) => s.id === selectedSystemAudioId)?.name ||
                            "Default System Audio"
                          )
                        ) : (
                          "Disabled"
                        )}
                      </div>
                    </div>
                  </div>
                  <Switch checked={systemAudioEnabled} onCheckedChange={handleSystemAudioToggle} />
                </div>

                {systemAudioEnabled && (!audioDevicesLoaded || systemAudios.length > 1) ? (
                  <div className="border-t border-border/40 pt-2.5 min-w-0">
                    {!audioDevicesLoaded ? (
                      <Skeleton className="h-9 w-full rounded-md" />
                    ) : (
                      <Select
                        value={selectedSystemAudioId}
                        onValueChange={(val) => setSelectedSystemAudioId(val)}
                      >
                        <SelectTrigger className="w-full min-w-0 border-border bg-surface text-xs text-foreground">
                          <SelectValue placeholder="Select system audio device" />
                        </SelectTrigger>
                        <SelectContent>
                          {systemAudios.map((s) => (
                            <SelectItem key={s.id} value={s.id}>
                              {s.name} {s.isDefault ? "(default)" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                ) : null}
              </div>

              {/* Webcam Overlay Card */}
              <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface-dim p-3.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0 flex-1 pr-2">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-overlay text-muted-foreground">
                      <Video className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-foreground">Webcam Overlay</div>
                      <div className="text-xs text-subtle-foreground truncate">
                        {webcamEnabled ? (
                          !videoDevicesLoaded ? (
                            <Skeleton className="h-3 w-28 rounded mt-1" />
                          ) : (
                            webcams.find((w) => w.id === selectedWebcamId)?.name || "Default Camera"
                          )
                        ) : (
                          "Disabled"
                        )}
                      </div>
                    </div>
                  </div>
                  <Switch checked={webcamEnabled} onCheckedChange={handleWebcamToggle} />
                </div>

                {webcamEnabled ? (
                  <div className="flex flex-col gap-2.5 border-t border-border/40 pt-2.5 min-w-0">
                    {!videoDevicesLoaded ? (
                      <Skeleton className="h-9 w-full rounded-md" />
                    ) : (
                      <Select
                        value={selectedWebcamId}
                        onValueChange={(val) => setSelectedWebcamId(val)}
                      >
                        <SelectTrigger className="w-full min-w-0 border-border bg-surface text-xs text-foreground">
                          <SelectValue placeholder="Select camera" />
                        </SelectTrigger>
                        <SelectContent>
                          {webcams.length > 0 ? (
                            webcams.map((w) => (
                              <SelectItem key={w.id} value={w.id}>
                                {w.name} {w.isDefault ? "(default)" : ""}
                              </SelectItem>
                            ))
                          ) : (
                            <SelectItem value="default">Integrated Webcam</SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                    )}

                    <div className="relative flex h-24 w-full items-center justify-center overflow-hidden rounded-md border border-border bg-background">
                      {videoDevicesLoaded ? (
                        <div className="absolute bottom-2 right-2 z-10 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white font-medium truncate max-w-[80%]">
                          {webcams.find((w) => w.id === selectedWebcamId)?.name || "Camera Active"}
                        </div>
                      ) : null}
                      <WebcamPreview
                        deviceName={
                          videoDevicesLoaded
                            ? webcams.find((w) => w.id === selectedWebcamId)?.name ||
                              selectedWebcamId
                            : ""
                        }
                      />
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="rounded-lg border border-primary/25 bg-primary/5 p-3.5">
                <div className="flex items-center gap-3">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
                    <Sparkles className="size-4" aria-hidden />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">Smart Zoom</span>
                      <span className="rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                        {preferences.smartZoomEnabled ? "Ready" : "Off"}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-subtle-foreground">
                      {preferences.smartZoomEnabled
                        ? `${preferences.smartZoomPreset} focus ranges will be added to the editor.`
                        : "Enable it in Settings → Recording Defaults."}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Modal Footer */}
          <div className="flex items-center justify-between border-t border-border bg-background px-6 py-4">
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
              onClick={handleStartRecording}
              disabled={selectedSourceType === "region" && !regionSource}
              className="flex items-center gap-3 rounded-lg bg-recording px-5 py-2 text-xs font-semibold text-white shadow-lg transition-all hover:bg-recording-hover cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="size-2 rounded-full bg-white animate-pulse" />
              <span>Start Recording</span>
              <div className="ml-1 flex items-center gap-1 rounded bg-black/20 px-1.5 py-0.5 text-[10px] font-mono text-white/90">
                <span>Ctrl</span>
                <span>Shift</span>
                <span>R</span>
              </div>
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
