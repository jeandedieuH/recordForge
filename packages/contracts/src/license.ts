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
  "studio-audio",
  "smart-cut",
  "brand-kit",
  "ai-captions",
  "teleprompter",
  "keystroke-overlay",
  "auto-reframe",
  "youtube-publish",
  "virtual-background",
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
  "studio-audio": {
    label: "Studio Audio",
    description: "Noise reduction and broadcast loudness targets at export.",
  },
  "smart-cut": {
    label: "Smart Cut",
    description: "Remove silences and filler words from the timeline automatically.",
  },
  "brand-kit": {
    label: "Brand Kit",
    description: "Logo watermark, brand colors and fonts, intro and outro cards.",
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
  "virtual-background": {
    label: "Virtual background",
    description: "Blur or replace the webcam backdrop with on-device segmentation.",
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

/* ---------- Instant Share (Phase 2) ---------- */

/**
 * Per-part upload progress for the viewer's live progress bar and the
 * desktop's jobs UI. `parts` counts completed multipart chunks.
 */
export const shareProgressSchema = z.object({
  shareId: z.string(),
  status: z.enum(["uploading", "live", "expired", "revoked"]),
  bytes: z.number().int(),
  partsDone: z.number().int(),
  partsTotal: z.number().int(),
})
export type ShareProgress = z.infer<typeof shareProgressSchema>

/** Result of the `share_export` command — the URL the clipboard gets. */
export const shareResultSchema = z.object({
  shareId: z.string(),
  url: z.string(),
})
export type ShareResult = z.infer<typeof shareResultSchema>

/** Event emitted by Rust during a share upload. */
export const SHARE_PROGRESS_EVENT = "share-progress" as const

/** Hosted share viewer origin — the public link prefix. */
export const SHARE_BASE_URL = "https://share.recordforge.prestigetech.dev"

/** One row in the owner's "Shared links" list (`list_shares`). */
export const shareInfoSchema = z.object({
  shareId: z.string(),
  url: z.string(),
  title: z.string(),
  status: z.enum(["uploading", "live", "expired", "revoked"]),
  bytes: z.number(),
  views: z.number(),
  hasPassword: z.boolean().default(false),
  expiresAtMs: z.number().int(),
  createdAtMs: z.number().int(),
})
export type ShareInfo = z.infer<typeof shareInfoSchema>

/** Owner analytics for one share (Pro Cloud extras). */
export const shareAnalyticsSchema = z.object({
  views: z.number(),
  uniqueViewers: z.number(),
  avgWatchSeconds: z.number(),
  comments: z.number(),
  unresolvedComments: z.number(),
  series: z.array(z.object({ day: z.string(), views: z.number() })),
})
export type ShareAnalytics = z.infer<typeof shareAnalyticsSchema>

export const shareListSchema = z.object({ shares: z.array(shareInfoSchema) })
export type ShareList = z.infer<typeof shareListSchema>

/** Result of renewing a link — the new expiry timestamp. */
export const shareRenewSchema = z.object({ expiresAtMs: z.number().int() })
