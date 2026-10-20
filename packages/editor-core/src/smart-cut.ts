// Smart Cut analysis — silence detection over the recording's capture-audio
// waveform envelopes, evaluated directly in timeline time.
//
// Detection runs on the per-stream peak JSON the prepare job already produces
// for the timeline renderer, so analysis is instant and can re-run on every
// control tweak without decoding media again. Ranges come back in *timeline*
// milliseconds — clip trims, splits, moves, and speed changes are respected
// because each clip's own source window is what is measured.
//
// Semantics (matching the Rust silencedetect fallback): a timeline position is
// "dead air" only when it is covered by at least one audible capture clip and
// EVERY covering audible clip is below the amplitude threshold there. Regions
// covered by a clip whose waveform could not be resolved are protected —
// unknown audio is never cut.

import type { AudioClip, SilenceRange, TimelineClip, TimelineState } from "@recordforge/domain"

// Minimal structural view of the prepared waveform derivative. Kept local so
// the engine stays free of app-layer imports; the desktop renderer's
// `WaveformLike`/`WaveformData` already satisfy it.
export interface SmartCutWaveform {
  sampleRate: number
  samplesPerPeak: number
  peaks: number[]
  mins?: number[]
}

export interface SmartCutOptions {
  /** Silence noise floor in dBFS (e.g. -38). Windows below it count as silent. */
  thresholdDb: number
  /** Minimum detected pause length before shrinking, in ms. */
  minDurationMs: number
  /** Audio kept inside each boundary so speech onsets/offsets are not clipped. */
  paddingMs: number
}

export interface SmartCutAnalysis {
  /** Dead-air ranges in timeline milliseconds, ready for ripple-delete-ranges. */
  ranges: SilenceRange[]
  /** Total dead-air time the ranges would remove, in ms. */
  removedMs: number
  /** Audible coverage considered, in ms — basis for the "removes almost all" guard. */
  audibleCoverageMs: number
  /** True when a locked clip/track inside coverage would desync the cut. */
  hasLockedBlockers: boolean
}

/** Default controls; sensitivity defaults to `estimateSilenceThresholdDb`. */
export const SMART_CUT_DEFAULTS = {
  minDurationMs: 500,
  paddingMs: 80,
} as const

// A cut shorter than this is not worth a splice point pair.
const MIN_KEPT_RANGE_MS = 60
// Percentile of per-window amplitudes treated as the recording's noise floor.
const NOISE_FLOOR_PERCENTILE = 0.2
// Headroom above the estimated noise floor for the auto threshold (+12 dB).
const NOISE_FLOOR_HEADROOM = 4

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Milliseconds of source audio covered by one peak window. */
export function waveformWindowMs(waveform: SmartCutWaveform): number {
  if (waveform.sampleRate <= 0 || waveform.samplesPerPeak <= 0) return 100
  return (waveform.samplesPerPeak / waveform.sampleRate) * 1000
}

/** Absolute envelope amplitude (0..1+) of one window. */
function windowAmplitude(waveform: SmartCutWaveform, index: number): number {
  const peak = waveform.peaks[index] ?? 0
  const min = waveform.mins?.[index]
  return min === undefined ? Math.abs(peak) : Math.max(Math.abs(peak), Math.abs(min))
}

interface AudibleClip {
  clip: AudioClip
  waveform: SmartCutWaveform | null
}

// Capture audio = clips carrying a recording stream index on an unmuted,
// non-silent track. Imported audio assets have no stream index and neither
// veto nor extend coverage (by design: Smart Cut removes dead air in the
// recording regardless of added music/SFX).
function collectCaptureAudioClips(state: TimelineState): AudioClip[] {
  const clips: AudioClip[] = []
  for (const track of state.tracks) {
    if (track.kind !== "audio" || track.muted) continue
    for (const clip of track.clips) {
      if (clip.kind !== "audio") continue
      if ((clip.volume ?? 1) <= 0) continue
      if (clip.streamIndex === undefined) continue
      clips.push(clip)
    }
  }
  return clips
}

function collectAudibleClips(
  state: TimelineState,
  waveformsByStream: ReadonlyMap<number, SmartCutWaveform>,
): AudibleClip[] {
  return collectCaptureAudioClips(state).map((clip) => ({
    clip,
    waveform:
      clip.streamIndex === undefined ? null : (waveformsByStream.get(clip.streamIndex) ?? null),
  }))
}

interface Interval {
  startMs: number
  endMs: number
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return []
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  const merged: Interval[] = [{ ...sorted[0]! }]
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]!
    const last = merged[merged.length - 1]!
    if (current.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, current.endMs)
    } else {
      merged.push({ ...current })
    }
  }
  return merged
}

// Subtract `active` from `covered`, returning the leftover sub-intervals.
function subtractIntervals(covered: Interval[], active: Interval[]): Interval[] {
  const result: Interval[] = []
  for (const span of covered) {
    let cursor = span.startMs
    for (const cut of active) {
      if (cut.endMs <= cursor || cut.startMs >= span.endMs) continue
      if (cut.startMs > cursor) result.push({ startMs: cursor, endMs: cut.startMs })
      cursor = Math.max(cursor, cut.endMs)
      if (cursor >= span.endMs) break
    }
    if (cursor < span.endMs) result.push({ startMs: cursor, endMs: span.endMs })
  }
  return result
}

function clipIsLocked(clip: TimelineClip): boolean {
  return "locked" in clip && Boolean((clip as { locked?: boolean }).locked)
}

/** True when a locked track or clip would survive a range cut and desync A/V. */
export function hasLockedCutBlockers(state: TimelineState): boolean {
  for (const track of state.tracks) {
    if (track.locked && track.clips.length > 0) return true
    if (track.clips.some(clipIsLocked)) return true
  }
  return false
}

/** Timeline ms covered by at least one audible capture clip. */
export function captureAudioCoverageMs(state: TimelineState): number {
  return mergeIntervals(
    collectCaptureAudioClips(state).map((clip) => ({
      startMs: clip.startMs,
      endMs: clip.startMs + clip.durationMs,
    })),
  ).reduce((total, range) => total + (range.endMs - range.startMs), 0)
}

// Timeline spans where a clip's stream envelope is at/above the threshold.
// Runs are detected in source-window space then projected through the clip's
// trim/speed map, so speed ramps and trimmed heads/tails land correctly.
function activityIntervalsForClip(
  clip: AudioClip,
  waveform: SmartCutWaveform,
  thresholdAmp: number,
): Interval[] {
  const windowMs = waveformWindowMs(waveform)
  const sourceStart = clip.sourceInMs
  const sourceEnd = Math.max(clip.sourceInMs, clip.sourceOutMs)
  if (sourceEnd <= sourceStart || clip.speed <= 0) return []

  const firstWindow = Math.max(0, Math.floor(sourceStart / windowMs))
  const lastWindow = Math.min(waveform.peaks.length, Math.ceil(sourceEnd / windowMs))
  const runs: Interval[] = []
  let runStart: number | null = null
  for (let i = firstWindow; i < lastWindow; i++) {
    if (windowAmplitude(waveform, i) >= thresholdAmp) {
      if (runStart === null) runStart = Math.max(i * windowMs, sourceStart)
    } else if (runStart !== null) {
      runs.push({ startMs: runStart, endMs: Math.min(i * windowMs, sourceEnd) })
      runStart = null
    }
  }
  if (runStart !== null) runs.push({ startMs: runStart, endMs: sourceEnd })

  return runs.map((run) => ({
    startMs: clip.startMs + (run.startMs - clip.sourceInMs) / clip.speed,
    endMs: clip.startMs + (run.endMs - clip.sourceInMs) / clip.speed,
  }))
}

/**
 * Estimate a silence threshold from the recordings' noise floor: the 20th
 * percentile of window amplitudes across all streams plus 12 dB of headroom,
 * clamped to a sane speech range. Returns dBFS.
 */
export function estimateSilenceThresholdDb(waveforms: SmartCutWaveform[]): number {
  const amplitudes: number[] = []
  for (const waveform of waveforms) {
    for (let i = 0; i < waveform.peaks.length; i++) {
      amplitudes.push(windowAmplitude(waveform, i))
    }
  }
  if (amplitudes.length === 0) return -38
  amplitudes.sort((a, b) => a - b)
  const floor =
    amplitudes[
      clamp(Math.floor(amplitudes.length * NOISE_FLOOR_PERCENTILE), 0, amplitudes.length - 1)
    ]!
  const thresholdDb = 20 * Math.log10(Math.max(floor, 1e-5) * NOISE_FLOOR_HEADROOM)
  return clamp(Math.round(thresholdDb), -58, -24)
}

/**
 * Detect dead-air ranges in timeline time. `waveformsByStream` maps the
 * recording's audio stream index to its prepared waveform peaks.
 */
export function analyzeSilenceRanges(
  state: TimelineState,
  waveformsByStream: ReadonlyMap<number, SmartCutWaveform>,
  options: SmartCutOptions,
): SmartCutAnalysis {
  const audibleClips = collectAudibleClips(state, waveformsByStream)
  const thresholdAmp = Math.pow(10, options.thresholdDb / 20)

  const coverage: Interval[] = []
  const activity: Interval[] = []
  const protectedSpans: Interval[] = []

  for (const { clip, waveform } of audibleClips) {
    const span: Interval = {
      startMs: clip.startMs,
      endMs: clip.startMs + clip.durationMs,
    }
    if (waveform) {
      coverage.push(span)
      activity.push(...activityIntervalsForClip(clip, waveform, thresholdAmp))
    } else {
      // No waveform for this stream — never cut through unknown audio.
      protectedSpans.push(span)
    }
  }
  // A locked track/clip anywhere blocks the cut — ripple-delete skips it,
  // which would desync every other track against it.
  const hasLockedBlockers = hasLockedCutBlockers(state)

  const coverageUnion = mergeIntervals(coverage)
  const activityUnion = mergeIntervals(activity)
  const protectedUnion = mergeIntervals(protectedSpans)
  const silent = subtractIntervals(subtractIntervals(coverageUnion, activityUnion), protectedUnion)

  const minKeep = Math.max(MIN_KEPT_RANGE_MS, options.paddingMs / 2)
  const ranges: SilenceRange[] = silent
    .filter((range) => range.endMs - range.startMs >= options.minDurationMs)
    .map((range) => ({
      startMs: Math.round(range.startMs + options.paddingMs),
      endMs: Math.round(range.endMs - options.paddingMs),
    }))
    .filter((range) => range.endMs - range.startMs >= minKeep)

  const removedMs = ranges.reduce((total, range) => total + (range.endMs - range.startMs), 0)
  const audibleCoverageMs = coverageUnion.reduce(
    (total, range) => total + (range.endMs - range.startMs),
    0,
  )
  return { ranges, removedMs, audibleCoverageMs, hasLockedBlockers }
}

/**
 * Convert source-media silence ranges (e.g. the Rust `detect_silences`
 * fallback) into timeline ranges through every audible clip's trim/speed map.
 * Portions that land outside all audible coverage are dropped.
 */
export function mapSourceRangesToTimeline(
  state: TimelineState,
  ranges: SilenceRange[],
  options?: { paddingMs?: number; minKeepMs?: number },
): SilenceRange[] {
  const padding = options?.paddingMs ?? 0
  const minKeep = Math.max(options?.minKeepMs ?? MIN_KEPT_RANGE_MS, padding / 2)
  const mapped: Interval[] = []

  for (const range of ranges) {
    for (const clip of collectCaptureAudioClips(state)) {
      const start = Math.max(range.startMs, clip.sourceInMs)
      const end = Math.min(range.endMs, clip.sourceOutMs)
      if (end <= start || clip.speed <= 0) continue
      mapped.push({
        startMs: clip.startMs + (start - clip.sourceInMs) / clip.speed,
        endMs: clip.startMs + (end - clip.sourceInMs) / clip.speed,
      })
    }
  }

  return mergeIntervals(mapped)
    .map((range) => ({
      startMs: Math.round(range.startMs + padding),
      endMs: Math.round(range.endMs - padding),
    }))
    .filter((range) => range.endMs - range.startMs >= minKeep)
}

/**
 * Timeline-time loudness envelope for the overview strip: for each bucket the
 * loudest covering audible clip's amplitude. Gaps and muted coverage read 0,
 * so the strip honestly shows "what you'd hear" on the timeline.
 */
export function timelineEnvelope(
  state: TimelineState,
  waveformsByStream: ReadonlyMap<number, SmartCutWaveform>,
  options?: { maxBuckets?: number; durationMs?: number },
): { bucketMs: number; amplitudes: number[] } {
  const audibleClips = collectAudibleClips(state, waveformsByStream).filter(
    ({ waveform }) => waveform !== null,
  )
  const coverage = mergeIntervals(
    audibleClips.map(({ clip }) => ({
      startMs: clip.startMs,
      endMs: clip.startMs + clip.durationMs,
    })),
  )
  const coverageEnd = coverage.reduce((max, span) => Math.max(max, span.endMs), 0)
  const durationMs = Math.max(options?.durationMs ?? 0, coverageEnd)
  if (durationMs <= 0) return { bucketMs: 100, amplitudes: [] }

  const maxBuckets = Math.max(64, options?.maxBuckets ?? 480)
  const bucketMs = Math.max(20, durationMs / maxBuckets)
  const bucketCount = Math.ceil(durationMs / bucketMs)
  const amplitudes = new Array<number>(bucketCount).fill(0)

  for (const { clip, waveform } of audibleClips) {
    if (!waveform || clip.speed <= 0) continue
    const windowMs = waveformWindowMs(waveform)
    const clipStart = clip.startMs
    const clipEnd = clip.startMs + clip.durationMs
    const firstBucket = Math.max(0, Math.floor(clipStart / bucketMs))
    const lastBucket = Math.min(bucketCount, Math.ceil(clipEnd / bucketMs))
    for (let b = firstBucket; b < lastBucket; b++) {
      const timelineMs = (b + 0.5) * bucketMs
      if (timelineMs < clipStart || timelineMs >= clipEnd) continue
      const sourceMs = clip.sourceInMs + (timelineMs - clipStart) * clip.speed
      const windowIndex = Math.floor(sourceMs / windowMs)
      if (windowIndex < 0 || windowIndex >= waveform.peaks.length) continue
      const amplitude = windowAmplitude(waveform, windowIndex)
      if (amplitude > amplitudes[b]!) amplitudes[b] = amplitude
    }
  }
  return { bucketMs, amplitudes }
}

/**
 * Combined per-window envelope across every capture stream — the "what you'd
 * hear" curve the overview strip draws and the threshold slider shades.
 * Bucketed in source time at the finest input resolution.
 */
export function combinedWaveformEnvelope(waveforms: SmartCutWaveform[]): {
  windowMs: number
  amplitudes: number[]
} {
  let windowMs = Infinity
  for (const waveform of waveforms) {
    windowMs = Math.min(windowMs, waveformWindowMs(waveform))
  }
  if (!Number.isFinite(windowMs)) return { windowMs: 100, amplitudes: [] }
  const windowCount = Math.max(
    0,
    ...waveforms.map((waveform) =>
      Math.ceil((waveform.peaks.length * waveformWindowMs(waveform)) / windowMs),
    ),
  )
  const amplitudes = new Array<number>(windowCount).fill(0)
  for (const waveform of waveforms) {
    const streamWindowMs = waveformWindowMs(waveform)
    for (let i = 0; i < waveform.peaks.length; i++) {
      // A coarser window overlaps several output buckets.
      const from = Math.floor((i * streamWindowMs) / windowMs)
      const to = Math.ceil(((i + 1) * streamWindowMs) / windowMs)
      const amplitude = windowAmplitude(waveform, i)
      for (let b = from; b < Math.min(to, windowCount); b++) {
        if (amplitude > amplitudes[b]!) amplitudes[b] = amplitude
      }
    }
  }
  return { windowMs, amplitudes }
}
