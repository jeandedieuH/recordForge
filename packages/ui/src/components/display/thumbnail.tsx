import { Film } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { cn } from "../../lib/cn"

interface ThumbnailProps {
  /** Poster-frame URL; falls back to an icon when missing. */
  src?: string | null
  alt: string
  /** Seconds; rendered as a bottom-right duration badge. */
  durationSec?: number
  fallbackIcon?: LucideIcon
  className?: string
}

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = String(m).padStart(2, "0")
  const ss = String(sec).padStart(2, "0")
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** 16:9 media thumbnail with duration badge + icon fallback (library, export done-state). */
function Thumbnail({
  src,
  alt,
  durationSec,
  fallbackIcon: Fallback = Film,
  className,
}: ThumbnailProps) {
  return (
    <div
      className={cn(
        "relative aspect-video w-full overflow-hidden rounded-md bg-overlay",
        className,
      )}
    >
      {src ? (
        <img
          src={src}
          alt={alt}
          className="size-full object-cover"
          loading="lazy"
          draggable={false}
        />
      ) : (
        <div className="flex size-full items-center justify-center">
          <Fallback className="size-8 text-subtle-foreground" aria-hidden />
        </div>
      )}
      {durationSec !== undefined ? (
        <span className="tnum absolute right-1.5 bottom-1.5 rounded-sm bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white">
          {formatDuration(durationSec)}
        </span>
      ) : null}
    </div>
  )
}

export { Thumbnail }
export type { ThumbnailProps }
