import { useState } from "react"
import { Star } from "lucide-react"
import { REVIEW_MAX_NAME_LENGTH, REVIEW_MAX_TEXT_LENGTH } from "@recordforge/contracts"
import { Button, cn, Input, Label, Textarea } from "@recordforge/ui"

export interface ReviewFormProps {
  /** Called after a successful submit — the parent can close the dialog. */
  onSubmitted?: () => void
}

type SubmitState = "idle" | "submitting" | "success" | "error"

/**
 * Star rating + optional written review. Posts to `/api/reviews`, which
 * stores it in Convex under `approved: false` until it is curated — the
 * form makes that moderation step clear instead of promising instant
 * publication. The `website` field is a honeypot: invisible to humans,
 * filled by bots, and dropped server-side.
 */
export function ReviewForm({ onSubmitted }: ReviewFormProps) {
  const [rating, setRating] = useState(0)
  const [hovered, setHovered] = useState(0)
  const [text, setText] = useState("")
  const [name, setName] = useState("")
  const [honeypot, setHoneypot] = useState("")
  const [state, setState] = useState<SubmitState>("idle")

  const canSubmit = rating >= 1 && state !== "submitting"

  async function handleSubmit() {
    if (!canSubmit) return
    setState("submitting")
    try {
      const response = await fetch("/api/reviews", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rating,
          text: text.trim() || undefined,
          name: name.trim() || undefined,
          source: "web",
          website: honeypot,
        }),
      })
      if (!response.ok) throw new Error(`submit failed (${response.status})`)
      setState("success")
      onSubmitted?.()
    } catch {
      setState("error")
    }
  }

  if (state === "success") {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <div className="flex gap-1" aria-hidden>
          {[1, 2, 3, 4, 5].map((value) => (
            <Star
              key={value}
              className={cn(
                "size-5",
                value <= rating ? "fill-amber-400 text-amber-400" : "text-muted-foreground/40",
              )}
            />
          ))}
        </div>
        <p className="text-sm font-semibold text-foreground">Thanks for the review!</p>
        <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
          Reviews are curated before they appear on the site — yours is in the queue.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
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
        <Label htmlFor="review-text" className="text-xs">
          Review <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id="review-text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          maxLength={REVIEW_MAX_TEXT_LENGTH}
          rows={4}
          placeholder="What do you like about RecordForge? What could be better?"
          className="mt-2 resize-none text-sm"
        />
        <p className="mt-1 text-right text-[11px] text-muted-foreground">
          {text.length}/{REVIEW_MAX_TEXT_LENGTH}
        </p>
      </div>

      <div>
        <Label htmlFor="review-name" className="text-xs">
          Display name <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id="review-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={REVIEW_MAX_NAME_LENGTH}
          placeholder="Anonymous"
          className="mt-2 h-9 text-sm"
        />
      </div>

      {/* Honeypot — real users never see or fill this. */}
      <input
        type="text"
        name="website"
        value={honeypot}
        onChange={(event) => setHoneypot(event.target.value)}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="pointer-events-none absolute -left-[9999px] h-0 w-0 opacity-0"
      />

      {state === "error" ? (
        <p className="text-xs text-warning" role="alert">
          Something went wrong submitting your review — please try again.
        </p>
      ) : null}

      <Button variant="primary" disabled={!canSubmit} onClick={() => void handleSubmit()}>
        {state === "submitting" ? "Sending…" : "Submit review"}
      </Button>
    </div>
  )
}
