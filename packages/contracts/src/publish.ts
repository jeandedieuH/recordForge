import { z } from "zod"

// YouTube Data API v3 publishing — direct-to-YouTube upload from an exported
// MP4. OAuth uses the same loopback+PKCE flow as Google Drive; the refresh
// token lives in the OS credential vault and never crosses to the frontend.

export const youtubePrivacySchema = z.enum(["private", "unlisted", "public"])
export type YouTubePrivacy = z.infer<typeof youtubePrivacySchema>

// Publish a FINISHED EXPORT — the video path, captions sidecar, and title
// come from the job's frozen artifact natively; callers pick the job and
// the audience, never raw media paths.
export const youtubePublishRequestSchema = z.object({
  exportJobId: z.string().min(1),
  // Caller-generated idempotency key (UUID) — replaying the same id + same
  // request returns the existing publication job instead of re-uploading.
  operationId: z.string().min(1),
  // Explicit audience — private/unlisted/public; defaults least public.
  privacy: youtubePrivacySchema.default("unlisted"),
  // Optional title override (1-100 chars); the frozen manifest title is the
  // default when omitted.
  title: z.string().min(1).max(100).optional(),
  description: z.string().max(5000).default(""),
  // YouTube category 28 = Science & Technology; fits software demos.
  categoryId: z.string().default("28"),
  tags: z.array(z.string()).default([]),
  // Explicit opt-in — without it the export's sidecar is never attached.
  captions: z.boolean().default(false),
  captionsLanguage: z.string().default("en"),
})
export type YouTubePublishRequest = z.infer<typeof youtubePublishRequestSchema>

export const youtubeConnectionSchema = z.object({
  connected: z.boolean(),
  accountLabel: z.string().nullable(),
})
export type YouTubeConnection = z.infer<typeof youtubeConnectionSchema>

// `youtube-oauth-completed` — correlated by the flow's own state.
export const youtubeOAuthCompletedSchema = z.object({
  success: z.boolean(),
  accountLabel: z.string().nullable(),
  error: z.string().nullable(),
  state: z.string(),
})
export type YouTubeOAuthCompleted = z.infer<typeof youtubeOAuthCompletedSchema>
export const YOUTUBE_OAUTH_COMPLETED_EVENT = "youtube-oauth-completed" as const

/* ---------- Publication jobs (Instant Share / BYO / YouTube) ---------- */

export const publicationProviderSchema = z.enum(["hosted", "s3", "youTube"])
export type PublicationProvider = z.infer<typeof publicationProviderSchema>

// Job lifecycle — mirrors PublicationStatus in publish/jobs.rs. `uncertain`
// means provider state could not be confirmed (e.g. a lost finalization
// reply); it is never auto-retried.
export const publicationStatusSchema = z.enum([
  "checking",
  "uploading",
  "finalizing",
  "attachingCaptions",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "uncertain",
])
export type PublicationStatus = z.infer<typeof publicationStatusSchema>

export const publicationShareResultSchema = z.object({
  shareId: z.string(),
  url: z.string(),
})
export type PublicationShareResult = z.infer<typeof publicationShareResultSchema>

export const publicationYouTubeResultSchema = z.object({
  videoId: z.string(),
  url: z.string(),
  captionsAttached: z.boolean(),
})
export type PublicationYouTubeResult = z.infer<typeof publicationYouTubeResultSchema>

export const publicationResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("share"), shareId: z.string(), url: z.string() }),
  z.object({
    // Rust serializes the tagged variant as "youtube" — this literal must
    // match the wire value exactly or every terminal YouTube job fails parse.
    kind: z.literal("youtube"),
    videoId: z.string(),
    url: z.string(),
    captionsAttached: z.boolean(),
  }),
])
export type PublicationResult = z.infer<typeof publicationResultSchema>

export const publicationJobSchema = z.object({
  id: z.string(),
  exportJobId: z.string(),
  provider: publicationProviderSchema,
  profileId: z.string().optional(),
  status: publicationStatusSchema,
  uploadedBytes: z.number(),
  totalBytes: z.number(),
  result: publicationResultSchema.optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  warnings: z.array(z.string()).default([]),
  operationId: z.string(),
  // Admission timestamp — orders the list newest-first; the registry's id
  // sort is not chronological.
  admittedAtMs: z.number().int(),
})
export type PublicationJob = z.infer<typeof publicationJobSchema>

export function publicationJobIsActive(job: PublicationJob): boolean {
  return (
    job.status === "checking" ||
    job.status === "uploading" ||
    job.status === "finalizing" ||
    job.status === "attachingCaptions" ||
    job.status === "cancelling"
  )
}

/** Event emitted by Rust for every publication job state change. */
export const PUBLICATION_JOB_EVENT = "publication-job-update" as const

/* ---------- Instant Share ---------- */

// share_export / share_to_profile both take this shape and return the
// admitted publication job — results arrive via the job row.
export const shareExportArgsSchema = z.object({
  exportJobId: z.string().min(1),
  operationId: z.string().min(1),
  allowDownload: z.boolean().default(true),
  allowEmbed: z.boolean().default(true),
  // Hosted shares only — the cloud stores a salted hash and gates the
  // viewer manifest. BYO-bucket shares reject it (a public URL can't gate).
  password: z.string().max(128).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
})
export type ShareExportArgs = z.infer<typeof shareExportArgsSchema>

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
