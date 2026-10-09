import { PRO_FAQ } from "../../lib/pricing"
import { Reveal } from "./reveal"
import { SectionHeading } from "./section-heading"

/** The honest-questions block at the bottom of /pricing. */
export function PricingFaq() {
  return (
    <section className="mx-auto w-full max-w-4xl px-4 pb-24 pt-8">
      <Reveal>
        <SectionHeading
          eyebrow="FAQ"
          title="Fair questions, straight answers"
          description="The terms we wrote into the license docs, in plain language."
        />
      </Reveal>
      <div className="mt-10 flex flex-col gap-4">
        {PRO_FAQ.map((item, index) => (
          <Reveal key={item.question} delay={index * 60}>
            <details className="group rounded-2xl border border-border bg-surface px-6 py-5 open:border-primary/30">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-semibold text-foreground [&::-webkit-details-marker]:hidden">
                {item.question}
                <span className="shrink-0 text-muted-foreground transition-transform duration-base ease-forge group-open:rotate-45">
                  +
                </span>
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{item.answer}</p>
            </details>
          </Reveal>
        ))}
      </div>
    </section>
  )
}
