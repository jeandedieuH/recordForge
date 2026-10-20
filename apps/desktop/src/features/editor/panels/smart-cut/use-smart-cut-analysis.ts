import { useEffect, useMemo, useState } from "react"
import type { TimelineState } from "@recordforge/contracts"
import {
  analyzeSilenceRanges,
  captureAudioCoverageMs,
  estimateSilenceThresholdDb,
  hasLockedCutBlockers,
  mapSourceRangesToTimeline,
  timelineEnvelope,
  type SmartCutAnalysis,
  type SmartCutOptions,
  type SmartCutWaveform,
} from "@recordforge/editor-core"
import { detectSilences } from "../../../../lib/media"
import { toErrorMessage } from "../../../../lib/errors"
import type { WaveformResources } from "../../media/derivative-resources"

export type SmartCutScanStatus =
  | "idle" // Pro gate or no recording — nothing running
  | "loading" // waveform derivatives still preparing
  | "scanning" // ffmpeg fallback pass in flight
  | "ready" // an analysis result (possibly empty) is available
  | "error"

export interface SmartCutScan {
  status: SmartCutScanStatus
  analysis: SmartCutAnalysis | null
  /** Timeline-time loudness curve for the overview strip (waveform path only). */
  envelope: { bucketMs: number; amplitudes: number[] } | null
  /** Noise-floor threshold suggestion for the Auto sensitivity position. */
  suggestedThresholdDb: number | null
  /** True when results came from the ffmpeg pass rather than peak data. */
  usedFallback: boolean
  error: string | null
  retry: () => void
}

export interface SmartCutScanOptions {
  /** Manual threshold in dBFS, or null to follow the noise-floor estimate. */
  thresholdDb: number | null
  minDurationMs: number
  paddingMs: number
}

interface UseSmartCutAnalysisArgs {
  timeline: TimelineState | null
  waveformResources: WaveformResources
  recordingId: string | undefined
  hasAudio: boolean
  timelineDurationMs: number
  options: SmartCutScanOptions
  enabled: boolean
}

interface FallbackResult {
  /** Param key the pass ran against — stale results are ignored. */
  key: string
  status: "scanning" | "ready" | "error"
  ranges: { startMs: number; endMs: number }[] | null
  error: string | null
}

// Debounce for the ffmpeg fallback — each run decodes the whole file, so it
// only re-fires after the user settles on a control position.
const FALLBACK_DEBOUNCE_MS = 350

export function useSmartCutAnalysis({
  timeline,
  waveformResources,
  recordingId,
  hasAudio,
  timelineDurationMs,
  options,
  enabled,
}: UseSmartCutAnalysisArgs): SmartCutScan {
  const [retryToken, setRetryToken] = useState(0)
  const [fallback, setFallback] = useState<FallbackResult | null>(null)

  // Peaks keyed by stream index — the primary, instant analysis input.
  const waveformsByStream = useMemo(() => {
    const map = new Map<number, SmartCutWaveform>()
    for (const [streamIndex, resource] of waveformResources.byStream) {
      if (resource.status === "content") map.set(streamIndex, resource.data)
    }
    return map
  }, [waveformResources.byStream])

  const waveforms = useMemo(() => [...waveformsByStream.values()], [waveformsByStream])
  const hasPeaks = waveforms.length > 0

  const suggestedThresholdDb = useMemo(
    () => (hasPeaks ? estimateSilenceThresholdDb(waveforms) : null),
    [waveforms, hasPeaks],
  )

  // Auto mode resolves to the estimate once peaks arrive; until then the
  // fallback keeps the first scan within speech territory.
  const resolvedOptions = useMemo<SmartCutOptions>(
    () => ({
      thresholdDb: options.thresholdDb ?? suggestedThresholdDb ?? -38,
      minDurationMs: options.minDurationMs,
      paddingMs: options.paddingMs,
    }),
    [options.thresholdDb, options.minDurationMs, options.paddingMs, suggestedThresholdDb],
  )

  // Instant path: analyze the live timeline against prepared peak envelopes.
  // Recomputed on every edit so review ranges can never go stale.
  const peakAnalysis = useMemo(() => {
    if (!enabled || !timeline || !hasPeaks) return null
    return analyzeSilenceRanges(timeline, waveformsByStream, resolvedOptions)
  }, [enabled, timeline, hasPeaks, waveformsByStream, resolvedOptions])

  const envelope = useMemo(() => {
    if (!timeline || !hasPeaks) return null
    return timelineEnvelope(timeline, waveformsByStream, {
      durationMs: timelineDurationMs,
      maxBuckets: 480,
    })
  }, [timeline, hasPeaks, waveformsByStream, timelineDurationMs])

  // Waveforms never resolve when prepare has not produced them — the ffmpeg
  // fallback covers legacy recordings and deleted derivative files.
  const needsFallback = enabled && hasAudio && waveformResources.status !== "loading" && !hasPeaks

  const fallbackKey = [
    recordingId ?? "",
    resolvedOptions.thresholdDb,
    resolvedOptions.minDurationMs,
    retryToken,
  ].join("|")

  useEffect(() => {
    if (!needsFallback || !recordingId) return
    const key = fallbackKey
    setFallback({ key, status: "scanning", ranges: null, error: null })
    let cancelled = false
    const timer = window.setTimeout(() => {
      detectSilences(recordingId, {
        thresholdDb: resolvedOptions.thresholdDb,
        minDurationMs: resolvedOptions.minDurationMs,
      })
        .then((ranges) => {
          if (!cancelled) setFallback({ key, status: "ready", ranges, error: null })
        })
        .catch((error) => {
          if (!cancelled) {
            setFallback({
              key,
              status: "error",
              ranges: null,
              error: toErrorMessage(error) ?? "The silence scan failed",
            })
          }
        })
    }, FALLBACK_DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [
    fallbackKey,
    needsFallback,
    recordingId,
    resolvedOptions.thresholdDb,
    resolvedOptions.minDurationMs,
  ])

  function retry() {
    if (needsFallback) setRetryToken((token) => token + 1)
    else waveformResources.retry()
  }

  if (!enabled) {
    return {
      status: "idle",
      analysis: null,
      envelope: null,
      suggestedThresholdDb,
      usedFallback: false,
      error: null,
      retry,
    }
  }
  if (hasPeaks && timeline) {
    return {
      status: "ready",
      analysis: peakAnalysis,
      envelope,
      suggestedThresholdDb,
      usedFallback: false,
      error: null,
      retry,
    }
  }
  if (waveformResources.status === "loading") {
    return {
      status: "loading",
      analysis: null,
      envelope: null,
      suggestedThresholdDb,
      usedFallback: false,
      error: null,
      retry,
    }
  }
  if (!hasAudio) {
    return {
      status: "ready",
      analysis: null,
      envelope: null,
      suggestedThresholdDb,
      usedFallback: false,
      error: null,
      retry,
    }
  }
  const current = fallback?.key === fallbackKey ? fallback : null
  if (current?.status === "ready" && current.ranges && timeline) {
    const ranges = mapSourceRangesToTimeline(timeline, current.ranges, {
      paddingMs: resolvedOptions.paddingMs,
    })
    return {
      status: "ready",
      analysis: {
        ranges,
        removedMs: ranges.reduce((total, range) => total + (range.endMs - range.startMs), 0),
        audibleCoverageMs: captureAudioCoverageMs(timeline),
        hasLockedBlockers: hasLockedCutBlockers(timeline),
      },
      envelope: null,
      suggestedThresholdDb,
      usedFallback: true,
      error: null,
      retry,
    }
  }
  if (current?.status === "error") {
    return {
      status: "error",
      analysis: null,
      envelope: null,
      suggestedThresholdDb,
      usedFallback: true,
      error: current.error,
      retry,
    }
  }
  if (waveformResources.status === "error" && !needsFallback) {
    return {
      status: "error",
      analysis: null,
      envelope: null,
      suggestedThresholdDb,
      usedFallback: false,
      error: "Audio analysis data failed to load",
      retry,
    }
  }
  return {
    status: "scanning",
    analysis: null,
    envelope: null,
    suggestedThresholdDb,
    usedFallback: needsFallback,
    error: null,
    retry,
  }
}
