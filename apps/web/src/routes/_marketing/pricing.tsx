import { createFileRoute } from "@tanstack/react-router"
import { FeatureComparison } from "../../components/marketing/feature-comparison"
import { PricingCards } from "../../components/marketing/pricing-cards"
import { PricingFaq } from "../../components/marketing/pricing-faq"
import { Reveal } from "../../components/marketing/reveal"
import { SectionHeading } from "../../components/marketing/section-heading"
import { CtaSection } from "../../components/marketing/cta-section"

export const Route = createFileRoute("/_marketing/pricing")({
  head: () => ({
    meta: [
      { title: "RecordForge Pricing — Free & Pro" },
      {
        name: "description",
        content:
          "RecordForge is free and open source forever. Pro is a one-time $29 lifetime purchase — 4K exports, custom aspect ratios, chapters, every title preset, and annotations. No subscription, no account.",
      },
      { property: "og:title", content: "RecordForge Pricing — Free & Pro" },
      {
        property: "og:description",
        content:
          "A generous Free tier and an affordable lifetime Pro license. Local-first, no subscription, no watermark.",
      },
      { property: "og:type", content: "website" },
    ],
  }),
  component: PricingPage,
})

function PricingPage() {
  return (
    <>
      <section className="mx-auto w-full max-w-6xl px-4 pb-6 pt-32">
        <Reveal>
          <SectionHeading
            eyebrow="Pricing"
            title="Free forever. Pro once."
            description="The recorder and editor you already love is free and open source. Pro is a one-time purchase that unlocks the professional delivery features — and funds what comes next."
          />
        </Reveal>
        <div className="mt-12">
          <PricingCards />
        </div>
      </section>

      <FeatureComparison />
      <PricingFaq />
      <CtaSection />
    </>
  )
}
