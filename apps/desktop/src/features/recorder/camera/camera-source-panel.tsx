import { useEffect } from "react"
import { AlertTriangle, Check, ScrollText, Video } from "lucide-react"
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  ToggleGroup,
  ToggleGroupItem,
} from "@recordforge/ui"
import type { z } from "zod"
import type { webcamPreviewModeSchema } from "@recordforge/contracts"
import { useRecorderStore } from "../../../hooks/use-recorder"
import { useLicenseStore } from "../../../stores/license-store"
import { ProBadge } from "../../licensing/pro-badge"
import { CameraStage } from "./camera-stage"
import { CameraQualityPicker } from "./camera-quality-picker"
import { MicrophoneCard, SystemAudioCard } from "../modal/audio-input-cards"
import { useCameraPlans } from "./use-camera-plans"
import { useMicLevel } from "./use-mic-level"
import { planSummary, AUDIO_PCM_KBPS_ESTIMATE } from "./camera-format"
import type { UseCameraPreview } from "./use-camera-preview"

type WebcamPreviewMode = z.infer<typeof webcamPreviewModeSchema>

const SELF_VIEW_OPTIONS: { value: WebcamPreviewMode; label: string; caption: string }[] = [
  { value: "off", label: "Off", caption: "Off — lowest CPU, no preview window" },
  { value: "low", label: "Low", caption: "5 fps — minimal CPU" },
  { value: "standard", label: "Smooth", caption: "15 fps — smooth framing view" },
]

export type CameraStartBlocker = "no-camera" | "low-disk" | null

const BLOCKER_COPY: Record<Exclude<CameraStartBlocker, null>, string> = {
  "no-camera": "No camera detected — connect a camera to start recording.",
  "low-disk": "Not enough free disk space — free up at least 1 GB to start.",
}

interface CameraSourcePanelProps {
  preview: UseCameraPreview
  blocker: CameraStartBlocker
  freeBytes: number | null
  storageLoaded: boolean
  onOpenTeleprompter: () => void
  onRefreshDevices: () => void
}

// Camera-mode body: preview stage + framing/audio on the left, camera
// device/quality on the right. The camera is the recording source — no
// screen pickers anywhere.
export function CameraSourcePanel({
  preview,
  blocker,
  freeBytes,
  storageLoaded,
  onOpenTeleprompter,
  onRefreshDevices,
}: CameraSourcePanelProps) {
  const {
    videoDevices,
    videoDevicesLoaded,
    audioDevices,
    selectedCameraId,
    setSelectedCameraId,
    selectedCameraProfileId,
    setSelectedCameraProfileId,
    selectedMicrophoneId,
    preferences,
    savePreferences,
    encoders,
    loadEncoders,
  } = useRecorderStore()
  const isPro = useLicenseStore((state) => state.status.tier === "pro")

  const webcams = videoDevices.filter((d) => d.kind === "webcam")
  const cameraDevice = webcams.find((w) => w.id === selectedCameraId)
  const cameraName = cameraDevice?.name ?? selectedCameraId
  const micEnabled = Boolean(selectedMicrophoneId)
  const micName =
    audioDevices.find((d) => d.kind === "microphone" && d.id === selectedMicrophoneId)?.name ??
    selectedMicrophoneId

  // Encoder list powers the quality picker's CPU-load estimate.
  useEffect(() => {
    void loadEncoders()
  }, [loadEncoders])
  const hasHardwareEncoder = encoders.some((e) => e.available && e.vendor)

  const { plans, status } = useCameraPlans(selectedCameraId || null)
  const micLevel = useMicLevel({ deviceName: micName, enabled: micEnabled })

  const selectedPlan = plans?.[selectedCameraProfileId] ?? null
  // The chip must never read "Auto" — skeleton while probing, the resolved
  // plan when known, "default size" when the probe is unavailable.
  const stageSummary = selectedPlan ? planSummary(selectedPlan) : "at the camera's default size"

  const selfView = preferences.cameraPreviewMode
  const selfViewCaption =
    SELF_VIEW_OPTIONS.find((o) => o.value === selfView)?.caption ?? SELF_VIEW_OPTIONS[0].caption

  return (
    <div className="flex flex-col gap-4">
      {blocker ? (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2"
        >
          <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden />
          <span className="text-xs font-medium text-warning">{BLOCKER_COPY[blocker]}</span>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-3">
          <CameraStage
            preview={preview}
            deviceName={cameraName}
            mirrored={preferences.cameraMirrorPreview}
            showGuide={preferences.cameraFramingGuide}
            onToggleMirror={(value) => void savePreferences({ cameraMirrorPreview: value })}
            onToggleGuide={(value) => void savePreferences({ cameraFramingGuide: value })}
            onRefresh={onRefreshDevices}
            planSummary={stageSummary}
            plansLoading={status === "loading" && !plans}
            micEnabled={micEnabled}
            micLevel={micLevel}
          />

          <MicrophoneCard level={micLevel} />

          {/* Self-view while recording — kept compact so its controls stay
              above the fold in the default 1280×761 window. */}
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-dim p-3">
            <div className="text-sm font-semibold text-foreground">Self-view while recording</div>
            <ToggleGroup
              type="single"
              value={selfView}
              onValueChange={(value) => {
                if (value) void savePreferences({ cameraPreviewMode: value as WebcamPreviewMode })
              }}
              className="w-full"
            >
              {SELF_VIEW_OPTIONS.map((option) => (
                <ToggleGroupItem key={option.value} value={option.value} className="flex-1 text-xs">
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <p className="text-xs text-subtle-foreground">{selfViewCaption}</p>
            <p className="text-xs text-subtle-foreground">
              A small always-on-top window shows your framing. It never appears in the recording.
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={onOpenTeleprompter}
              className="w-fit cursor-pointer gap-1.5 border-border bg-surface text-xs text-muted-foreground hover:bg-overlay hover:text-foreground"
            >
              <ScrollText className="size-3.5" aria-hidden />
              Open teleprompter
              {!isPro ? <ProBadge /> : null}
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          {/* Camera device + quality tier */}
          <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface-dim p-3.5">
            <div className="flex items-center gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-overlay text-muted-foreground">
                <Video className="size-4" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-foreground">Camera</div>
                {!videoDevicesLoaded ? (
                  <Skeleton className="mt-1 h-3 w-28 rounded" />
                ) : webcams.length > 1 ? (
                  <Select value={selectedCameraId} onValueChange={setSelectedCameraId}>
                    <SelectTrigger className="mt-1 w-full min-w-0 border-border bg-surface text-xs text-foreground">
                      <SelectValue placeholder="Select camera" />
                    </SelectTrigger>
                    <SelectContent>
                      {webcams.map((w) => (
                        <SelectItem key={w.id} value={w.id}>
                          {w.name} {w.isDefault ? "(default)" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : cameraDevice ? (
                  <div className="flex items-center gap-1.5 text-xs text-subtle-foreground">
                    <Check className="size-3.5 text-success" aria-hidden />
                    <span className="truncate">{cameraDevice.name}</span>
                    <span>· Connected</span>
                  </div>
                ) : (
                  <div className="text-xs text-subtle-foreground">No camera found</div>
                )}
              </div>
            </div>

            <div className="border-t border-border/40 pt-2.5">
              <CameraQualityPicker
                selected={selectedCameraProfileId}
                onSelect={setSelectedCameraProfileId}
                plans={plans}
                status={status}
                hasHardwareEncoder={hasHardwareEncoder}
                freeBytes={freeBytes}
                storageLoaded={storageLoaded}
                totalKbpsExtra={micEnabled ? AUDIO_PCM_KBPS_ESTIMATE : 0}
              />
            </div>
          </div>

          <SystemAudioCard />
        </div>
      </div>
    </div>
  )
}
