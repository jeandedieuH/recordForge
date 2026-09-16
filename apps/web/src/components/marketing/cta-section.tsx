import { Link } from "@tanstack/react-router"
import { AppWindow, ArrowDown, Command, Terminal } from "lucide-react"
import { Reveal } from "./reveal"

/** Closing call-to-action band above the footer. */
export function CtaSection() {
  return (
    <section className="mx-auto w-full max-w-6xl px-4 pb-28 pt-8">
      <Reveal>
        <div className="relative overflow-hidden rounded-4xl border border-border bg-surface-dim p-1.5">
          <div
            aria-hidden
            className="pointer-events-none absolute -top-40 left-1/2 h-104 w-208 -translate-x-1/2 opacity-40 blur-3xl"
            style={{
              background:
                "radial-gradient(closest-side, color-mix(in srgb, var(--color-primary) 50%, transparent), transparent)",
            }}
          />
          <div className="relative flex flex-col items-center gap-6 rounded-[1.625rem] bg-surface px-6 py-16 text-center md:py-20">
            <h2 className="max-w-2xl text-balance text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
              Ready to forge your next recording?
            </h2>
            <p className="max-w-xl text-balance text-base leading-relaxed text-muted-foreground">
              Free and open source, forever. No account, no watermark, no telemetry — just a
              recorder that respects your machine.
            </p>
            <Link
              to="/download"
              className="group inline-flex items-center gap-3 rounded-full bg-primary py-2 pl-6 pr-2 text-sm font-semibold text-white shadow-e2 transition-[transform,background-color] duration-base ease-forge hover:bg-primary/90 active:scale-[0.98]"
            >
              Download RecordForge
              <span className="flex size-8 items-center justify-center rounded-full bg-white/15 transition-transform duration-base ease-forge group-hover:translate-y-0.5">
                <ArrowDown className="size-4" aria-hidden />
              </span>
            </Link>
            <div className="flex items-center gap-4 text-subtle-foreground">
              <span className="flex items-center gap-1.5 text-xs">
                <AppWindow className="size-4" aria-hidden /> Windows
              </span>
              <span className="flex items-center gap-1.5 text-xs">
                <Command className="size-4" aria-hidden /> macOS
              </span>
              <span className="flex items-center gap-1.5 text-xs">
                <Terminal className="size-4" aria-hidden /> Linux
              </span>
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  )
}
