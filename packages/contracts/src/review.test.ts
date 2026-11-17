import { describe, expect, it } from "vitest"
import {
  reviewSchema,
  reviewStatsSchema,
  reviewSubmissionSchema,
  submitReviewResponseSchema,
} from "./review"

describe("Review contracts", () => {
  it("parses a minimal rating-only submission", () => {
    const submission = reviewSubmissionSchema.parse({ rating: 5, source: "app" })

    expect(submission.rating).toBe(5)
    expect(submission.text).toBeUndefined()
    expect(submission.tier).toBeUndefined()
  })

  it("parses a full submission from the desktop app", () => {
    const submission = reviewSubmissionSchema.parse({
      rating: 4,
      text: "Solid recorder, exports are fast.",
      name: "Hagen",
      tier: "pro",
      appVersion: "2.5.1",
      os: "windows",
      source: "app",
      website: "",
    })

    expect(submission.tier).toBe("pro")
    expect(submission.source).toBe("app")
  })

  it("rejects ratings outside 1–5 and non-integer values", () => {
    for (const rating of [0, 6, 2.5, -1]) {
      expect(reviewSubmissionSchema.safeParse({ rating, source: "web" }).success).toBe(false)
    }
  })

  it("rejects text over 600 chars and names over 60 chars", () => {
    expect(
      reviewSubmissionSchema.safeParse({ rating: 5, source: "web", text: "x".repeat(601) }).success,
    ).toBe(false)
    expect(
      reviewSubmissionSchema.safeParse({ rating: 5, source: "web", name: "n".repeat(61) }).success,
    ).toBe(false)
  })

  it("rejects unknown tiers and sources", () => {
    expect(
      reviewSubmissionSchema.safeParse({ rating: 5, source: "web", tier: "enterprise" }).success,
    ).toBe(false)
    expect(reviewSubmissionSchema.safeParse({ rating: 5, source: "cli" }).success).toBe(false)
  })

  it("parses the success response and listed testimonials", () => {
    expect(submitReviewResponseSchema.parse({ ok: true }).ok).toBe(true)
    expect(submitReviewResponseSchema.safeParse({ ok: false }).success).toBe(false)

    const review = reviewSchema.parse({
      id: "abc123",
      rating: 5,
      text: null,
      name: null,
      tier: "free",
      createdAt: 1_700_000_000_000,
    })
    expect(review.tier).toBe("free")
  })

  it("parses stats with a nullable average", () => {
    expect(reviewStatsSchema.parse({ count: 0, average: null }).average).toBeNull()
    expect(reviewStatsSchema.parse({ count: 3, average: 4.67 }).count).toBe(3)
  })
})
