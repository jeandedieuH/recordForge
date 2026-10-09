import { Check, Minus } from "lucide-react"
import { buttonVariants, cn } from "@recordforge/ui"
import { CHECKOUT_URL, PRO_DEVICES, PRO_FOUNDER_PRICE, PRO_PRICE } from "../../lib/pricing"
import { Reveal } from "./reveal"

const FREE_POINTS = [
  "Unlimited recording — 4K60 capture",
  "Full timeline editor & captions",
  "16:9 exports up to 1080p",
  "Clean Text title preset",
  "MP4 / GIF / WebP hardware export",
  "GPL-3.0 open source, forever",
]

const PRO_POINTS = [
  "1440p & 4K exports — Ultra 4K presets",
  "Vertical, square & custom aspect ratios",
  "Chapters & YouTube timestamps",
  "Every title preset beyond Clean Text",
  "Annotations — shapes, arrows, callouts",
  `Lifetime updates · ${PRO_DEVICES}`,
  "Coming free: instant web delivery",
]

/** The two plan cards at the top of /pricing. */
export function PricingCards() {
  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
      <Reveal className="h-full">
        <div className="flex h-full flex-col rounded-4xl border border-border bg-surface p-8">
          <h2 className="text-lg font-semibold text-foreground">Free</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The full recorder and editor — no catch.
          </p>
          <div className="mt-6 flex items-baseline gap-2">
            <span className="text-4xl font-semibold tracking-tight text-foreground">$0</span>
            <span className="text-sm text-muted-foreground">forever</span>
          </div>
          <ul className="mt-8 flex flex-col gap-3 text-sm">
            {FREE_POINTS.map((point) => (
              <li key={point} className="flex items-start gap-2.5 text-foreground">
                <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                <span>{point}</span>
              </li>
            ))}
          </ul>
          <div className="mt-auto pt-8">
            <a
              href="/download"
              className={cn(
                buttonVariants({ variant: "outline" }),
                "w-full justify-center rounded-full",
              )}
            >
              Download for free
            </a>
          </div>
        </div>
      </Reveal>

      <Reveal delay={90} className="h-full">
        <div className="relative flex h-full flex-col rounded-4xl border border-primary/40 bg-surface p-8 shadow-e2">
          <span className="absolute -top-3 left-8 rounded-full bg-primary px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-white">
            One-time purchase
          </span>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-foreground">Pro</h2>
            <span className="rounded-full border border-warning/60 bg-warning/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-warning">
              Lifetime
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Everything in Free, plus the pro delivery features.
          </p>
          <div className="mt-6 flex items-baseline gap-2">
            <span className="text-4xl font-semibold tracking-tight text-foreground">
              {PRO_FOUNDER_PRICE}
            </span>
            <span className="text-lg text-muted-foreground line-through">{PRO_PRICE}</span>
            <span className="text-sm text-muted-foreground">once · {PRO_DEVICES}</span>
          </div>
          <p className="mt-1.5 text-[11px] font-medium text-warning">
            Founder launch price — first 30 days, then {PRO_PRICE}
          </p>
          <ul className="mt-8 flex flex-col gap-3 text-sm">
            {PRO_POINTS.map((point) => (
              <li key={point} className="flex items-start gap-2.5 text-foreground">
                {point.startsWith("Coming") ? (
                  <Minus className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                ) : (
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                )}
                <span className={point.startsWith("Coming") ? "text-muted-foreground" : ""}>
                  {point}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-auto pt-8">
            <a
              href={CHECKOUT_URL}
              target="_blank"
              rel="noreferrer"
              className={cn(buttonVariants(), "w-full justify-center rounded-full")}
            >
              Get RecordForge Pro — {PRO_FOUNDER_PRICE}
            </a>
            <p className="mt-3 text-center text-[11px] leading-relaxed text-muted-foreground">
              14-day money-back guarantee · activation is a one-time online check, then Pro works
              fully offline.
            </p>
          </div>
        </div>
      </Reveal>
    </div>
  )
}
