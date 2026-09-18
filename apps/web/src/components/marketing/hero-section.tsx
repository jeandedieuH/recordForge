import { Link } from "@tanstack/react-router"
import { ArrowDown, ArrowUpRight } from "lucide-react"
import { GITHUB_URL } from "../../lib/releases"
import { DemoPlaceholder } from "./demo-placeholder"
import { GitHubIcon } from "./github-icon"
import { Reveal } from "./reveal"

interface HeroSectionProps {
  /** Latest released version, when the manifest resolved. */
  version?: string
}

export function HeroSection({ version }: HeroSectionProps) {
  return (
    <section className="relative overflow-hidden px-4 pb-24 pt-36 md:pt-44">
      {/* Ambient brand glows — token colors only. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-56 left-1/2 h-136 w-6xl -translate-x-1/2 opacity-50 blur-3xl"
        style={{
          background:
            "radial-gradient(closest-side, color-mix(in srgb, var(--color-primary) 38%, transparent), transparent)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-40 top-40 h-88 w-88 opacity-30 blur-3xl"
        style={{
          background:
            "radial-gradient(closest-side, color-mix(in srgb, var(--color-accent) 42%, transparent), transparent)",
        }}
      />

      <div className="relative mx-auto flex w-full max-w-6xl flex-col items-center text-center">
        <Reveal>
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3.5 py-1.5 text-xs font-medium text-muted-foreground">
            <span className="size-1.5 rounded-full bg-recording animate-rec-pulse" aria-hidden />
            {version ? `v${version} · ` : ""}Windows · macOS · Linux · Open source
          </span>
        </Reveal>

        <Reveal delay={90}>
          <h1 className="mt-6 max-w-4xl text-balance text-4xl font-semibold leading-[1.05] tracking-tight text-foreground md:text-6xl">
            Your screen,{" "}
            <span
              className="bg-clip-text text-transparent"
              style={{
                backgroundImage:
                  "linear-gradient(105deg, var(--color-info), var(--color-primary-container) 55%, var(--color-accent))",
              }}
            >
              forged
            </span>{" "}
            into a story worth sharing.
          </h1>
        </Reveal>

        <Reveal delay={180}>
          <p className="mt-6 max-w-2xl text-balance text-base leading-relaxed text-muted-foreground md:text-lg">
            RecordForge is a local-first screen recorder and lightweight timeline editor. Buttery
            cursor motion, zero-drift audio, hardware-encoded exports — and not a single byte of
            telemetry.
          </p>
        </Reveal>

        <Reveal delay={260}>
          <div className="mt-9 flex flex-col items-center gap-3 sm:flex-row">
            {/* Button-in-button: nested icon circle inside the primary pill. */}
            <Link
              to="/download"
              className="group inline-flex items-center gap-3 rounded-full bg-primary py-2 pl-6 pr-2 text-sm font-semibold text-white shadow-e2 transition-[transform,background-color] duration-base ease-forge hover:bg-primary/90 active:scale-[0.98]"
            >
              Download for free
              <span className="flex size-8 items-center justify-center rounded-full bg-white/15 transition-transform duration-base ease-forge group-hover:translate-y-0.5">
                <ArrowDown className="size-4" aria-hidden />
              </span>
            </Link>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="group inline-flex items-center gap-2 rounded-full border border-border-strong bg-surface/60 px-6 py-2.5 text-sm font-medium text-foreground transition-[background-color,transform] duration-base ease-forge hover:bg-overlay active:scale-[0.98]"
            >
              <GitHubIcon className="size-4" />
              Star on GitHub
              <ArrowUpRight
                className="size-3.5 text-subtle-foreground transition-transform duration-base ease-forge group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                aria-hidden
              />
            </a>
          </div>
        </Reveal>

        <Reveal delay={340} className="mt-16 w-full max-w-5xl">
          {/* App-window chrome framing the hero demo slot. */}
          <div className="rounded-2xl border border-border bg-surface-dim p-1.5 shadow-e3">
            <div className="overflow-hidden rounded-[0.625rem] border border-border bg-surface">
              <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
                <div className="flex gap-1.5" aria-hidden>
                  <span className="size-2.5 rounded-full bg-recording/80" />
                  <span className="size-2.5 rounded-full bg-warning/80" />
                  <span className="size-2.5 rounded-full bg-success/80" />
                </div>
                <div className="mx-auto flex items-center gap-2 rounded-md border border-border bg-surface-dim px-3 py-1 text-xs text-subtle-foreground">
                  <span
                    className="size-1.5 rounded-full bg-recording animate-rec-pulse"
                    aria-hidden
                  />
                  RecordForge — recording 00:12:47
                </div>
                <div className="w-14" aria-hidden />
              </div>
              <DemoPlaceholder
                label="Full app walkthrough"
                aspectClass="aspect-[16/10] md:aspect-[21/10]"
                className="rounded-none border-0 bg-transparent p-0"
                src="/media/recordforge-demo.gif"
              />
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
