import { Link, useLocation } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { buttonVariants, cn } from "@recordforge/ui"
import { GITHUB_URL } from "../../lib/releases"
import { GitHubIcon } from "./github-icon"

const NAV_LINKS = [
  { label: "Features", to: "/", hash: "features" },
  { label: "Why local-first", to: "/", hash: "local-first" },
] as const

/**
 * Floating glass pill nav shared by all marketing pages. On mobile the
 * hamburger morphs into an X and opens a full-screen overlay menu.
 */
export function SiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()

  // Close the mobile menu whenever the route changes.
  useEffect(() => {
    setMenuOpen(false)
  }, [location.pathname, location.hash])

  return (
    <header className="fixed inset-x-0 top-0 z-40 px-4 pt-4">
      <nav
        aria-label="Main"
        className="mx-auto flex w-full max-w-3xl items-center justify-between gap-2 rounded-full border border-border bg-surface/80 py-2 pl-4 pr-2 shadow-e2 backdrop-blur-xl"
      >
        <Link to="/" className="flex items-center gap-2.5" aria-label="RecordForge home">
          <img src="/icon.svg" alt="" className="size-6 rounded-md" />
          <span className="text-sm font-semibold tracking-tight text-foreground">RecordForge</span>
        </Link>

        <div className="hidden items-center gap-1 md:flex">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.label}
              to={link.to}
              hash={link.hash}
              className="rounded-full px-3 py-1.5 text-sm text-muted-foreground transition-colors duration-fast ease-forge hover:bg-overlay hover:text-foreground"
            >
              {link.label}
            </Link>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="RecordForge on GitHub"
            className="hidden size-8 items-center justify-center rounded-full text-muted-foreground transition-colors duration-fast ease-forge hover:bg-overlay hover:text-foreground sm:flex"
          >
            <GitHubIcon className="size-4" />
          </a>
          <Link to="/download" className={cn(buttonVariants({ size: "sm" }), "rounded-full px-4")}>
            Download
          </Link>
          <button
            type="button"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
            className="relative flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors duration-fast ease-forge hover:bg-overlay hover:text-foreground md:hidden"
          >
            {/* Two bars that morph into an X while open. */}
            <span
              aria-hidden
              className={cn(
                "absolute h-px w-4 bg-current transition-transform duration-base ease-forge",
                menuOpen ? "rotate-45" : "-translate-y-0.75",
              )}
            />
            <span
              aria-hidden
              className={cn(
                "absolute h-px w-4 bg-current transition-transform duration-base ease-forge",
                menuOpen ? "-rotate-45" : "translate-y-0.75",
              )}
            />
          </button>
        </div>
      </nav>

      {/* Mobile overlay menu — links stagger in below the pill. */}
      <div
        className={cn(
          "fixed inset-0 -z-10 flex flex-col justify-center bg-background/90 px-8 backdrop-blur-2xl transition-[opacity,visibility] duration-base ease-forge md:hidden",
          menuOpen ? "visible opacity-100" : "invisible opacity-0",
        )}
      >
        <nav aria-label="Mobile" className="flex flex-col gap-2">
          {[...NAV_LINKS, { label: "Download", to: "/download", hash: "" }].map((link, index) => (
            <Link
              key={link.label}
              to={link.to}
              hash={link.hash}
              className={cn(
                "rounded-lg px-4 py-3 text-2xl font-semibold text-foreground transition-[opacity,transform,background-color] duration-base ease-forge hover:bg-overlay",
                menuOpen ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0",
              )}
              style={{ transitionDelay: `${100 + index * 60}ms` }}
            >
              {link.label}
            </Link>
          ))}
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className={cn(
              "mt-2 inline-flex items-center gap-2 rounded-lg px-4 py-3 text-sm text-muted-foreground transition-[opacity,transform] duration-base ease-forge",
              menuOpen ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0",
            )}
            style={{ transitionDelay: `${100 + NAV_LINKS.length * 60 + 60}ms` }}
          >
            <GitHubIcon className="size-4" />
            GitHub
          </a>
        </nav>
      </div>
    </header>
  )
}
