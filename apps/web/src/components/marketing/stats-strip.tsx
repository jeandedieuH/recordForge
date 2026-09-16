import { Reveal } from "./reveal"

const STATS = [
  { value: "<50 MB", label: "idle memory footprint — native Rust + Tauri, no Chromium bloat" },
  { value: "120 Hz", label: "cursor telemetry sampling — per-frame vectors, not guesswork" },
  { value: "µs", label: "audio sync precision — native capture pipeline, zero drift" },
  { value: "0", label: "accounts, telemetry, cloud lock-in — 100% local-first" },
]

/** Key selling-point numbers directly under the hero. */
export function StatsStrip() {
  return (
    <section className="mx-auto w-full max-w-6xl px-4 pb-20">
      <Reveal>
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-5">
          {STATS.map((stat) => (
            <div key={stat.label} className="rounded-2xl border border-border bg-surface-dim p-1.5">
              <div className="flex h-full flex-col gap-2 rounded-[0.625rem] bg-surface px-5 py-4">
                <dt className="order-2 text-xs leading-relaxed text-muted-foreground">
                  {stat.label}
                </dt>
                <dd className="order-1 text-2xl font-semibold tracking-tight text-foreground tnum">
                  {stat.value}
                </dd>
              </div>
            </div>
          ))}
        </dl>
      </Reveal>
    </section>
  )
}
