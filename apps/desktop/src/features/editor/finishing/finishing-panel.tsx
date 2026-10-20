import { useState } from "react"
import { Button, EmptyState } from "@recordforge/ui"
import { MonitorPlay, WandSparkles } from "lucide-react"
import { useTimelineStore } from "../../../stores/timeline-store"
import { useLicenseStore } from "../../../stores/license-store"
import { KeystrokeOverlayCard } from "./keystroke-overlay-card"
import { ProcessedPreviewDialog } from "./processed-preview-dialog"

// Finishing task: export-time polish — keystroke badges — editing the same
// durable project.exportSettings the export view reads. Preview renders on
// demand through the real pipeline.
export function FinishingPanel() {
  const project = useTimelineStore((state) => state.project)
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

  if (!project || !exportSettings) {
    return (
      <EmptyState
        icon={WandSparkles}
        title="Nothing to finish yet"
        description="Open a recording to apply finishing effects."
        className="m-3 border border-dashed border-border bg-surface p-4"
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
