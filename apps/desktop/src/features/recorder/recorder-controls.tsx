import { useEffect, useState } from "react"
import { Button, Input } from "@recordforge/ui"
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
    videoDevices,
    profiles,
    selectedSource,
    selectedProfileId,
    selectedMicrophoneId,
    selectedSystemAudioId,
    selectedWebcamId,
    status,
    isLoading,
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
  const canStart = selectedSource && !isActive && !isLoading

  function handleAddMarker() {
    if (!markerLabel.trim()) return
    void addMarker(markerLabel.trim())
  }

  return (
    <div className="flex flex-col gap-4">
      <SourcePicker value={selectedSource} onSelect={setSelectedSource} />

      <div className="grid gap-3 rounded-lg border border-border bg-muted p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor="microphone">
              Microphone
            </label>
            <select
              id="microphone"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
              value={selectedMicrophoneId}
              onChange={(e) => setSelectedMicrophoneId(e.target.value)}
            >
              <option value="">No microphone</option>
              {microphones.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name} {device.isDefault ? "(default)" : ""}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor="system-audio">
              System audio
            </label>
            <select
              id="system-audio"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
              value={selectedSystemAudioId}
              onChange={(e) => setSelectedSystemAudioId(e.target.value)}
            >
              <option value="">No system audio</option>
              {systemAudios.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name} {device.isDefault ? "(default)" : ""}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor="webcam">
              Webcam
            </label>
            <select
              id="webcam"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
              value={selectedWebcamId}
              onChange={(e) => setSelectedWebcamId(e.target.value)}
            >
              <option value="">No webcam</option>
              {webcams.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name} {device.isDefault ? "(default)" : ""}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor="profile">
              Recording profile
            </label>
            <select
              id="profile"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
              value={selectedProfileId}
              onChange={(e) => setSelectedProfileId(e.target.value as RecordingConfig["profile"])}
            >
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.label} — {profile.width}x{profile.height}@{profile.fps}fps
                </option>
              ))}
            </select>
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
          <Button className="flex-1" disabled={!canStart} onClick={onStart}>
            Start recording
          </Button>
          <Button
            className="flex-1"
            disabled={!isRecording || isLoading}
            variant="secondary"
            onClick={pause}
          >
            Pause
          </Button>
          <Button
            className="flex-1"
            disabled={!isPaused || isLoading}
            variant="secondary"
            onClick={resume}
          >
            Resume
          </Button>
          <Button
            className="flex-1"
            disabled={!isActive || isLoading}
            variant="secondary"
            onClick={stop}
          >
            Stop
          </Button>
        </div>

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
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-900 dark:bg-red-950">
          {error}
          <button type="button" className="ml-2 underline" onClick={clearError}>
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  )
}
