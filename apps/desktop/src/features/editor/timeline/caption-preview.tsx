import type { CaptionClip } from "@recordforge/contracts"

interface CaptionPreviewProps {
  clips: CaptionClip[]
  playheadMs: number
  canvasHeight: number
}

function isActive(clip: CaptionClip, playheadMs: number): boolean {
  return playheadMs >= clip.startMs && playheadMs < clip.startMs + clip.durationMs
}

function captionClass(style: CaptionClip["style"]): string {
  if (style === "minimal") return "text-foreground shadow-e2"
  if (style === "boxed") return "rounded-md bg-overlay px-4 py-2 text-foreground shadow-e2"
  if (style === "highlight")
    return "rounded-md bg-warning/90 px-4 py-2 text-warning-foreground shadow-e2"
  return "rounded-md bg-overlay px-4 py-2 text-foreground shadow-e2"
}

export function CaptionPreview({ clips, playheadMs, canvasHeight }: CaptionPreviewProps) {
  return (
    <div className="pointer-events-none absolute inset-0 z-40" aria-live="off" aria-hidden>
      {clips.map((clip) => {
        const active = isActive(clip, playheadMs)
        const margin = Math.max(0, clip.safeAreaMargin ?? 48)
        const positionStyle =
          clip.placement === "top"
            ? { top: `${(margin / canvasHeight) * 100}%` }
            : clip.placement === "center"
              ? { top: "50%", transform: "translate(-50%, -50%)" }
              : { bottom: `${(margin / canvasHeight) * 100}%` }
        return (
          <div
            key={clip.id}
            className="absolute left-1/2 max-w-[88%] text-center text-xs font-semibold leading-tight transition-opacity sm:text-sm md:text-base lg:text-lg"
            style={{
              ...positionStyle,
              ...(clip.placement === "center" ? {} : { transform: "translateX(-50%)" }),
              maxWidth: "88%",
              opacity: active ? 1 : 0,
            }}
          >
            <span className={captionClass(clip.style)}>{clip.text}</span>
          </div>
        )
      })}
    </div>
  )
}
