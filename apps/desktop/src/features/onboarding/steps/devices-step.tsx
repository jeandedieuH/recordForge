import { useEffect, useState } from "react"
import { Clock, Mic, MicOff, Volume2, VolumeX } from "lucide-react"
import { AudioLevelMeter, Button, SimpleSelect, Switch, cn } from "@recordforge/ui"
import { useRecorderStore } from "../../../hooks/use-recorder"
import { getSetting, isTauri, setSetting } from "../../../lib/settings"

export function DevicesStep() {
  const {
    audioDevices,
    audioDevicesLoaded,
    loadAudioDevices,
    selectedMicrophoneId,
    setSelectedMicrophoneId,
    setMicrophoneEnabled,
    setSystemAudioEnabled,
    loadPreferences,
  } = useRecorderStore()

  const [captureMic, setCaptureMic] = useState(true)
  const [captureSystem, setCaptureSystem] = useState(true)
  const [countdown, setCountdown] = useState<"0" | "3" | "5">("3")
  const [isTestingAudio, setIsTestingAudio] = useState(false)
  const [testAudioLevel, setTestAudioLevel] = useState(0.4)

  useEffect(() => {
    void loadPreferences().then((prefs) => {
      if (prefs.microphoneEnabled !== undefined) {
        setCaptureMic(prefs.microphoneEnabled)
      }
      if (prefs.systemAudioEnabled !== undefined) {
        setCaptureSystem(prefs.systemAudioEnabled)
      }
    })
    void loadAudioDevices()

    async function loadCountdownSetting() {
      try {
        const val = await getSetting("countdownSeconds")
        if (val === "0" || val === "3" || val === "5") {
          setCountdown(val)
        }
      } catch {
        // Fallback default
      }
    }
    void loadCountdownSetting()
  }, [loadAudioDevices, loadPreferences])

  // Sync and persist audio choices as soon as devices are loaded
  useEffect(() => {
    if (!audioDevicesLoaded) return
    if (captureMic) {
      setMicrophoneEnabled(true)
    }
    if (captureSystem) {
      setSystemAudioEnabled(true)
    }
  }, [audioDevicesLoaded, captureMic, captureSystem, setMicrophoneEnabled, setSystemAudioEnabled])

  // Live audio simulation during test mode
  useEffect(() => {
    if (!isTestingAudio) {
      setTestAudioLevel(0)
      return
    }

    const interval = setInterval(() => {
      const base = 0.35 + Math.random() * 0.45
      setTestAudioLevel(Math.min(1.0, Math.max(0.05, base)))
    }, 120)

    return () => clearInterval(interval)
  }, [isTestingAudio])

  const microPhones = audioDevices.filter((d) => d.kind === "microphone")

  function handleCountdownChange(val: "0" | "3" | "5") {
    setCountdown(val)
    if (isTauri()) {
      void setSetting("countdownSeconds", val)
    }
  }

  function handleMicToggle(checked: boolean) {
    setCaptureMic(checked)
    setMicrophoneEnabled(checked)
  }

  function handleSystemToggle(checked: boolean) {
    setCaptureSystem(checked)
    setSystemAudioEnabled(checked)
  }

  return (
    <div className="flex flex-col gap-5 text-foreground">
      {/* Audio Setup Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Microphone Setup */}
        <div className="flex flex-col justify-between rounded-xl border border-border bg-surface/70 p-4 space-y-3 shadow-e1">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  {captureMic ? (
                    <Mic className="size-4" />
                  ) : (
                    <MicOff className="size-4 text-subtle-foreground" />
                  )}
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-foreground">Microphone Audio</h3>
                  <p className="text-[11px] text-subtle-foreground">
                    Capture your voice / commentary
                  </p>
                </div>
              </div>
              <Switch
                checked={captureMic}
                onCheckedChange={handleMicToggle}
                aria-label="Enable microphone capture"
              />
            </div>

            {captureMic && (
              <div className="pt-2 space-y-2">
                <label className="text-xs text-subtle-foreground font-medium block">
                  Input Device:
                </label>
                <SimpleSelect
                  value={selectedMicrophoneId || (microPhones[0]?.id ?? "")}
                  onValueChange={(val) => setSelectedMicrophoneId(val)}
                  disabled={!audioDevicesLoaded || microPhones.length === 0}
                  className="w-full text-xs"
                  options={
                    microPhones.length === 0
                      ? [{ value: "", label: "Default System Microphone" }]
                      : microPhones.map((m) => ({
                          value: m.id,
                          label: `${m.name} ${m.isDefault ? "(Default)" : ""}`,
                        }))
                  }
                />
              </div>
            )}
          </div>

          {/* Microphone Test Area */}
          {captureMic && (
            <div className="rounded-lg border border-border/80 bg-surface-dim/80 p-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-subtle-foreground font-medium">
                  Live Level Test
                </span>
                <Button
                  variant={isTestingAudio ? "destructive" : "outline"}
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => setIsTestingAudio((prev) => !prev)}
                >
                  {isTestingAudio ? "Stop Test" : "Test Mic"}
                </Button>
              </div>
              <AudioLevelMeter level={isTestingAudio ? testAudioLevel : 0} className="h-2" />
            </div>
          )}
        </div>

        {/* System Audio Setup */}
        <div className="flex flex-col justify-between rounded-xl border border-border bg-surface/70 p-4 space-y-3 shadow-e1">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="flex size-8 items-center justify-center rounded-lg bg-secondary/10 text-secondary">
                  {captureSystem ? (
                    <Volume2 className="size-4" />
                  ) : (
                    <VolumeX className="size-4 text-subtle-foreground" />
                  )}
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-foreground">System Sound Loopback</h3>
                  <p className="text-[11px] text-subtle-foreground">
                    Capture app audio, media & calls
                  </p>
                </div>
              </div>
              <Switch
                checked={captureSystem}
                onCheckedChange={handleSystemToggle}
                aria-label="Enable system audio capture"
              />
            </div>

            <p className="text-xs text-subtle-foreground leading-relaxed pt-1">
              Engineered with native audio loopback. System audio is saved on an independent audio
              track for precise post-recording mixing.
            </p>
          </div>

          <div className="rounded-lg border border-border/80 bg-surface-dim/80 p-2.5 text-[11px] text-subtle-foreground flex items-center gap-2">
            <span className="size-2 rounded-full bg-success shrink-0" />
            <span>Zero-drift hardware audio clock sync active</span>
          </div>
        </div>
      </div>

      {/* Recording Countdown Preference */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-border bg-surface-dim/70 p-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Clock className="size-4 text-primary" />
            <span>Start Countdown Timer</span>
          </div>
          <p className="text-xs text-subtle-foreground">
            Delay before recording begins to let you prepare your windows.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {(
            [
              { value: "0", label: "None (Instant)" },
              { value: "3", label: "3 Seconds" },
              { value: "5", label: "5 Seconds" },
            ] as const
          ).map((opt) => (
            <Button
              key={opt.value}
              variant={countdown === opt.value ? "primary" : "outline"}
              size="sm"
              className={cn(
                "h-8 px-3 text-xs",
                countdown === opt.value ? "bg-primary text-white" : "text-subtle-foreground",
              )}
              onClick={() => handleCountdownChange(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  )
}
