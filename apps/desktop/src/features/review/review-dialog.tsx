import { useState } from "react"
import { Star } from "lucide-react"
import { REVIEW_MAX_NAME_LENGTH, REVIEW_MAX_TEXT_LENGTH } from "@recordforge/contracts"
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Textarea,
  useToast,
} from "@recordforge/ui"
import { isTauri, setSetting } from "../../lib/settings"
import { submitReview } from "../../lib/review"

export interface ReviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a successful submit so the trigger can persist its state. */
  onSubmitted?: () => void
}

/**
 * Star-rating + optional written review, open to Free and Pro users alike.
 * Submissions go to the marketing site's review queue via the
 * `submit_review` command (the webview CSP can't reach the endpoint) and
 * are moderated before they appear as public testimonials.
 */
export function ReviewDialog({ open, onOpenChange, onSubmitted }: ReviewDialogProps) {
  const { toast } = useToast()
  const [rating, setRating] = useState(0)
  const [hovered, setHovered] = useState(0)
  const [text, setText] = useState("")
  const [name, setName] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)

  const canSubmit = rating >= 1 && !isSubmitting

  async function handleSubmit() {
    if (!canSubmit) return
    setIsSubmitting(true)
    try {
      await submitReview({
        rating,
        reviewText: text.trim() || undefined,
        displayName: name.trim() || undefined,
      })
      // Persisted so the card can switch to a "thanks" state (and a later
      // gentle prompt can skip people who already reviewed).
      if (isTauri()) void setSetting("reviewSubmitted", "true")
      toast({
        title: "Review submitted",
        description: "Thanks! Reviews are moderated before they appear on the site.",
      })
      onSubmitted?.()
      onOpenChange(false)
    } catch (error) {
      toast({
        title: "Could not submit your review",
        description: error instanceof Error ? error.message : "Please try again in a moment.",
        variant: "error",
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Rate RecordForge</DialogTitle>
          <DialogDescription>
            Free or Pro — a quick rating and optional note helps the project.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label className="text-xs">Your rating</Label>
            <div
              className="mt-2 flex gap-1"
              role="radiogroup"
              aria-label="Rating out of 5 stars"
              onMouseLeave={() => setHovered(0)}
            >
              {[1, 2, 3, 4, 5].map((value) => {
                const active = value <= (hovered || rating)
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={rating === value}
                    aria-label={`${value} star${value > 1 ? "s" : ""}`}
                    onClick={() => setRating(value)}
                    onMouseEnter={() => setHovered(value)}
                    className="rounded p-0.5 transition-transform duration-fast ease-forge hover:scale-110"
                  >
                    <Star
                      className={cn(
                        "size-7 transition-colors duration-fast",
                        active
                          ? "fill-amber-400 text-amber-400"
                          : "text-muted-foreground/40 hover:text-amber-300",
                      )}
                      aria-hidden
                    />
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <Label htmlFor="app-review-text" className="text-xs">
              Review <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="app-review-text"
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={REVIEW_MAX_TEXT_LENGTH}
              rows={4}
              placeholder="What do you like about RecordForge? What could be better?"
              className="mt-2 resize-none text-sm"
            />
          </div>

          <div>
            <Label htmlFor="app-review-name" className="text-xs">
              Display name <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="app-review-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={REVIEW_MAX_NAME_LENGTH}
              placeholder="Anonymous"
              className="mt-2 h-9 text-sm"
            />
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Sends your rating, optional review text and name, app version, OS, and license tier —
            nothing else. Reviews are moderated before they appear on the site.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Not now
          </Button>
          <Button variant="primary" disabled={!canSubmit} onClick={() => void handleSubmit()}>
            {isSubmitting ? "Sending…" : "Submit review"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
