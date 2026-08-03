import { useEffect, useState, type ReactNode } from "react"
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@recordforge/ui"
import type { RecordingConfig } from "@recordforge/contracts"
import { useRecorderStore } from "../../hooks/use-recorder"
import { openFloatingControls } from "../../lib/recorder"
import { SourcePicker } from "./source-picker"

interface RecorderControlsProps {
  onStart: () => void
}

// Recording controls: source selection, audio/video device options, profile
// picker, and the main transport controls (start/pause/resume/stop/marker).
export function RecorderControls({ onStart }: RecorderControlsProps) {
  const {
    audioDevices,
    audioDevicesLoaded,
    videoDevices,
    videoDevicesLoaded,
    profiles,
    selectedSource,
    selectedProfileId,
    selectedMicrophoneId,
    selectedSystemAudioId,
    selectedWebcamId,
    status,
    pendingAction,
    error,
    setSelectedSource,
    setSelectedProfileId,
    setSelectedMicrophoneId,
    setSelectedSystemAudioId,
    setSelectedWebcamId,
    clearError,
    loadAudioDevices,
    loadVideoDevices,
    loadProfiles,
    pause,
    resume,
    stop,
    addMarker,
  } = useRecorderStore()

  const [markerLabel, setMarkerLabel] = useState("Marker")

  useEffect(() => {
    loadAudioDevices()
    loadVideoDevices()
    loadProfiles()
  }, [loadAudioDevices, loadVideoDevices, loadProfiles])

  const microphones = audioDevices.filter((d) => d.kind === "microphone")
  const systemAudios = audioDevices.filter((d) => d.kind === "system")
  const webcams = videoDevices.filter((d) => d.kind === "webcam")

  const isRecording = status?.state === "recording"
  const isPaused = status?.state === "paused"
  const isActive = isRecording || isPaused
  const canStart = selectedSource && !isActive

  function handleAddMarker() {
    if (!markerLabel.trim()) return
    void addMarker(markerLabel.trim())
  }

  return (
    <div className="flex flex-col gap-4">
      <SourcePicker value={selectedSource} onSelect={setSelectedSource} />

      <section className="grid gap-4 rounded-lg border border-border bg-muted p-4">
        <h2 className="text-sm font-semibold text-foreground">Audio &amp; camera</h2>

        <div className="grid gap-3 sm:grid-cols-2">
          <DeviceField
            id="microphone"
            label="Microphone"
            value={selectedMicrophoneId}
            emptyOptionLabel="No microphone"
            onChange={setSelectedMicrophoneId}
            devices={microphones}
            loaded={audioDevicesLoaded}
            emptyHint="No microphone found. Connect or enable one in Windows Sound settings."
          />
          <DeviceField
            id="system-audio"
            label="System audio"
            value={selectedSystemAudioId}
            emptyOptionLabel="No system audio"
            onChange={setSelectedSystemAudioId}
            devices={systemAudios}
            loaded={audioDevicesLoaded}
            emptyHint="No loopback device found. Enable Stereo Mix (Sound settings → Recording) or install a virtual audio cable such as VB-Audio Virtual Cable."
          />
          <DeviceField
            id="webcam"
            label="Webcam"
            value={selectedWebcamId}
            emptyOptionLabel="No webcam"
            onChange={setSelectedWebcamId}
            devices={webcams}
            loaded={videoDevicesLoaded}
            emptyHint="No webcam found. Connect or enable one in Windows privacy settings."
          />

          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor="profile">
              Recording profile
            </label>
            <Select
              value={selectedProfileId}
              onValueChange={(val) => setSelectedProfileId(val as RecordingConfig["profile"])}
            >
              <SelectTrigger id="profile">
                <SelectValue placeholder="Select recording profile" />
              </SelectTrigger>
              <SelectContent>
                {profiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.label} — {profile.width}×{profile.height}@{profile.fps}fps
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            className="flex-1"
            variant="secondary"
            onClick={() => void openFloatingControls()}
          >
            Floating controls
          </Button>
          <Button
            className="flex-1"
            disabled={!canStart || pendingAction === "start"}
            onClick={onStart}
          >
            {pendingAction === "start" ? "Starting…" : "Start recording"}
          </Button>
          <Button
            className="flex-1"
            disabled={!isRecording || pendingAction === "pause"}
            variant="secondary"
            onClick={pause}
          >
            {pendingAction === "pause" ? "Pausing…" : "Pause"}
          </Button>
          <Button
            className="flex-1"
            disabled={!isPaused || pendingAction === "resume"}
            variant="secondary"
            onClick={resume}
          >
            {pendingAction === "resume" ? "Resuming…" : "Resume"}
          </Button>
          <Button
            className="flex-1"
            disabled={!isActive || pendingAction === "stop"}
            variant="secondary"
            onClick={stop}
          >
            {pendingAction === "stop" ? "Stopping…" : "Stop"}
          </Button>
        </div>

        <p className="text-xs text-foreground/60">{SHORTCUT_HINTS}</p>

        <div className="flex gap-2">
          <Input
            className="flex-1"
            placeholder="Marker label"
            value={markerLabel}
            onChange={(e) => setMarkerLabel(e.target.value)}
            disabled={!isActive}
          />
          <Button disabled={!isActive || !markerLabel.trim()} onClick={handleAddMarker}>
            Add marker
          </Button>
        </div>
      </section>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-900 dark:bg-red-950"
        >
          {error}
          <button type="button" className="ml-2 underline" onClick={clearError}>
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  )
}

interface DeviceFieldProps {
  id: string
  label: string
  value: string
  emptyOptionLabel: string
  onChange: (id: string) => void
  // Already filtered to the relevant kind (microphone / system / webcam).
  devices: { id: string; name: string; isDefault: boolean }[]
  loaded: boolean
  // Actionable message shown once enumeration has settled but found nothing.
  emptyHint: string
}

// Labeled device select with a loading indicator and an actionable empty state.
// Factored out so the three device pickers stay consistent and their empty
// states don't drift.
function DeviceField({
  id,
  label,
  value,
  emptyOptionLabel,
  onChange,
  devices,
  loaded,
  emptyHint,
}: DeviceFieldProps): ReactNode {
  const showEmptyHint = loaded && devices.length === 0

  return (
    <div>
      <label className="mb-1 block text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      <Select value={value} onValueChange={(val) => onChange(val)} disabled={!loaded}>
        <SelectTrigger id={id}>
          <SelectValue placeholder={emptyOptionLabel} />
        </SelectTrigger>
        <SelectContent>
          {devices.map((device) => (
            <SelectItem key={device.id} value={device.id}>
              {device.name} {device.isDefault ? "(default)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {!loaded ? <p className="mt-1 text-xs text-foreground/60">Detecting devices…</p> : null}

      {showEmptyHint ? <p className="mt-1 text-xs text-foreground/60">{emptyHint}</p> : null}
    </div>
  )
}

// Global shortcuts are registered in Rust (src-tauri/src/shortcuts.rs); mirror
// them here so users can discover them without opening settings.
const SHORTCUT_HINTS =
  "Shortcuts: Ctrl+Shift+R start/stop · Ctrl+Shift+P pause/resume · Ctrl+Shift+M marker"
