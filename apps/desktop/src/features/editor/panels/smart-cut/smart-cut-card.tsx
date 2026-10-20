import { useEffect, useState } from "react"
import { createRippleDeleteRangesCommand, SMART_CUT_DEFAULTS } from "@recordforge/editor-core"
import { Badge, Button, EmptyState, IconButton, Skeleton, useToast } from "@recordforge/ui"
import { AlertTriangle, Check, Scissors, Sparkles, VolumeOff, X } from "lucide-react"
import { useLicenseStore } from "../../../../stores/license-store"
import { useSmartCutStore } from "../../../../stores/smart-cut-store"
import { useTimelineStore } from "../../../../stores/timeline-store"
import type { WaveformResources } from "../../media/derivative-resources"
import { ProBadge } from "../../../licensing/pro-badge"
import { SilenceOverviewStrip } from "./silence-overview-strip"
import { SilenceRangeList } from "./silence-range-list"
import { SmartCutControls } from "./smart-cut-controls"
import { useSmartCutAnalysis } from "./use-smart-cut-analysis"

function formatSaved(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds} s`
  return `${minutes}m ${seconds}s`
}

const FALLBACK_THRESHOLD_DB = -38

export function SmartCutCard({ waveformResources }: { waveformResources: WaveformResources }) {
  const isPro = useLicenseStore((state) => state.status.tier === "pro")
  const recording = useTimelineStore((state) => state.recording)
  const metadata = useTimelineStore((state) => state.metadata)
  const timeline = useTimelineStore((state) => state.engine?.history.present ?? null)
  const timelineDurationMs = useTimelineStore((state) => state.view.durationMs)
  const seek = useTimelineStore((state) => state.seek)
  const execute = useTimelineStore((state) => state.execute)
  const openUpgradeDialog = useLicenseStore((state) => state.openUpgradeDialog)
  const { toast } = useToast()

  const review = useSmartCutStore((state) => state.review)
  const syncReview = useSmartCutStore((state) => state.syncReview)
  const clearReview = useSmartCutStore((state) => state.clearReview)
  const toggleRangeExcluded = useSmartCutStore((state) => state.toggleRangeExcluded)
  const setAllExcluded = useSmartCutStore((state) => state.setAllExcluded)

  // Sensitivity is Auto (noise-floor estimate) until the user touches the slider.
  const [manualDb, setManualDb] = useState<number | null>(null)
  const [minDurationMs, setMinDurationMs] = useState<number>(SMART_CUT_DEFAULTS.minDurationMs)
  const [paddingMs, setPaddingMs] = useState<number>(SMART_CUT_DEFAULTS.paddingMs)
  const [isApplying, setIsApplying] = useState(false)

  // `metadata` lags the recording briefly on load — treat pending metadata as
  // "still preparing" rather than flashing the no-audio state.
  const metadataPending = recording != null && metadata == null
  const hasAudio = metadata?.hasAudio ?? false
  const enabled = isPro && hasAudio

  const scan = useSmartCutAnalysis({
    timeline,
    waveformResources,
    recordingId: recording?.id,
    hasAudio,
    timelineDurationMs,
    options: { thresholdDb: manualDb, minDurationMs, paddingMs },
    enabled,
  })

  // The effective threshold follows the estimate while in Auto mode.
  const thresholdDb = manualDb ?? scan.suggestedThresholdDb ?? FALLBACK_THRESHOLD_DB
  const isAutoThreshold = manualDb === null

  // Keep the store review in lock-step with the latest analysis — edits made
  // mid-review recompute ranges instead of going stale, and exclusions carry
  // over by range id. `review` is read imperatively so this never loops.
  useEffect(() => {
    if (!scan.analysis || !timeline) return
    if (!useSmartCutStore.getState().review) return
    syncReview({
      ranges: scan.analysis.ranges.map((range) => ({
        id: `${range.startMs}-${range.endMs}`,
        startMs: range.startMs,
        endMs: range.endMs,
      })),
      removedMs: scan.analysis.removedMs,
      audibleCoverageMs: scan.analysis.audibleCoverageMs,
      hasLockedBlockers: scan.analysis.hasLockedBlockers,
      analyzedTimeline: timeline,
    })
    // scan.analysis is the single source of truth for range positions.
  }, [scan.analysis, timeline, syncReview])

  if (!recording || !timeline) return null

  if (!isPro) {
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-surface p-3.5 shadow-xs">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Scissors className="size-4 text-secondary" aria-hidden />
            <h3 className="text-sm font-semibold text-foreground">Smart Cut</h3>
            <ProBadge />
          </div>
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Auto-detect dead air in your recording and remove it in one click — sensitivity is
          calibrated to this recording's noise floor.
        </p>
        <Button
          variant="primary"
          size="sm"
          className="w-full"
          onClick={() => openUpgradeDialog(["smart-cut"])}
        >
          <Sparkles className="size-3.5" data-icon="inline-start" />
          <span>Upgrade to unlock</span>
        </Button>
      </div>
    )
  }

  const includedRanges = review
    ? review.ranges.filter((range) => !review.excludedIds.includes(range.id))
    : []
  const includedRemovedMs = includedRanges.reduce(
    (total, range) => total + (range.endMs - range.startMs),
    0,
  )
  const coverageShare =
    review && review.audibleCoverageMs > 0 ? includedRemovedMs / review.audibleCoverageMs : 0

  function startReview() {
    if (!scan.analysis || !timeline) return
    syncReview({
      ranges: scan.analysis.ranges.map((range) => ({
        id: `${range.startMs}-${range.endMs}`,
        startMs: range.startMs,
        endMs: range.endMs,
      })),
      removedMs: scan.analysis.removedMs,
      audibleCoverageMs: scan.analysis.audibleCoverageMs,
      hasLockedBlockers: scan.analysis.hasLockedBlockers,
      analyzedTimeline: timeline,
    })
  }

  function applyReview() {
    if (!review || includedRanges.length === 0 || review.hasLockedBlockers) return
    setIsApplying(true)
    // One command = one undo step; the engine merges overlaps and applies the
    // batch latest-first so source coordinates stay correct mid-flight.
    const ok = execute(
      createRippleDeleteRangesCommand(
        includedRanges.map(({ startMs, endMs }) => ({ startMs, endMs })),
      ),
    )
    setIsApplying(false)
    if (!ok) {
      toast({
        variant: "error",
        title: "Smart Cut could not be applied",
        description: "The selected ranges are invalid for the current timeline.",
      })
      return
    }
    clearReview()
    toast({
      variant: "success",
      title: "Silences removed",
      description: `${includedRanges.length} ${includedRanges.length === 1 ? "range" : "ranges"} cut — ${formatSaved(includedRemovedMs)} saved. Press Ctrl+Z to undo.`,
    })
  }

  const controlsDisabled = isApplying
  const detectedCount = scan.analysis?.ranges.length ?? 0

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-surface p-3.5 shadow-xs">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Scissors className="size-4 text-secondary" aria-hidden />
          <h3 className="text-sm font-semibold text-foreground">Smart Cut</h3>
          <ProBadge />
        </div>
        {detectedCount > 0 ? (
          <Badge variant="accent" className="text-[10px] font-mono">
            {detectedCount} found
          </Badge>
        ) : null}
        {review ? (
          <IconButton
            label="Dismiss review"
            size="sm"
            variant="ghost"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={clearReview}
          >
            <X className="size-3.5" aria-hidden />
          </IconButton>
        ) : null}
      </div>

      {metadataPending ? (
        <div className="flex flex-col gap-1.5" aria-busy="true" aria-live="polite">
          <Skeleton className="h-10 w-full rounded-md" />
          <span className="px-0.5 text-[10px] text-subtle-foreground">Loading media info…</span>
        </div>
      ) : !hasAudio ? (
        <EmptyState
          icon={VolumeOff}
          title="No audio recorded"
          description="This recording has no audio streams, so there is nothing to analyze."
          className="px-4 py-6"
        />
      ) : (
        <>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Removes dead air where the recording stays silent. Tune sensitivity, then review every
            cut before applying.
          </p>

          <SmartCutControls
            thresholdDb={thresholdDb}
            isAuto={isAutoThreshold}
            onSensitivityChange={(db) => setManualDb(db)}
            onAutoSelect={() => setManualDb(null)}
            minDurationMs={minDurationMs}
            onMinDurationChange={setMinDurationMs}
            paddingMs={paddingMs}
            onPaddingChange={setPaddingMs}
            disabled={controlsDisabled}
          />

          {scan.status === "loading" || scan.status === "scanning" ? (
            <div className="flex flex-col gap-1.5" aria-busy="true" aria-live="polite">
              <Skeleton className="h-10 w-full rounded-md" />
              <span className="px-0.5 text-[10px] text-subtle-foreground">
                {scan.status === "loading"
                  ? "Preparing audio analysis…"
                  : "Deep scanning audio with FFmpeg…"}
              </span>
            </div>
          ) : scan.status === "error" ? (
            <div className="flex flex-col gap-2 rounded-md border border-recording/25 bg-recording/5 p-2.5">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
                <AlertTriangle className="size-3.5 text-recording" aria-hidden />
                Analysis failed
              </div>
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                {scan.error ?? "The audio could not be analyzed."}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-fit text-xs"
                onClick={scan.retry}
              >
                Retry
              </Button>
            </div>
          ) : scan.analysis && scan.analysis.audibleCoverageMs === 0 && !review ? (
            <EmptyState
              icon={VolumeOff}
              title="No audible audio"
              description="All audio tracks are muted or at zero volume — unmute one so Smart Cut can measure where the recording goes quiet."
              className="px-4 py-6"
            />
          ) : scan.analysis && scan.analysis.ranges.length === 0 && !review ? (
            <EmptyState
              icon={VolumeOff}
              title="No silent gaps found"
              description="Raise the sensitivity or lower the minimum silence to catch shorter, quieter pauses."
              className="px-4 py-6"
            />
          ) : null}

          {/* Overview strip — drawn whenever envelope data exists so the user
              sees detection react to the controls before committing to review. */}
          {scan.envelope && scan.analysis ? (
            <SilenceOverviewStrip
              envelope={scan.envelope}
              ranges={
                review?.ranges ??
                scan.analysis.ranges.map((range) => ({
                  id: `${range.startMs}-${range.endMs}`,
                  startMs: range.startMs,
                  endMs: range.endMs,
                }))
              }
              excludedIds={review?.excludedIds ?? []}
              durationMs={timelineDurationMs}
              onSeek={seek}
            />
          ) : null}

          {review ? (
            <div className="flex flex-col gap-2.5">
              {review.ranges.length === 0 ? (
                <EmptyState
                  icon={VolumeOff}
                  title="No silences at these settings"
                  description="Adjust sensitivity or minimum silence to try again."
                  className="px-4 py-6"
                />
              ) : (
                <SilenceRangeList
                  ranges={review.ranges}
                  excludedIds={review.excludedIds}
                  onToggle={toggleRangeExcluded}
                  onToggleAll={setAllExcluded}
                  onSeek={seek}
                />
              )}

              {review.hasLockedBlockers ? (
                <div className="flex items-start gap-1.5 rounded-md border border-warning/25 bg-warning/10 px-2.5 py-2">
                  <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
                  <p className="text-[10px] leading-relaxed text-foreground">
                    A locked track or clip would be left uncut and desync the timeline. Unlock
                    everything to apply Smart Cut.
                  </p>
                </div>
              ) : coverageShare > 0.9 ? (
                <div className="flex items-start gap-1.5 rounded-md border border-warning/25 bg-warning/10 px-2.5 py-2">
                  <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
                  <p className="text-[10px] leading-relaxed text-foreground">
                    This removes over 90% of the audible timeline — raise sensitivity and check each
                    range before applying.
                  </p>
                </div>
              ) : null}

              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 flex-1 text-xs"
                  onClick={clearReview}
                  disabled={isApplying}
                >
                  Dismiss
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-7 flex-1 text-xs font-semibold"
                  disabled={includedRanges.length === 0 || isApplying || review.hasLockedBlockers}
                  title={
                    review.hasLockedBlockers
                      ? "Unlock all tracks and clips to apply Smart Cut"
                      : undefined
                  }
                  onClick={applyReview}
                >
                  <Check className="size-3.5" data-icon="inline-start" />
                  <span>
                    {includedRanges.length === 0
                      ? "Nothing selected"
                      : `Cut ${includedRanges.length} ${
                          includedRanges.length === 1 ? "silence" : "silences"
                        } · −${formatSaved(includedRemovedMs)}`}
                  </span>
                </Button>
              </div>
            </div>
          ) : scan.analysis && scan.analysis.ranges.length > 0 ? (
            <Button
              variant="secondary"
              size="sm"
              className="h-8 w-full text-xs font-semibold shadow-xs"
              onClick={startReview}
            >
              <Scissors className="size-3.5" data-icon="inline-start" />
              <span>
                Review & cut {scan.analysis.ranges.length}{" "}
                {scan.analysis.ranges.length === 1 ? "silence" : "silences"} · saves{" "}
                {formatSaved(scan.analysis.removedMs)}
              </span>
            </Button>
          ) : null}
        </>
      )}
    </div>
  )
}
