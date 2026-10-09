import { Check, Minus } from "lucide-react"
import { FEATURE_COMPARISON } from "../../lib/pricing"
import { Reveal } from "./reveal"
import { SectionHeading } from "./section-heading"

function CellValue({ value }: { value: string | boolean }) {
  if (value === true) return <Check className="size-4 text-primary" aria-hidden />
  if (value === false) return <Minus className="size-4 text-muted-foreground/60" aria-hidden />
  return <span className="text-sm text-foreground">{value}</span>
}

/** The row-by-row Free vs Pro feature table on /pricing. */
export function FeatureComparison() {
  return (
    <section className="mx-auto w-full max-w-4xl px-4 py-16">
      <Reveal>
        <SectionHeading
          eyebrow="Compare"
          title="Everything in Free stays free"
          description="Pro adds the delivery features professionals reach for — nothing that already works is taken away."
        />
      </Reveal>
      <Reveal delay={90}>
        <div className="mt-10 overflow-hidden rounded-3xl border border-border bg-surface">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                <th scope="col" className="px-5 py-3.5 font-semibold">
                  Feature
                </th>
                <th scope="col" className="w-40 px-5 py-3.5 font-semibold">
                  Free
                </th>
                <th scope="col" className="w-44 px-5 py-3.5 font-semibold">
                  Pro
                </th>
              </tr>
            </thead>
            <tbody>
              {FEATURE_COMPARISON.map((row) => (
                <tr
                  key={row.label}
                  className="border-b border-border/60 last:border-0 hover:bg-overlay/40"
                >
                  <th scope="row" className="px-5 py-3.5 text-sm font-medium text-foreground">
                    {row.label}
                  </th>
                  <td className="px-5 py-3.5">
                    <CellValue value={row.free} />
                  </td>
                  <td className="px-5 py-3.5">
                    <CellValue value={row.pro} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Reveal>
    </section>
  )
}
