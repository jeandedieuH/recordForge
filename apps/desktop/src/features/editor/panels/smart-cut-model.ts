import type { ProjectExportSettings, TimelineState } from "@recordforge/contracts"
import type { SmartCutRange } from "@recordforge/editor-core"

// Pure Smart Cut model shared by the card, the review list, and tests —
// extracted so review/card have no circular import and every staleness rule
// lives in one place.

export interface SmartCutScanConfig {
  // null = the adaptive RMS calibration; a number is a manual dB floor.
  thresholdDb: number | null
  minDurationMs: number
  paddingMs: number
}

// One ownership token per in-flight scan: only the run that still owns this
// exact identity may write card UI state after an await.
export interface SmartCutRunContext {
  scanId: string
  recordingId: string
  present: TimelineState
  projectRevision: number
  config: SmartCutScanConfig
}

export interface SmartCutResult {
  ranges: SmartCutRange[]
  // True when detections existed but cuts were discarded because they would
  // delete the whole project — a safety bail, not "no pauses".
  wholeTimeline: boolean
  // Calibration context the native scan reported, shown under the results.
  thresholdDb: number
  noiseFloorDb: number | null
  calibration: "adaptive" | "manual"
  config: SmartCutScanConfig
  present: TimelineState
  projectRevision: number
  recordingId: string
  durationMs: number
}

export function smartCutConfigEquals(a: SmartCutScanConfig, b: SmartCutScanConfig): boolean {
  return (
    a.thresholdDb === b.thresholdDb &&
    a.minDurationMs === b.minDurationMs &&
    a.paddingMs === b.paddingMs
  )
}

// The in-flight run is stale as soon as the timeline state, recording,
// revision (autosave bump = persisted change), or scan config moves. Seeking
// is view state and never invalidates.
export function isSmartCutRunStale(
  run: SmartCutRunContext,
  current: {
    present: TimelineState | null | undefined
    recordingId: string | undefined
    projectRevision: number
  },
): boolean {
  return (
    run.present !== current.present ||
    run.recordingId !== current.recordingId ||
    run.projectRevision !== current.projectRevision
  )
}

// A completed result stays reviewable only while the scanned inputs are all
// still committed — including the config that produced it.
export function isSmartCutResultStale(input: {
  result: SmartCutResult | null
  present?: TimelineState | null
  recordingId?: string
  projectRevision?: number
  config: SmartCutScanConfig
}): boolean {
  const { result, present, recordingId, projectRevision, config } = input
  if (!result) return false
  return (
    result.present !== present ||
    result.recordingId !== recordingId ||
    (projectRevision !== undefined && result.projectRevision !== projectRevision) ||
    !smartCutConfigEquals(result.config, config)
  )
}

export function selectedSmartCutRanges(
  ranges: SmartCutRange[],
  selected: ReadonlySet<number>,
): SmartCutRange[] {
  return ranges.filter((_, index) => selected.has(index))
}

// Millisecond precision — a 300ms pause still shows distinct bounds.
export function formatSilenceClock(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  const millis = Math.round(ms % 1000)
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${millis.toString().padStart(3, "0")}`
}

// Silence scanning is audio-only: no captions/chapters sidecars and no
// selected range — everything else mirrors the user's current export
// settings so the measured audio matches what a real export would render.
export function smartCutDetectionSettings(settings: ProjectExportSettings): ProjectExportSettings {
  return {
    ...settings,
    captionMode: "none",
    chapterMode: "none",
    // Full timeline — a selected-range preset would otherwise require a range.
    preset: settings.preset === "selected-range" ? "default-mp4" : settings.preset,
    range: undefined,
  }
}
