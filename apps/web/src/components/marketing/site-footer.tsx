import { Link } from "@tanstack/react-router"
import { GITHUB_URL, RELEASES_URL } from "../../lib/releases"
import { GitHubIcon } from "./github-icon"

const FOOTER_COLUMNS = [
  {
    heading: "Product",
    links: [
      { label: "Download", href: "/download", internal: true },
      { label: "Features", href: "/#features", internal: false },
      { label: "Release notes", href: RELEASES_URL, internal: false },
    ],
  },
  {
    heading: "Resources",
    links: [
      { label: "GitHub", href: GITHUB_URL, internal: false },
      { label: "Report an issue", href: `${GITHUB_URL}/issues`, internal: false },
      { label: "Contribute", href: `${GITHUB_URL}/blob/main/CONTRIBUTING.md`, internal: false },
    ],
  },
  {
    heading: "Legal",
    links: [
      { label: "GPL-3.0 license", href: `${GITHUB_URL}/blob/main/LICENSE`, internal: false },
      { label: "Security", href: `${GITHUB_URL}/blob/main/SECURITY.md`, internal: false },
    ],
  },
]

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-surface-dim/60">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-6 py-14 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div>
          <div className="flex items-center gap-2.5">
            <img src="/icon.svg" alt="" className="size-7 rounded-md" />
            <span className="text-base font-semibold tracking-tight text-foreground">
              RecordForge
            </span>
          </div>
          <p className="mt-3 max-w-xs text-sm leading-relaxed text-muted-foreground">
            A local-first screen recorder and lightweight editor for Windows, macOS, and Linux. Your
            footage never leaves your machine unless you say so.
          </p>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-4 inline-flex items-center gap-2 text-sm text-subtle-foreground transition-colors duration-fast ease-forge hover:text-foreground"
          >
            <GitHubIcon className="size-4" />
            Open source · GPL-3.0
          </a>
        </div>

        {FOOTER_COLUMNS.map((column) => (
          <nav key={column.heading} aria-label={column.heading}>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-subtle-foreground">
              {column.heading}
            </h3>
            <ul className="mt-4 space-y-2.5">
              {column.links.map((link) => (
                <li key={link.label}>
                  {link.internal ? (
                    <Link
                      to={link.href}
                      className="text-sm text-muted-foreground transition-colors duration-fast ease-forge hover:text-foreground"
                    >
                      {link.label}
                    </Link>
                  ) : (
                    <a
                      href={link.href}
                      className="text-sm text-muted-foreground transition-colors duration-fast ease-forge hover:text-foreground"
                    >
                      {link.label}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      <div className="border-t border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-start justify-between gap-2 px-6 py-5 text-xs text-subtle-foreground sm:flex-row sm:items-center">
          <span>© {new Date().getFullYear()} Prestige Tech &amp; RecordForge contributors</span>
          <span>Built with Tauri, Rust &amp; React — no telemetry, ever.</span>
        </div>
      </div>
    </footer>
  )
}
