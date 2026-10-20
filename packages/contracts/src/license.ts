import { z } from "zod"

/**
 * Pro feature keys gated behind a RecordForge Pro license. Keys are a map
 * (per repo conventions) — the ordered tuple exists only so Zod can validate
 * incoming feature lists.
 */
export const PRO_FEATURE_KEYS = [
  "high-res-export",
  "custom-aspect-ratio",
  "chapters",
  "premium-titles",
  "annotations",
  "instant-share",
  "smart-cut",
  "ai-captions",
  "teleprompter",
  "keystroke-overlay",
  "auto-reframe",
  "youtube-publish",
] as const

export const proFeatureKeySchema = z.enum(PRO_FEATURE_KEYS)
export type ProFeatureKey = z.infer<typeof proFeatureKeySchema>

export interface ProFeature {
  label: string
  description: string
}

/** Display metadata for each Pro gate; Rust returns only the keys. */
export const PRO_FEATURES: Record<ProFeatureKey, ProFeature> = {
  "high-res-export": {
    label: "High-resolution export",
    description: "Export at 1440p or 4K with the Ultra 4K presets.",
  },
  "custom-aspect-ratio": {
    label: "Custom aspect ratios",
    description: "Vertical, square, and other non-16:9 canvases and presets.",
  },
  chapters: {
    label: "Chapters & markers",
    description: "Embedded chapters, chapter sidecar files, and YouTube timestamps.",
  },
  "premium-titles": {
    label: "Pro title presets",
    description: "Every text preset beyond Clean Text.",
  },
  annotations: {
    label: "Annotations",
    description: "Shapes, arrows, and callouts drawn over the canvas.",
  },
  "instant-share": {
    label: "Instant Share",
    description: "One click, one link — hosted web delivery of your export.",
  },
  "smart-cut": {
    label: "Smart Cut",
    description: "Remove silences and filler words from the timeline automatically.",
  },
  "ai-captions": {
    label: "AI Captions",
    description: "On-device transcription straight into the captions track.",
  },
  teleprompter: {
    label: "Teleprompter",
    description: "Floating speaker notes that never appear in the recording.",
  },
  "keystroke-overlay": {
    label: "Keystroke overlay",
    description: "Show shortcut keys pressed during recording for tutorials.",
  },
  "auto-reframe": {
    label: "Auto-reframe & batch export",
    description:
      "Fill or cursor-followed crops for vertical and square formats, exported as a batch.",
  },
  "youtube-publish": {
    label: "Publish to YouTube",
    description:
      "Upload exports straight to YouTube with chapters, captions, and privacy controls.",
  },
}

export const licenseTierSchema = z.enum(["free", "pro"])
export type LicenseTier = z.infer<typeof licenseTierSchema>

/**
 * Snapshot returned by `get_license_status` and broadcast on the
 * `license-changed` event. `deviceHash` is the salted machine hash (never the
 * raw identifier) so dev tooling can sign tokens for this machine.
 */
export const licenseStatusSchema = z.object({
  tier: licenseTierSchema,
  plan: z.string().nullable(),
  licenseId: z.string().nullable(),
  deviceHash: z.string(),
  deviceLabel: z.string(),
  activatedAtMs: z.number().int().nullable(),
  lastVerifiedAtMs: z.number().int().nullable(),
  serverConfigured: z.boolean(),
  features: z.array(proFeatureKeySchema),
})
export type LicenseStatus = z.infer<typeof licenseStatusSchema>

/** Free-tier exports are downscaled to fit this raster box. */
export const FREE_EXPORT_MAX_WIDTH = 1920
export const FREE_EXPORT_MAX_HEIGHT = 1080

/** Event emitted by Rust whenever the effective license state changes. */
export const LICENSE_CHANGED_EVENT = "license-changed" as const

// Instant Share + publication contracts live in publish.ts.
