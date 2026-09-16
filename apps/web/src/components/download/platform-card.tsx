import type { LucideIcon } from "lucide-react"
import { Check, ExternalLink } from "lucide-react"
import { Badge, cn } from "@recordforge/ui"
import { PLATFORM_META, type DownloadPlatform, type ReleaseAsset } from "../../lib/releases"
import { DownloadButton } from "./download-button"

interface PlatformCardProps {
  platform: DownloadPlatform
  icon: LucideIcon
  /** Resolved assets for this platform; undefined when the manifest fetch failed. */
  assets: ReleaseAsset[] | undefined
  version: string | undefined
  releasesUrl: string
  detected: boolean
  downloadCount?: number
}

/**
 * Per-OS download card. With resolved assets it shows tracked download
 * buttons; without them it falls back to linking the GitHub releases page.
 */
export function PlatformCard({
  platform,
  icon: Icon,
  assets,
  version,
  releasesUrl,
  detected,
  downloadCount,
}: PlatformCardProps) {
  const meta = PLATFORM_META[platform]
  const primary = assets?.find((asset) => asset.primary)
  const alternates = assets?.filter((asset) => !asset.primary) ?? []

  return (
    <div
      className={cn(
        "relative h-full rounded-2xl border bg-surface-dim p-1.5 transition-colors duration-base ease-forge",
        detected ? "border-accent/60" : "border-border",
      )}
    >
      <div className="flex h-full flex-col gap-5 rounded-[0.625rem] bg-surface p-6">
        <div className="flex items-start justify-between gap-3">
          <span className="flex size-11 items-center justify-center rounded-xl border border-border bg-elevated text-accent">
            <Icon className="size-5" aria-hidden />
          </span>
          <div className="flex flex-col items-end gap-1.5">
            {detected ? <Badge variant="accent">Detected OS</Badge> : null}
            {downloadCount !== undefined ? (
              <span className="text-xs text-subtle-foreground tnum">
                {downloadCount.toLocaleString()} downloads
              </span>
            ) : null}
          </div>
        </div>

        <div>
          <h3 className="text-lg font-semibold tracking-tight text-foreground">{meta.name}</h3>
          <p className="mt-1 text-xs text-subtle-foreground">{meta.tagline}</p>
        </div>

        <div className="mt-auto flex flex-col gap-2">
          {assets && primary && version ? (
            <>
              <DownloadButton platform={platform} asset={primary} version={version} />
              {alternates.map((asset) => (
                <DownloadButton
                  key={asset.id}
                  platform={platform}
                  asset={asset}
                  version={version}
                  variant="outline"
                />
              ))}
            </>
          ) : (
            <a
              href={releasesUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-border-strong px-4 text-sm font-medium text-foreground transition-colors duration-fast ease-forge hover:bg-overlay"
            >
              Browse releases
              <ExternalLink className="size-4" aria-hidden />
            </a>
          )}
        </div>

        <ul className="flex flex-col gap-1.5 border-t border-border pt-4">
          {meta.notes.map((note) => (
            <li
              key={note}
              className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"
            >
              <Check className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
              {note}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
