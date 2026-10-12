import { FlipHorizontal2, Grid3x3, Mic, RefreshCw, Video } from "lucide-react"
import { AudioLevelMeter, IconButton, Skeleton } from "@recordforge/ui"
import { FramingGuide } from "./framing-guide"
import { CameraStateView } from "./camera-states"
import type { UseCameraPreview } from "./use-camera-preview"

interface CameraStageProps {
  preview: UseCameraPreview
  deviceName: string
  mirrored: boolean
  showGuide: boolean
  onToggleMirror: (value: boolean) => void
  onToggleGuide: (value: boolean) => void
  onRefresh: () => void
  // Bottom-left chip text — never shows "Auto": the caller supplies the
  // plan summary or "at the camera's default size"; skeleton while loading.
  planSummary: string
  plansLoading: boolean
  micEnabled: boolean
  micLevel: number
}

export function CameraStage({
  preview,
  deviceName,
  mirrored,
  showGuide,
  onToggleMirror,
  onToggleGuide,
  onRefresh,
  planSummary,
  plansLoading,
  micEnabled,
  micLevel,
}: CameraStageProps) {
  const { state, attachVideo, retry } = preview
  const live = state === "active"

  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="region"
        aria-label="Camera preview"
        data-preview-state={state}
        className="relative aspect-video w-full overflow-hidden rounded-xl border border-border bg-black"
      >
        <video
          ref={attachVideo}
          muted
          playsInline
          autoPlay
          className={`h-full w-full object-contain ${mirrored ? "-scale-x-100" : ""} ${
            live ? "opacity-100" : "opacity-0"
          } transition-opacity duration-base`}
        />

        {/* State layer must be absolutely positioned: the in-flow <video>
            already fills the aspect-video box, so a sibling `h-full` div in
            normal flow would be laid out below it and clipped away. */}
        {!live && state !== "idle" ? (
          <div className="absolute inset-0">
            <CameraStateView state={state} onRetry={retry} />
          </div>
        ) : null}
        {live && showGuide ? <FramingGuide /> : null}

        {/* Top overlay: device chip + preview controls */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between bg-linear-to-b from-black/55 to-transparent p-2.5">
          <div className="pointer-events-auto flex min-w-0 items-center gap-1.5 rounded-md bg-black/60 px-2 py-1">
            <Video className="size-3.5 shrink-0 text-white/80" aria-hidden />
            <span className="truncate text-[11px] font-medium text-white/90">
              {deviceName || "Camera"}
            </span>
          </div>
          <div className="pointer-events-auto flex items-center gap-1">
            <IconButton
              label="Mirror preview"
              aria-pressed={mirrored}
              onClick={() => onToggleMirror(!mirrored)}
              className="size-7 bg-black/60 text-white/80 hover:bg-black/80 hover:text-white"
            >
              <FlipHorizontal2 className="size-3.5" aria-hidden />
            </IconButton>
            <IconButton
              label="Framing guide"
              aria-pressed={showGuide}
              onClick={() => onToggleGuide(!showGuide)}
              className="size-7 bg-black/60 text-white/80 hover:bg-black/80 hover:text-white"
            >
              <Grid3x3 className="size-3.5" aria-hidden />
            </IconButton>
            <IconButton
              label="Refresh camera"
              onClick={onRefresh}
              className="size-7 bg-black/60 text-white/80 hover:bg-black/80 hover:text-white"
            >
              <RefreshCw className="size-3.5" aria-hidden />
            </IconButton>
          </div>
        </div>

        {/* Bottom overlay: recording summary + mic meter */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between bg-linear-to-t from-black/55 to-transparent p-2.5">
          <div className="pointer-events-auto flex items-center gap-1.5 rounded-md bg-black/60 px-2 py-1">
            {live ? (
              <span className="size-1.5 rounded-full bg-success motion-safe:animate-pulse" />
            ) : null}
            {plansLoading ? (
              <Skeleton className="h-3 w-24 rounded bg-white/20" />
            ) : (
              <span className="text-[11px] font-medium text-white/90">Recording {planSummary}</span>
            )}
          </div>
          {/* R10: the meter is only meaningful while the preview is live or
              settling — hide it on every state surface. */}
          {micEnabled && (live || state === "loading" || state === "idle") ? (
            <div className="pointer-events-auto flex items-center gap-1.5 rounded-md bg-black/60 px-2 py-1">
              <Mic className="size-3 text-white/80" aria-hidden />
              <AudioLevelMeter level={micLevel} segments={12} className="h-1.5 w-16 rounded" />
            </div>
          ) : null}
        </div>
      </div>

      {mirrored ? (
        <p className="text-xs text-subtle-foreground">
          Preview is mirrored; your saved video is not.
        </p>
      ) : null}
    </div>
  )
}
