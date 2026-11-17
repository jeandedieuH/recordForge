import { useState } from "react"
import { convexQuery } from "@convex-dev/react-query"
import { useQuery } from "@tanstack/react-query"
import { MessageSquareQuote, PenLine, Star } from "lucide-react"
import {
  Badge,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Skeleton,
} from "@recordforge/ui"
import { api } from "../../../convex/_generated/api"
import { Reveal } from "./reveal"
import { ReviewForm } from "./review-form"
import { SectionHeading } from "./section-heading"

/** Filled star row for a 1–5 rating. */
function Stars({ rating, className }: { rating: number; className?: string }) {
  return (
    <div className={cn("flex gap-0.5", className)} aria-label={`${rating} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((value) => (
        <Star
          key={value}
          className={cn(
            "size-3.5",
            value <= rating ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30",
          )}
          aria-hidden
        />
      ))}
    </div>
  )
}

/**
 * Testimonials grid fed by the Convex `reviews` table — approved entries
 * only, updated live. With no approved reviews yet it falls back to a
 * "be the first" CTA so the review form stays reachable at launch.
 */
export function TestimonialsSection() {
  const [dialogOpen, setDialogOpen] = useState(false)
  const { data: reviews } = useQuery(convexQuery(api.reviews.list, { limit: 12 }))
  const { data: stats } = useQuery(convexQuery(api.reviews.stats, {}))

  const hasReviews = (reviews?.length ?? 0) > 0

  return (
    <section id="reviews" className="mx-auto w-full max-w-6xl px-4 pb-20">
      <Reveal>
        <SectionHeading
          eyebrow="Reviews"
          title="What users say"
          description={
            stats?.count
              ? `${stats.count} review${stats.count === 1 ? "" : "s"}${
                  stats.average ? ` · ${stats.average.toFixed(1)} average` : ""
                } from Free and Pro users.`
              : "From Free and Pro users."
          }
        />
      </Reveal>

      {reviews === undefined ? (
        <div className="mt-10 grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-44 rounded-4xl" />
          ))}
        </div>
      ) : hasReviews ? (
        <div className="mt-10 grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
          {reviews.map((review, index) => (
            <Reveal key={review.id} delay={Math.min(index, 5) * 60} className="h-full">
              <figure className="flex h-full flex-col gap-4 rounded-4xl border border-border bg-surface p-6">
                <div className="flex items-center justify-between">
                  <Stars rating={review.rating} />
                  {review.tier === "pro" ? (
                    <Badge variant="accent" className="text-[10px] uppercase font-semibold">
                      Pro
                    </Badge>
                  ) : null}
                </div>
                {review.text ? (
                  <blockquote className="text-sm leading-relaxed text-foreground">
                    “{review.text}”
                  </blockquote>
                ) : (
                  <blockquote className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <MessageSquareQuote className="size-4" aria-hidden />
                    Rated {review.rating}/5 — no written review.
                  </blockquote>
                )}
                <figcaption className="mt-auto pt-1 text-xs text-muted-foreground">
                  {review.name ?? "Anonymous"}
                </figcaption>
              </figure>
            </Reveal>
          ))}
        </div>
      ) : (
        <Reveal>
          <div className="mt-10 flex flex-col items-center gap-3 rounded-4xl border border-dashed border-border bg-surface/60 px-6 py-12 text-center">
            <MessageSquareQuote className="size-8 text-muted-foreground/50" aria-hidden />
            <p className="text-sm font-medium text-foreground">No reviews yet</p>
            <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
              Be the first to share how RecordForge works for you — Free or Pro, every review
              counts.
            </p>
          </div>
        </Reveal>
      )}

      <Reveal delay={200}>
        <div className="mt-8 flex justify-center">
          <Button
            variant="outline"
            className="gap-2 rounded-full"
            onClick={() => setDialogOpen(true)}
          >
            <PenLine className="size-4" aria-hidden />
            Write a review
          </Button>
        </div>
      </Reveal>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Rate RecordForge</DialogTitle>
            <DialogDescription>
              Free or Pro — your review helps others decide. Reviews are moderated before they
              appear here.
            </DialogDescription>
          </DialogHeader>
          <ReviewForm />
        </DialogContent>
      </Dialog>
    </section>
  )
}
