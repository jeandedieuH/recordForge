import { Link } from "@tanstack/react-router"
import { ArrowLeft, Download } from "lucide-react"

/**
 * App-wide 404 — wired as `notFoundComponent` on the root route so both
 * unmatched URLs and `notFound()` thrown in any child route land here.
 * Renders outside the `_marketing` layout, so it carries its own branding.
 */
export function NotFound() {
  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-4 py-24 text-center">
      {/* Ambient brand glow — token colors only. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-56 left-1/2 h-136 w-6xl -translate-x-1/2 opacity-50 blur-3xl"
        style={{
          background:
            "radial-gradient(closest-side, color-mix(in srgb, var(--color-primary) 38%, transparent), transparent)",
        }}
      />

      <div className="relative flex flex-col items-center">
        <Link to="/" className="flex items-center gap-2.5" aria-label="RecordForge home">
          <img src="/icon.svg" alt="" className="size-7 rounded-md" />
          <span className="text-sm font-semibold tracking-tight text-foreground">RecordForge</span>
        </Link>

        <span className="mt-10 inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3.5 py-1.5 text-xs font-medium text-muted-foreground">
          <span className="size-1.5 rounded-full bg-recording animate-rec-pulse" aria-hidden />
          404 · take not found
        </span>

        <h1 className="mt-6 max-w-2xl text-balance text-4xl font-semibold leading-[1.05] tracking-tight text-foreground md:text-6xl">
          This scene didn't make the final cut.
        </h1>
        <p className="mt-6 max-w-md text-balance text-base leading-relaxed text-muted-foreground">
          The page you're looking for was trimmed, split, or never recorded — let's get you back to
          the timeline.
        </p>

        <div className="mt-9 flex flex-col items-center gap-3 sm:flex-row">
          {/* Same button-in-button pill pattern as the hero CTA. */}
          <Link
            to="/"
            className="group inline-flex items-center gap-3 rounded-full bg-primary py-2 pl-6 pr-2 text-sm font-semibold text-white shadow-e2 transition-[transform,background-color] duration-base ease-forge hover:bg-primary/90 active:scale-[0.98]"
          >
            Back to home
            <span className="flex size-8 items-center justify-center rounded-full bg-white/15 transition-transform duration-base ease-forge group-hover:-translate-x-0.5">
              <ArrowLeft className="size-4" aria-hidden />
            </span>
          </Link>
          <Link
            to="/download"
            className="group inline-flex items-center gap-2 rounded-full border border-border-strong bg-surface/60 px-6 py-2.5 text-sm font-medium text-foreground transition-[background-color,transform] duration-base ease-forge hover:bg-overlay active:scale-[0.98]"
          >
            <Download className="size-4" aria-hidden />
            Download RecordForge
          </Link>
        </div>
      </div>
    </main>
  )
}
