import { useEffect, useRef, useState } from "react"
import { Scissors } from "lucide-react"
import type { SmartCutRange } from "@recordforge/editor-core"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
  useToast,
} from "@recordforge/ui"
import { buildRenderPlan } from "@recordforge/media-core"
import { cancelSmartCut, detectTimelineSilences } from "../../../lib/media"
import { useTimelineStore } from "../../../stores/timeline-store"
import { useEditorStore } from "../../../stores/editor-store"
import { useLicenseStore } from "../../../stores/license-store"
import { SmartCutScanControls } from "./smart-cut-controls"
import { SmartCutReview } from "./smart-cut-review"
import { createSmartCutSession, type SmartCutSession } from "./smart-cut-scan"
import type { SmartCutResult, SmartCutScanConfig } from "./smart-cut-model"

// Scan → Review → Apply for Smart Cut. Analysis runs natively over the edited
// timeline's mixed audio (the export audio graph), so detected pauses are
// already in output-timeline coordinates — the same ms values a ripple-delete
// consumes. All run ownership lives in createSmartCutSession; this component
// only binds it to React state.

export function SmartCutCard() {
  const { toast } = useToast()
  const tier = useLicenseStore((state) => state.status.tier)
  const openUpgradeDialog = useLicenseStore((state) => state.openUpgradeDialog)
  const isPro = tier === "pro"
  const recording = useTimelineStore((state) => state.recording)
  const present = useTimelineStore((state) => state.engine?.history.present)
  // Revision-only edits (finishing settings, captions) bump this without
  // touching `present` — subscribed so they still invalidate results.
  const projectRevision = useTimelineStore((state) => state.projectRevision)

  // null selects the adaptive RMS calibration (the recommended default).
  const [thresholdDb, setThresholdDb] = useState<number | null>(null)
  const [minDurationMs, setMinDurationMs] = useState(500)
  const [paddingMs, setPaddingMs] = useState(120)
  const [phase, setPhase] = useState<"idle" | "scanning" | "review" | "error">("idle")
  const [scanError, setScanError] = useState<string | null>(null)
  const [result, setResult] = useState<SmartCutResult | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())

  const config: SmartCutScanConfig = { thresholdDb, minDurationMs, paddingMs }

  const sessionRef = useRef<SmartCutSession | null>(null)
  if (sessionRef.current === null) {
    sessionRef.current = createSmartCutSession({
      getState: () => {
        const store = useTimelineStore.getState()
        return {
          engine: store.engine,
          project: store.project,
          recording: store.recording,
          projectRevision: store.projectRevision,
        }
      },
      getTier: () => useLicenseStore.getState().status.tier,
      saveFailed: () => useEditorStore.getState().saveStatus === "error",
      save: () => useTimelineStore.getState().save(),
      execute: (command) => useTimelineStore.getState().execute(command),
      buildPlan: ({ state, projectId, settings, assets }) =>
        buildRenderPlan({
          state,
          projectId,
          settings,
          captionMode: "none",
          chapterMode: "none",
          assets,
        }),
      detect: (recordingId, scanId, plan, thresholdDb, minDurationMs) =>
        detectTimelineSilences(recordingId, scanId, { plan, thresholdDb, minDurationMs }),
      cancel: (recordingId, scanId) => cancelSmartCut(recordingId, scanId),
      openUpgrade: (features) => openUpgradeDialog(features),
      audition: {
        pause: () => useTimelineStore.getState().pause(),
        play: () => useTimelineStore.getState().play(),
        seek: (ms) => useTimelineStore.getState().seek(ms),
        subscribePlayhead: (listener) =>
          useTimelineStore.subscribe((state) => listener(state.view.playheadMs)),
      },
      newScanId: () => crypto.randomUUID(),
      hooks: {
        phase: setPhase,
        scanError: setScanError,
        result: setResult,
        selected: setSelected,
        toast: (t) => toast(t),
      },
    })
  }
  const session = sessionRef.current

  // Mount lifecycle: setup re-arms the session so a StrictMode
  // setup→cleanup→setup cycle can't leave it permanently dead; cleanup
  // invalidates only the run owned at cleanup time.
  useEffect(() => {
    session.mount()
    return () => session.unmount()
  }, [session])

  // Edits, recording/session changes, or scan-control changes cancel native
  // work promptly and invalidate both result and active run. Seeking is view
  // state and does not appear here.
  useEffect(() => {
    session.checkInvalidation(config, result)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    session,
    present,
    recording?.id,
    projectRevision,
    thresholdDb,
    minDurationMs,
    paddingMs,
    result,
  ])

  const canScan = Boolean(recording && present) && phase !== "scanning"
  const canApply = isPro && Boolean(result && selected.size > 0)

  return (
    <Card className="border-none bg-surface-dim/80">
      <CardHeader className="px-3 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <Scissors className="size-4 text-subtle-foreground" aria-hidden />
          <div className="flex-1">
            <CardTitle className="text-xs">Smart Cut</CardTitle>
            <CardDescription className="text-ui-caption">
              Scan the edited timeline for silent pauses and remove them in one pass.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-3 pb-3">
        <div className="flex flex-col gap-2.5">
          <SmartCutScanControls
            thresholdDb={thresholdDb}
            minDurationMs={minDurationMs}
            paddingMs={paddingMs}
            onThresholdDbChange={setThresholdDb}
            onMinDurationMsChange={setMinDurationMs}
            onPaddingMsChange={setPaddingMs}
          />

          {phase === "scanning" ? (
            <div className="flex items-center gap-2">
              <Skeleton className="h-8 flex-1 rounded" />
              <Button variant="outline" size="sm" onClick={() => session.cancelScan()}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void session.scan(config)}
              disabled={!canScan}
            >
              Scan for pauses
            </Button>
          )}

          {phase === "error" ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-ui-caption text-error">
                {scanError ?? "The scan failed — try again."}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void session.scan(config)}
                disabled={!canScan}
              >
                Retry
              </Button>
            </div>
          ) : null}

          {phase === "review" && result ? (
            <div className="flex flex-col gap-2">
              <p className="text-ui-micro text-subtle-foreground">
                {result.calibration === "adaptive"
                  ? `Calibrated to this recording — pauses at or below ${result.thresholdDb.toFixed(1)} dB RMS${result.noiseFloorDb !== null ? ` (measured floor ${result.noiseFloorDb.toFixed(1)} dB)` : ""}.`
                  : `Manual sensitivity — pauses at or below ${result.thresholdDb.toFixed(1)} dB RMS.`}
              </p>
              {result.ranges.length === 0 ? (
                <p className="text-ui-caption text-subtle-foreground">
                  {result.wholeTimeline
                    ? "No safe cuts: the detected pauses cover the entire timeline — removing them would delete the project."
                    : "No silent pauses found at this sensitivity. Try a higher dB RMS setting or a shorter minimum pause."}
                </p>
              ) : (
                <SmartCutReview
                  result={result}
                  ranges={result.ranges}
                  selected={selected}
                  onToggle={(index: number, checked: boolean) => {
                    setSelected((previous) => {
                      const next = new Set(previous)
                      if (checked) next.add(index)
                      else next.delete(index)
                      return next
                    })
                  }}
                  onSelectAll={() => setSelected(new Set(result.ranges.map((_, i) => i)))}
                  onDeselectAll={() => setSelected(new Set())}
                  onPreview={(range: SmartCutRange) => session.previewPause(range, result)}
                />
              )}
              {result.ranges.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <Button
                    size="sm"
                    onClick={() => session.apply(result, selected, config)}
                    disabled={!canApply}
                    title={isPro ? undefined : "Requires Pro"}
                  >
                    Remove selected pauses
                  </Button>
                  <p className="text-ui-micro text-subtle-foreground">
                    {isPro
                      ? "Applied as a single edit — one undo step restores everything."
                      : "Smart Cut requires Pro."}
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
