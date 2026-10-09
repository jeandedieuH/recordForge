import type {
  AudioMastering,
  BrandCards,
  BrandWatermark,
  ProjectExportSettings,
  TextClip,
  WebcamBackground,
  TimelineState,
} from "@recordforge/contracts"
import type { ProFeatureKey } from "@recordforge/contracts"
import { canvasIsSixteenNine, canvasResolutionTier } from "./composition"

/**
 * Free/Pro feature analysis for the timeline — the TS mirror of the Rust
 * enforcement in `licensing/entitlements.rs`. The UI uses this for PRO
 * badges, the "Pro features in use" chip, and the export gate dialog; Rust
 * re-checks independently at export admission, so the two must agree.
 */

export const CLEAN_TEXT_TEMPLATE = "clean-text" as const

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

/** Only Clean Text is Free; a missing design means a pre-template preset — Pro. */
export function textClipIsFree(clip: TextClip): boolean {
  return clip.titleDesign?.template === CLEAN_TEXT_TEMPLATE
}

const HIGH_RES_PRESETS = new Set(["ultra-4k", "ultra-4k-60"])
const NON_STANDARD_PRESETS = new Set(["vertical", "square"])

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? `1 ${singular}` : `${count} ${plural}`
}

function enabledClips(state: TimelineState, kind: "annotation" | "text") {
  return state.tracks
    .filter((track) => !track.muted)
    .flatMap((track) => track.clips)
    .filter((clip) => clip.kind === kind && clip.enabled !== false)
}

/**
 * Analyze which Pro features a timeline + export-settings pair would use.
 * `settings` may be omitted for a timeline-only check (badges), in which case
 * chapter output defaults to the export default (`embed`).
 */
export function analyzeProFeatureUsage(
  timeline: TimelineState,
  settings?: Pick<ProjectExportSettings, "preset" | "chapterMode"> & {
    audioMastering?: AudioMastering
    brandWatermark?: BrandWatermark
    brandCards?: BrandCards
    keystrokeOverlay?: { enabled: boolean }
    reframeMode?: string
    webcamBackground?: WebcamBackground
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

  // Studio Audio — flags on export settings, not timeline content.
  const mastering = settings?.audioMastering
  if (mastering?.denoise || mastering?.loudnessTarget != null) {
    push("studio-audio", 1, "audio mastering")
  }

  const cards = settings?.brandCards
  const hasCards = cards?.enabled === true && (cards.introMs > 0 || cards.outroMs > 0)
  const hasWatermark = settings?.brandWatermark?.enabled && settings.brandWatermark.logoPath
  if (hasWatermark || hasCards) {
    push(
      "brand-kit",
      1,
      hasWatermark && hasCards ? "brand kit" : hasCards ? "intro/outro cards" : "logo watermark",
    )
  }

  if (settings?.keystrokeOverlay?.enabled) {
    push("keystroke-overlay", 1, "keystroke badges")
  }

  if (settings?.reframeMode && settings.reframeMode !== "fit") {
    push(
      "auto-reframe",
      1,
      settings.reframeMode === "fill" ? "crop to fill" : "cursor-followed crop",
    )
  }

  // Virtual background only does real work when a camera clip is on the
  // timeline — the same condition the Rust gate uses.
  const hasCamera = timeline.tracks.some(
    (track) => !track.muted && track.clips.some((clip) => clip.kind === "camera"),
  )
  if (hasCamera && settings?.webcamBackground?.enabled) {
    push(
      "virtual-background",
      1,
      settings.webcamBackground.mode === "replace" ? "background replacement" : "background blur",
    )
  }

  return {
    features,
    requiresPro: features.length > 0,
    outputCappedTo1080p: canvasResolutionTier(timeline.canvas) !== "1080p",
  }
}
