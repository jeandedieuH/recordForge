import { createFileRoute, Link } from "@tanstack/react-router"
import { BadgeCheck, Download, KeyRound, Mail } from "lucide-react"
import { buttonVariants, cn } from "@recordforge/ui"
import { Reveal } from "../../components/marketing/reveal"
import { SectionHeading } from "../../components/marketing/section-heading"

/**
 * Post-purchase landing for the Polar checkout's success URL — buyers arrive
 * here right after paying and need to know where their license key went and
 * how to turn it into Pro inside the desktop app.
 */
export const Route = createFileRoute("/_marketing/thank-you")({
  head: () => ({
    meta: [
      { title: "Thank you — RecordForge Pro" },
      {
        name: "description",
        content:
          "Your RecordForge Pro license key is on its way. Paste it in Settings → License to unlock 4K exports, chapters, and every Pro feature — then it works fully offline.",
      },
      { property: "og:title", content: "Thank you — RecordForge Pro" },
      {
        property: "og:description",
        content:
          "Your license key is on its way. Activate it once in Settings → License and Pro works fully offline.",
      },
      { property: "og:type", content: "website" },
      // Buyer-only page reached from checkout; keep it out of search results.
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ThankYouPage,
})

const STEPS = [
  {
    icon: Mail,
    title: "Check your email",
    body: "Polar just sent your license key to the address you used at checkout — it's also shown on the order confirmation screen and in your customer portal.",
  },
  {
    icon: KeyRound,
    title: "Paste it in RecordForge",
    body: "Open RecordForge → Settings → License, paste the key, and hit Activate. One quick online check, once per device.",
  },
  {
    icon: BadgeCheck,
    title: "Pro stays offline",
    body: "After that single activation, Pro works fully offline on up to 3 of your devices — matching the local-first promise.",
  },
]

function ThankYouPage() {
  return (
    <section className="mx-auto w-full max-w-6xl px-4 pb-28 pt-32">
      <Reveal>
        <SectionHeading
          eyebrow="Purchase complete"
          title="Welcome to Pro."
          description="Your payment went through — the only thing left is pasting your license key into the app. Thirty seconds and you're set."
        />
      </Reveal>

      {/* The three-step activation path buyers need after checkout. */}
      <div className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-3">
        {STEPS.map((step, index) => (
          <Reveal key={step.title} delay={index * 90} className="h-full">
            <div className="flex h-full flex-col gap-4 rounded-4xl border border-border bg-surface p-7">
              <span className="flex size-11 items-center justify-center rounded-2xl border border-border bg-surface-dim text-primary">
                <step.icon className="size-5" aria-hidden />
              </span>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Step {index + 1}
                </p>
                <h2 className="mt-1 text-base font-semibold text-foreground">{step.title}</h2>
              </div>
              <p className="text-sm leading-relaxed text-muted-foreground">{step.body}</p>
            </div>
          </Reveal>
        ))}
      </div>

      {/* Buyers may land here on a machine without the app installed. */}
      <Reveal delay={300}>
        <div className="mt-10 flex flex-col items-center gap-4">
          <Link to="/download" className={cn(buttonVariants(), "gap-2 rounded-full")}>
            <Download className="size-4" aria-hidden />
            Download RecordForge
          </Link>
          <p className="max-w-md text-center text-xs leading-relaxed text-muted-foreground">
            Can't find your key? It never expires — reply to your Polar receipt email or grab it
            again anytime from the Polar customer portal linked in that email.
          </p>
        </div>
      </Reveal>
    </section>
  )
}
