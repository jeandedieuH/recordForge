import { useEffect, useState } from "react"
import { Heart, Star } from "lucide-react"
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@recordforge/ui"
import { getSetting, isTauri } from "../../lib/settings"
import { ReviewDialog } from "./review-dialog"

/**
 * About → "Rate RecordForge" card — the in-app entry point for the review
 * feature, identical for Free and Pro users. Flips to a thank-you state
 * once `reviewSubmitted` is persisted in settings.
 */
export function RateCard() {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  useEffect(() => {
    if (!isTauri()) return
    void getSetting("reviewSubmitted").then((value) => {
      if (value === "true") setSubmitted(true)
    })
  }, [])

  return (
    <Card className="rounded-2xl border border-border bg-surface shadow-e1 flex flex-col justify-between">
      <div>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Star className="size-5 text-amber-400" />
            <CardTitle className="text-base font-semibold text-foreground">
              Enjoying RecordForge?
            </CardTitle>
          </div>
          <CardDescription className="text-xs text-subtle-foreground">
            Free or Pro — a star rating and a few words help the project grow.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-3 text-xs">
          <p className="text-subtle-foreground leading-relaxed">
            Reviews are shared on the RecordForge website after moderation. Only your rating,
            optional text and name, app version, OS, and license tier are sent — never recordings or
            device identifiers.
          </p>
        </CardContent>
      </div>

      <div className="p-6 pt-0">
        {submitted ? (
          <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-surface-dim px-3 py-2.5 text-xs text-subtle-foreground">
            <Heart className="size-3.5 text-rose-400" aria-hidden />
            Thanks for your review!
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="w-full text-xs h-9 cursor-pointer gap-2"
            onClick={() => setDialogOpen(true)}
          >
            <Star className="size-3.5 text-amber-400" />
            <span>Leave a review</span>
          </Button>
        )}
      </div>

      <ReviewDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmitted={() => setSubmitted(true)}
      />
    </Card>
  )
}
