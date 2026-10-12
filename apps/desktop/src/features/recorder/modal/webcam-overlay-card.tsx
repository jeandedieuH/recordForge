import { Video } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
} from "@recordforge/ui"
import { webcamPreviewModeSchema } from "@recordforge/contracts"
import { useRecorderStore } from "../../../hooks/use-recorder"
import { WebcamPreview } from "../webcam-preview"

interface WebcamOverlayCardProps {
  /** Hide the live preview while a start is pending (device release). */
  isStarting: boolean
}

// Screen-mode webcam SIDECAR card — unchanged behaviour from the original
// modal (camera mode shows a dedicated panel instead).
export function WebcamOverlayCard({ isStarting }: WebcamOverlayCardProps) {
  const {
    videoDevices,
    videoDevicesLoaded,
    selectedWebcamId,
    setSelectedWebcamId,
    setWebcamEnabled,
    preferences,
    savePreferences,
  } = useRecorderStore()

  const webcams = videoDevices.filter((d) => d.kind === "webcam")
  const webcamEnabled = Boolean(selectedWebcamId)

  return (
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
        <Switch checked={webcamEnabled} onCheckedChange={setWebcamEnabled} />
      </div>

      {webcamEnabled ? (
        <div className="flex flex-col gap-2.5 border-t border-border/40 pt-2.5 min-w-0">
          {!videoDevicesLoaded ? (
            <Skeleton className="h-9 w-full rounded-md" />
          ) : (
            <Select value={selectedWebcamId} onValueChange={setSelectedWebcamId}>
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

          <div className="flex flex-col gap-1.5">
            <Select
              value={preferences.webcamPreviewMode}
              onValueChange={(value) => {
                const parsed = webcamPreviewModeSchema.safeParse(value)
                if (parsed.success) {
                  void savePreferences({ webcamPreviewMode: parsed.data })
                }
              }}
            >
              <SelectTrigger
                aria-label="Camera preview during recording"
                className="w-full min-w-0 border-border bg-surface text-xs text-foreground"
              >
                <SelectValue placeholder="Camera preview during recording" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Off (lowest CPU)</SelectItem>
                <SelectItem value="low">Low (5 FPS)</SelectItem>
                <SelectItem value="standard">Standard (15 FPS)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-subtle-foreground">
              Preview affects monitoring only, not the saved camera video. Hiding the preview window
              does not disable preview encoding.
            </p>
          </div>

          <div className="relative flex h-24 w-full items-center justify-center overflow-hidden rounded-md border border-border bg-background">
            {videoDevicesLoaded ? (
              <div className="absolute bottom-2 right-2 z-10 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white font-medium truncate max-w-[80%]">
                {webcams.find((w) => w.id === selectedWebcamId)?.name || "Camera Active"}
              </div>
            ) : null}
            {/* The setup preview opens the camera in the browser; skip it entirely when
                preview is off or a start is pending so DirectShow can release the device. */}
            {preferences.webcamPreviewMode !== "off" && !isStarting ? (
              <WebcamPreview
                deviceName={
                  videoDevicesLoaded
                    ? webcams.find((w) => w.id === selectedWebcamId)?.name || selectedWebcamId
                    : ""
                }
              />
            ) : (
              <p className="px-2 text-center text-xs text-subtle-foreground">
                Preview off; camera will still be recorded.
              </p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
