import type { ReleaseInfo } from "../../lib/releases"
import { Reveal } from "../marketing/reveal"
import { DownloadCounter } from "./download-counter"

interface DownloadHeroProps {
  release: ReleaseInfo | null
}

/** Page intro: headline, current version badge, and the live download counter. */
export function DownloadHero({ release }: DownloadHeroProps) {
  const publishedAt = release?.pubDate ? new Date(release.pubDate) : null

  return (
    <section className="relative overflow-hidden px-4 pb-14 pt-36 md:pt-44">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-56 left-1/2 h-120 w-5xl -translate-x-1/2 opacity-45 blur-3xl"
        style={{
          background:
            "radial-gradient(closest-side, color-mix(in srgb, var(--color-primary) 40%, transparent), transparent)",
        }}
      />
      <div className="relative mx-auto flex w-full max-w-3xl flex-col items-center gap-6 text-center">
        <Reveal>
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3.5 py-1.5 text-xs font-medium text-muted-foreground">
            <span className="size-1.5 rounded-full bg-success" aria-hidden />
            {release
              ? `Latest release · v${release.version}${
                  publishedAt
                    ? ` · ${publishedAt.toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}`
                    : ""
                }`
              : "Latest release"}
          </span>
        </Reveal>
        <Reveal delay={90}>
          <h1 className="text-balance text-4xl font-semibold tracking-tight text-foreground md:text-5xl">
            Download RecordForge
          </h1>
        </Reveal>
        <Reveal delay={160}>
          <p className="max-w-xl text-balance text-base leading-relaxed text-muted-foreground">
            Free and open source. Pick your platform — every build is signed and published straight
            from our release pipeline.
          </p>
        </Reveal>
        <Reveal delay={230}>
          <DownloadCounter />
        </Reveal>
      </div>
    </section>
  )
}
