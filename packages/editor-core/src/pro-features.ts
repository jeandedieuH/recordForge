import type { ProjectExportSettings, TextClip, TimelineState } from "@recordforge/contracts"
import type { ProFeatureKey } from "@recordforge/contracts"
import { canvasIsSixteenNine, canvasResolutionTier } from "./composition"

/**
 * Free/Pro feature analysis for the timeline — the TS mirror of the Rust
 * enforcement in `licensing/entitlements.rs`. The UI uses this for PRO
 * badges, the "Pro features in use" chip, and the export gate dialog; Rust
 * re-checks independently at export admission, so the two must agree.
 */

export const CLEAN_TEXT_TEMPLATE = "clean" as const

// Projects saved before the v2 redesign still carry v1 ids until migrated;
// treat the v1 clean-text id as free too so un-migrated data stays honest.
const FREE_TITLE_TEMPLATES = new Set([CLEAN_TEXT_TEMPLATE, "clean-text"])

export interface ProFeatureUsage {
  feature: ProFeatureKey
  /** How many timeline items trigger the requirement (e.g. "3 annotations"). */
  count: number
  /** Human-readable summary for badges/dialogs. */
  detail: string
}

export interface ProUsageAnalysis {
  /** Pro requirements present in the export, in stable feature order. */
  features: ProFeatureUsage[]
  requiresPro: boolean
  /**
   * Informational: canvas sits above the 1080p tier, so a Free export is
   * downscaled rather than blocked.
   */
  outputCappedTo1080p: boolean
}

/** Only Clean Title is Free; a missing design means a pre-template preset — Pro. */
export function textClipIsFree(clip: TextClip): boolean {
  return clip.titleDesign != null && FREE_TITLE_TEMPLATES.has(clip.titleDesign.template)
}

const HIGH_RES_PRESETS = new Set(["ultra-4k", "ultra-4k-60"])
const NON_STANDARD_PRESETS = new Set(["vertical", "square"])

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? `1 ${singular}` : `${count} ${plural}`
}

function enabledClips(state: TimelineState, kind: "annotation" | "text" | "camera") {
  return state.tracks
    .filter((track) => !track.muted)
    .flatMap((track) => track.clips)
    .filter((clip) => clip.kind === kind)
    .filter((clip) => {
      if (clip.kind === "camera") return clip.transform.visible !== false
      return !("enabled" in clip) || clip.enabled !== false
    })
}

/**
 * Analyze which Pro features a timeline + export-settings pair would use.
 * `settings` may be omitted for a timeline-only check (badges), in which case
 * chapter output defaults to the export default (`embed`).
 */
export function analyzeProFeatureUsage(
  timeline: TimelineState,
  settings?: Pick<ProjectExportSettings, "preset" | "chapterMode"> & {
    container?: ProjectExportSettings["container"]
    codec?: ProjectExportSettings["codec"]
    keystrokeOverlay?: { enabled: boolean }
  },
): ProUsageAnalysis {
  const features: ProFeatureUsage[] = []
  const push = (feature: ProFeatureKey, count: number, detail: string) => {
    if (count <= 0 || features.some((entry) => entry.feature === feature)) return
    features.push({ feature, count, detail })
  }

  if (settings?.preset && HIGH_RES_PRESETS.has(settings.preset)) {
    push("high-res-export", 1, "4K export preset")
  }

  if (settings?.codec === "prores") {
    push("prores-export", 1, "ProRes movie")
  }

  const nonStandardRatio =
    !canvasIsSixteenNine(timeline.canvas) ||
    (settings?.preset ? NON_STANDARD_PRESETS.has(settings.preset) : false)
  if (nonStandardRatio) {
    push("custom-aspect-ratio", 1, `${timeline.canvas.width}×${timeline.canvas.height} canvas`)
  }

  const chapterMode = settings?.chapterMode ?? "embed"
  if (chapterMode !== "none" && timeline.markers.length > 0) {
    push("chapters", timeline.markers.length, pluralize(timeline.markers.length, "chapter"))
  }

  const premiumTexts = enabledClips(timeline, "text").filter(
    (clip): clip is TextClip => clip.kind === "text" && !textClipIsFree(clip),
  )
  if (premiumTexts.length > 0) {
    push("premium-titles", premiumTexts.length, pluralize(premiumTexts.length, "title preset"))
  }

  const annotations = enabledClips(timeline, "annotation")
  if (annotations.length > 0) {
    push("annotations", annotations.length, pluralize(annotations.length, "annotation"))
  }

  if (settings?.keystrokeOverlay?.enabled) {
    push("keystroke-overlay", 1, "keystroke badges")
  }

  // M2 effects (ADR 020). Motion blur and Glass Loupe are Pro; zoom clarity
  // (#3) is Free and deliberately absent here.
  if (timeline.canvas.motionBlur?.enabled) {
    push("motion-blur", 1, "Motion blur")
  }

  const loupes = (timeline.zoomSegments ?? []).filter(
    (segment) => segment.enabled && segment.style === "loupe",
  )
  if (loupes.length > 0) {
    push("glass-loupe", loupes.length, pluralize(loupes.length, "Glass Loupe zoom"))
  }

  // M4 camera AI. Colour grading is Free and intentionally absent here.
  const cameraClips = enabledClips(timeline, "camera")
  const cutouts = cameraClips.filter((clip) => clip.kind === "camera" && clip.cutout?.enabled)
  if (cutouts.length > 0) {
    push("camera-cutout", cutouts.length, pluralize(cutouts.length, "camera cutout"))
  }
  const tracked = cameraClips.filter((clip) => clip.kind === "camera" && clip.faceTracking?.enabled)
  if (tracked.length > 0) {
    push("face-tracking", tracked.length, pluralize(tracked.length, "face-tracked camera"))
  }
  const silenceLayouts = (timeline.cameraLayouts ?? []).filter(
    (segment) => segment.enabled && segment.source === "silence",
  )
  if (silenceLayouts.length > 0) {
    push(
      "hide-during-silence",
      silenceLayouts.length,
      pluralize(silenceLayouts.length, "silence camera layout"),
    )
  }

  return {
    features,
    requiresPro: features.length > 0,
    outputCappedTo1080p: canvasResolutionTier(timeline.canvas) !== "1080p",
  }
}
