import { useEffect, useState } from "react"
import { Crop, Mic, Monitor, MonitorUp, Video, Volume2 } from "lucide-react"
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
  Switch,
} from "@recordforge/ui"
import type { RecordingConfig } from "@recordforge/contracts"
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
  const {
    sources,
    audioDevices,
    videoDevices,
    profiles,
    selectedSource,
    selectedProfileId,
    selectedMicrophoneId,
    selectedSystemAudioId,
    selectedWebcamId,
    error,
    setSelectedSource,
    setSelectedProfileId,
    setSelectedMicrophoneId,
    setSelectedSystemAudioId,
    setSelectedWebcamId,
    loadSources,
    loadAudioDevices,
    loadVideoDevices,
    loadProfiles,
    clearError,
  } = useRecorderStore()

  const [selectedSourceType, setSelectedSourceType] = useState<"screen" | "window" | "region">(
    "screen",
  )
  const [audioLevel, setAudioLevel] = useState(0.45)

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
    if (enabled) {
      const defaultMic = selectedMicrophoneId || microphones[0]?.id
      if (defaultMic) {
        setSelectedMicrophoneId(defaultMic)
      }
    } else {
      setSelectedMicrophoneId("")
    }
  }

  function handleSystemAudioToggle(enabled: boolean) {
    if (enabled) {
      const defaultSys = selectedSystemAudioId || systemAudios[0]?.id
      if (defaultSys) {
        setSelectedSystemAudioId(defaultSys)
      }
    } else {
      setSelectedSystemAudioId("")
    }
  }

  function handleWebcamToggle(enabled: boolean) {
    if (enabled) {
      const defaultCam = selectedWebcamId || webcams[0]?.id
      if (defaultCam) {
        setSelectedWebcamId(defaultCam)
      }
    } else {
      setSelectedWebcamId("")
    }
  }

  function handleSourceTypeChange(type: "screen" | "window" | "region") {
    setSelectedSourceType(type)
    if (type === "screen") {
      const display = displaySources[0] || sources.find((s) => s.kind === "display")
      if (display) setSelectedSource(display)
    } else if (type === "window") {
      const window = windowSources[0] || sources.find((s) => s.kind === "window")
      if (window) setSelectedSource(window)
    }
  }

  function handleStartRecording() {
    if (!selectedSource && sources.length > 0) {
      setSelectedSource(sources[0])
    }
    // Close the modal first, then defer the start command one tick so React
    // can unmount the live webcam preview and release the camera before Rust
    // tries to open the same DirectShow device.
    onClose()
    setTimeout(() => onStart(), 0)
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
                    <span className="truncate">
                      {selectedSourceType === "region"
                        ? `Custom Region (${selectedDisplayResolution})`
                        : selectedSource?.name || "Display 1"}{" "}
                      ({selectedDisplayResolution})
                    </span>
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
                  windowSources.length > 0 ? (
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
              </div>

              {/* Quality Profile Select */}
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="modal-quality-profile"
                  className="font-label text-xs font-bold tracking-wider uppercase text-subtle-foreground"
                >
                  Quality Profile
                </label>
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
                        {micEnabled
                          ? microphones.find((m) => m.id === selectedMicrophoneId)?.name ||
                            microphones[0]?.name ||
                            "Default Microphone"
                          : "Disabled"}
                      </div>
                    </div>
                  </div>
                  <Switch checked={micEnabled} onCheckedChange={handleMicToggle} />
                </div>

                {micEnabled ? (
                  <div className="flex flex-col gap-2 border-t border-border/40 pt-2.5 min-w-0">
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
                        {systemAudioEnabled
                          ? systemAudios.find((s) => s.id === selectedSystemAudioId)?.name ||
                            "Default System Audio"
                          : "Disabled"}
                      </div>
                    </div>
                  </div>
                  <Switch checked={systemAudioEnabled} onCheckedChange={handleSystemAudioToggle} />
                </div>

                {systemAudioEnabled && systemAudios.length > 1 ? (
                  <div className="border-t border-border/40 pt-2.5 min-w-0">
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
                        {webcamEnabled
                          ? webcams.find((w) => w.id === selectedWebcamId)?.name || "Default Camera"
                          : "Disabled"}
                      </div>
                    </div>
                  </div>
                  <Switch checked={webcamEnabled} onCheckedChange={handleWebcamToggle} />
                </div>

                {webcamEnabled ? (
                  <div className="flex flex-col gap-2.5 border-t border-border/40 pt-2.5 min-w-0">
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

                    <div className="relative flex h-24 w-full items-center justify-center overflow-hidden rounded-md border border-border bg-background">
                      <div className="absolute bottom-2 right-2 z-10 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white font-medium truncate max-w-[80%]">
                        {webcams.find((w) => w.id === selectedWebcamId)?.name || "Camera Active"}
                      </div>
                      <WebcamPreview
                        deviceName={
                          webcams.find((w) => w.id === selectedWebcamId)?.name ||
                          selectedWebcamId
                        }
                      />
                    </div>
                  </div>
                ) : null}
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
              className="flex items-center gap-3 rounded-lg bg-recording px-5 py-2 text-xs font-semibold text-white shadow-lg transition-all hover:bg-recording-hover cursor-pointer"
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
