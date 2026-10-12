import { Mic, Volume2 } from "lucide-react"
import {
  AudioLevelMeter,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
} from "@recordforge/ui"
import { useRecorderStore } from "../../../hooks/use-recorder"
import { useMicLevel } from "../camera/use-mic-level"

interface AudioInputCardsProps {
  /** Render the system-audio card too (camera mode shows it compact). */
  includeSystemAudio?: boolean
}

export function AudioInputCards({ includeSystemAudio = true }: AudioInputCardsProps) {
  const { audioDevices, selectedMicrophoneId } = useRecorderStore()

  const microphones = audioDevices.filter((d) => d.kind === "microphone")
  const micEnabled = Boolean(selectedMicrophoneId)
  const micName =
    microphones.find((m) => m.id === selectedMicrophoneId)?.name ?? selectedMicrophoneId

  // Real mic level for the setup meter (replaces the old random fake). One
  // getUserMedia stream feeds every meter this panel renders.
  const level = useMicLevel({ deviceName: micName, enabled: micEnabled })

  return (
    <>
      <MicrophoneCard level={level} />
      {includeSystemAudio ? <SystemAudioCard /> : null}
    </>
  )
}

interface MicrophoneCardProps {
  /** Live meter level 0..1 — supplied by the caller's `useMicLevel` so only
      one audio stream is ever opened per modal. */
  level: number
}

export function MicrophoneCard({ level }: MicrophoneCardProps) {
  const {
    audioDevices,
    audioDevicesLoaded,
    selectedMicrophoneId,
    setSelectedMicrophoneId,
    setMicrophoneEnabled,
  } = useRecorderStore()

  const microphones = audioDevices.filter((d) => d.kind === "microphone")
  const micEnabled = Boolean(selectedMicrophoneId)

  return (
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
        <Switch checked={micEnabled} onCheckedChange={setMicrophoneEnabled} />
      </div>

      {micEnabled ? (
        <div className="flex flex-col gap-2 border-t border-border/40 pt-2.5 min-w-0">
          {!audioDevicesLoaded ? (
            <Skeleton className="h-9 w-full rounded-md" />
          ) : microphones.length === 0 ? (
            <p className="text-xs text-subtle-foreground">No microphone found</p>
          ) : (
            <Select value={selectedMicrophoneId} onValueChange={setSelectedMicrophoneId}>
              <SelectTrigger className="w-full min-w-0 border-border bg-surface text-xs text-foreground">
                <SelectValue placeholder="Select microphone" />
              </SelectTrigger>
              <SelectContent>
                {microphones.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name} {m.isDefault ? "(default)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <AudioLevelMeter level={level} className="h-2 rounded bg-background" />
        </div>
      ) : null}
    </div>
  )
}

export function SystemAudioCard() {
  const {
    audioDevices,
    audioDevicesLoaded,
    selectedSystemAudioId,
    setSelectedSystemAudioId,
    setSystemAudioEnabled,
  } = useRecorderStore()

  const systemAudios = audioDevices.filter((d) => d.kind === "system")
  const systemAudioEnabled = Boolean(selectedSystemAudioId)

  return (
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
        <Switch checked={systemAudioEnabled} onCheckedChange={setSystemAudioEnabled} />
      </div>

      {systemAudioEnabled && (!audioDevicesLoaded || systemAudios.length > 1) ? (
        <div className="border-t border-border/40 pt-2.5 min-w-0">
          {!audioDevicesLoaded ? (
            <Skeleton className="h-9 w-full rounded-md" />
          ) : (
            <Select value={selectedSystemAudioId} onValueChange={setSelectedSystemAudioId}>
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
  )
}
