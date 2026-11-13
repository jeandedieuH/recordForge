import { Crop, Mic, MicOff, Monitor, MonitorUp, Video, Volume2 } from "lucide-react"
import { cameraTiers } from "@recordforge/contracts"
import { useRecorderStore } from "../../../hooks/use-recorder"

interface StartSummaryProps {
  cameraMode: boolean
}

const MODE_ICON = {
  screen: Monitor,
  window: MonitorUp,
  region: Crop,
  camera: Video,
} as const

// One-line "this is what the next take will contain" summary next to the
// primary action. It exists so the start decision never depends on recalling
// which switches are on in the panels above.
export function StartSummary({ cameraMode }: StartSummaryProps) {
  const {
    selectedSource,
    selectedSourceType,
    sourcesLoaded,
    profiles,
    selectedProfileId,
    videoDevices,
    videoDevicesLoaded,
    selectedCameraId,
    selectedCameraProfileId,
    audioDevices,
    audioDevicesLoaded,
    selectedMicrophoneId,
    selectedSystemAudioId,
    selectedWebcamId,
  } = useRecorderStore()

  const ModeIcon = MODE_ICON[selectedSourceType]

  const webcams = videoDevices.filter((d) => d.kind === "webcam")
  const cameraName = webcams.find((w) => w.id === selectedCameraId)?.name ?? null

  const micName =
    audioDevices.find((d) => d.kind === "microphone" && d.id === selectedMicrophoneId)?.name ?? null
  const systemAudioName =
    audioDevices.find((d) => d.kind === "system" && d.id === selectedSystemAudioId)?.name ?? null
  const webcamName = webcams.find((w) => w.id === selectedWebcamId)?.name ?? null

  const profile = profiles.find((p) => p.id === selectedProfileId)
  const cameraTier = cameraTiers.find((tier) => tier.id === selectedCameraProfileId)
  const quality = cameraMode
    ? (cameraTier?.label ?? "Camera")
    : profile
      ? `${profile.width}×${profile.height} @ ${profile.fps} fps`
      : null

  const sourceLabel = cameraMode
    ? (cameraName ?? (videoDevicesLoaded ? "No camera" : "Detecting cameras…"))
    : selectedSourceType === "region"
      ? (selectedSource?.name ?? (sourcesLoaded ? "No region selected" : "Detecting sources…"))
      : (selectedSource?.name ?? (sourcesLoaded ? "No source selected" : "Detecting sources…"))

  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-dim text-muted-foreground">
        <ModeIcon className="size-4" aria-hidden />
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-xs font-semibold text-foreground">{sourceLabel}</span>
          {quality ? (
            <span className="shrink-0 text-[11px] text-subtle-foreground">{quality}</span>
          ) : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-muted-foreground">
          {!audioDevicesLoaded ? (
            <span className="text-subtle-foreground">Checking inputs…</span>
          ) : (
            <>
              <SummaryInput
                icon={micName ? Mic : MicOff}
                label={micName ?? "No microphone"}
                muted={!micName}
              />
              {systemAudioName ? <SummaryInput icon={Volume2} label={systemAudioName} /> : null}
              {!cameraMode && videoDevicesLoaded && webcamName ? (
                <SummaryInput icon={Video} label={webcamName} />
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

interface SummaryInputProps {
  icon: typeof Mic
  label: string
  muted?: boolean
}

function SummaryInput({ icon: Icon, label, muted = false }: SummaryInputProps) {
  return (
    <span
      className={
        muted
          ? "flex min-w-0 items-center gap-1 text-subtle-foreground"
          : "flex min-w-0 items-center gap-1"
      }
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </span>
  )
}
