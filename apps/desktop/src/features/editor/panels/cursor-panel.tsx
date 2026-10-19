import type { CursorSettings } from "@recordforge/contracts"
import { defaultCursorSettings } from "@recordforge/contracts"
import { createUpdateCursorSettingsCommand } from "@recordforge/editor-core"
import { useTimelineStore } from "../../../stores/timeline-store"
import { useLicenseStore } from "../../../stores/license-store"
import { CursorInspector } from "../cursor"
import { KeystrokeOverlayCard } from "../finishing/keystroke-overlay-card"

export function CursorPanel() {
  const execute = useTimelineStore((state) => state.execute)
  const timeline = useTimelineStore((state) => state.engine?.history.present)
  const keystrokeOverlay = useTimelineStore(
    (state) => state.project?.exportSettings.keystrokeOverlay,
  )
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

  const cursorSettings = timeline?.canvas.cursorSettings ?? defaultCursorSettings

  function handleCursorChange(updated: Partial<CursorSettings>) {
    execute(createUpdateCursorSettingsCommand(updated))
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <CursorInspector settings={cursorSettings} onChange={handleCursorChange} />
      {/* Keystroke badges also live under Finishing; both edit the same
          persisted project.exportSettings.keystrokeOverlay. */}
      {keystrokeOverlay ? (
        <KeystrokeOverlayCard
          overlay={keystrokeOverlay}
          isPro={isPro}
          eventCount={keystrokeEvents.length}
          captureSupported={keystrokeEventsSupported}
          status={keystrokeStatus}
          statusError={keystrokeError}
          onRetry={() => void loadKeystrokeEvents()}
          onChange={setKeystrokeOverlay}
          onUpgradeRequest={openUpgradeDialog}
        />
      ) : null}
    </div>
  )
}
