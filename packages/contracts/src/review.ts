import { z } from "zod"

/**
 * Star-rating + written review submitted by Free and Pro users, from the
 * desktop app or the marketing site. Submissions land in the Convex
 * `reviews` table as `approved: false` and are curated before they appear
 * as public testimonials.
 *
 * Privacy: no device identifiers, license key/id, or media info — only the
 * fields below. `tier`/`appVersion`/`os` are filled server-side by the
 * desktop command, never trusted from the caller.
 */

export const REVIEW_MAX_TEXT_LENGTH = 600
export const REVIEW_MAX_NAME_LENGTH = 60

export const reviewSourceSchema = z.enum(["app", "web"])
export type ReviewSource = z.infer<typeof reviewSourceSchema>

/** Body accepted by `POST /api/reviews` (and mirrored by the Rust command). */
export const reviewSubmissionSchema = z.object({
  rating: z.number().int().min(1).max(5),
  text: z.string().max(REVIEW_MAX_TEXT_LENGTH).optional(),
  name: z.string().max(REVIEW_MAX_NAME_LENGTH).optional(),
  /** Optional: the website can't tell a visitor's tier — the app always sends it. */
  tier: z.enum(["free", "pro"]).optional(),
  appVersion: z.string().max(40).optional(),
  os: z.string().max(20).optional(),
  source: reviewSourceSchema,
  /** Honeypot — always empty for humans; bots that fill it are dropped. */
  website: z.string().optional(),
})
export type ReviewSubmission = z.infer<typeof reviewSubmissionSchema>

/** `POST /api/reviews` success body; also the `submit_review` result. */
export const submitReviewResponseSchema = z.object({ ok: z.literal(true) })
export type SubmitReviewResponse = z.infer<typeof submitReviewResponseSchema>

/** One approved testimonial as returned by the `reviews:list` query. */
export const reviewSchema = z.object({
  id: z.string(),
  rating: z.number().int().min(1).max(5),
  text: z.string().nullable(),
  name: z.string().nullable(),
  tier: z.enum(["free", "pro"]).nullable(),
  createdAt: z.number(),
})
export type Review = z.infer<typeof reviewSchema>

/** Aggregate shown above the testimonials grid. */
export const reviewStatsSchema = z.object({
  count: z.number().int(),
  average: z.number().nullable(),
})
export type ReviewStats = z.infer<typeof reviewStatsSchema>
