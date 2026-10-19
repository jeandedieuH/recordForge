import { useMemo, useState } from "react"
import { Button, EmptyState } from "@recordforge/ui"
import { MonitorPlay, WandSparkles } from "lucide-react"
import { useTimelineStore } from "../../../stores/timeline-store"
import { useLicenseStore } from "../../../stores/license-store"
import { ProBadge } from "../../licensing/pro-badge"
import { isCameraRecording } from "../../../lib/library"
import { StudioAudioControls } from "./studio-audio-controls"
import { KeystrokeOverlayCard } from "./keystroke-overlay-card"
import { ProcessedPreviewDialog } from "./processed-preview-dialog"
import { BrandWatermarkCard } from "../../export/brand-watermark-card"
import { VirtualBackgroundCard } from "../../export/virtual-background-card"

// Finishing task: everything polished at export — audio mastering, branding,
// webcam background, keystroke badges — editing the same durable
// project.exportSettings the export view reads. Preview renders on demand
// through the real pipeline.
export function FinishingPanel() {
  const project = useTimelineStore((state) => state.project)
  const recording = useTimelineStore((state) => state.recording)
  const timeline = useTimelineStore((state) => state.engine?.history.present)
  const setAudioMastering = useTimelineStore((state) => state.setAudioMastering)
  const setBrandWatermark = useTimelineStore((state) => state.setBrandWatermark)
  const setBrandCards = useTimelineStore((state) => state.setBrandCards)
  const setWebcamBackground = useTimelineStore((state) => state.setWebcamBackground)
  const setKeystrokeOverlay = useTimelineStore((state) => state.setKeystrokeOverlay)
  const keystrokeEvents = useTimelineStore((state) => state.keystrokeEvents)
  const keystrokeEventsSupported = useTimelineStore((state) => state.keystrokeEventsSupported)
  const keystrokeStatus = useTimelineStore((state) =>
    state.keystrokeEventsStatus === "error"
      ? ("error" as const)
      : state.keystrokeEventsStatus === "loading"
        ? ("loading" as const)
        : ("loaded" as const),
  )
  const keystrokeError = useTimelineStore((state) => state.keystrokeEventsError)
  const loadKeystrokeEvents = useTimelineStore((state) => state.loadKeystrokeEvents)
  const isPro = useLicenseStore((state) => state.status.tier === "pro")
  const openUpgradeDialog = useLicenseStore((state) => state.openUpgradeDialog)

  const [previewOpen, setPreviewOpen] = useState(false)

  const exportSettings = project?.exportSettings
  const isAnimation = exportSettings?.container === "gif" || exportSettings?.container === "webp"

  // Webcam sources: a camera track clip or a camera-only recording.
  const hasCamera = useMemo(() => {
    if (!timeline) return false
    if (isCameraRecording(recording)) return true
    return timeline.tracks.some((track) => track.kind === "camera" && track.clips.length > 0)
  }, [timeline, recording])

  if (!project || !exportSettings) {
    return (
      <EmptyState
        icon={WandSparkles}
        title="Nothing to finish yet"
        description="Open a recording to apply finishing effects."
        className="m-3 border border-dashed border-border bg-surface-dim p-4"
      />
    )
  }

  return (
    // The desktop sidebar cell is overflow-hidden — the panel must bound its
    // own height so the cards scroll and the preview footer stays visible.
    <div className="flex h-full min-h-0 flex-col">
      {/* Block + space-y scroll content: flex columns let overflow-hidden
          card children shrink and clip instead of scrolling. */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          <div className="flex w-full items-center justify-between p-4">
            <span className="flex items-center gap-2 font-label text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Studio Audio
              {!isPro ? <ProBadge /> : null}
            </span>
          </div>
          <div className="border-t border-border p-5 text-xs text-subtle-foreground">
            {isAnimation ? (
              <p>Animated exports don't carry audio — Studio Audio applies only to MP4 output.</p>
            ) : (
              <StudioAudioControls
                mastering={exportSettings.audioMastering}
                isPro={isPro}
                onChange={setAudioMastering}
                onUpgradeRequest={openUpgradeDialog}
              />
            )}
          </div>
        </div>

        <BrandWatermarkCard
          watermark={exportSettings.brandWatermark}
          cards={exportSettings.brandCards}
          isAnimation={isAnimation}
          onCardsChange={setBrandCards}
          onChange={setBrandWatermark}
        />

        <VirtualBackgroundCard
          background={exportSettings.webcamBackground}
          hasCamera={hasCamera}
          onChange={setWebcamBackground}
        />

        <KeystrokeOverlayCard
          overlay={exportSettings.keystrokeOverlay}
          isPro={isPro}
          eventCount={keystrokeEvents.length}
          captureSupported={keystrokeEventsSupported}
          status={keystrokeStatus}
          statusError={keystrokeError}
          onRetry={() => void loadKeystrokeEvents()}
          onChange={setKeystrokeOverlay}
          onUpgradeRequest={openUpgradeDialog}
        />
      </div>

      <div className="shrink-0 border-t border-border bg-surface p-3">
        <Button variant="outline" className="w-full" onClick={() => setPreviewOpen(true)}>
          <MonitorPlay className="size-4" aria-hidden />
          Preview finished video
        </Button>
      </div>
      <ProcessedPreviewDialog open={previewOpen} onOpenChange={setPreviewOpen} />
    </div>
  )
}
