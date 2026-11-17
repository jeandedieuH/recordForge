import { submitReviewResponseSchema } from "@recordforge/contracts"
import { invokeValidated } from "./ipc"

export type SubmitReviewInput = {
  rating: number
  reviewText?: string
  displayName?: string
}

/**
 * Send a star rating + optional written review to the marketing site's
 * review queue. Rust fills in tier/appVersion/os server-side — this call
 * only carries the user-visible fields. Reviews are moderated before they
 * appear on the site.
 */
export async function submitReview(input: SubmitReviewInput) {
  return invokeValidated("submit_review", input, submitReviewResponseSchema)
}
