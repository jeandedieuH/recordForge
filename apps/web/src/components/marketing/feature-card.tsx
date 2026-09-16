import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"
import { Badge, cn } from "@recordforge/ui"
import { DemoPlaceholder } from "./demo-placeholder"

/** Accent tones mapped onto the timeline track palette tokens. */
export type FeatureTone =
  "screen" | "webcam" | "mic" | "system" | "captions" | "annotation" | "title" | "graphic"

const TONE_CLASS: Record<FeatureTone, string> = {
  screen: "border-track-screen/30 bg-track-screen/10 text-track-screen",
  webcam: "border-track-webcam/30 bg-track-webcam/10 text-track-webcam",
  mic: "border-track-mic/30 bg-track-mic/10 text-track-mic",
  system: "border-track-system/30 bg-track-system/10 text-track-system",
  captions: "border-track-captions/30 bg-track-captions/10 text-track-captions",
  annotation: "border-track-annotation/30 bg-track-annotation/10 text-track-annotation",
  title: "border-track-title/30 bg-track-title/10 text-track-title",
  graphic: "border-track-graphic/30 bg-track-graphic/10 text-track-graphic",
}

interface FeatureCardProps {
  icon: LucideIcon
  title: string
  description: string
  tone: FeatureTone
  /** Headline stat rendered large above the title (e.g. "<50 MB"). */
  stat?: string
  /** Small label chips rendered under the description (encoders, providers…). */
  chips?: string[]
  /** When set, the card carries a demo-GIF slot with this label. */
  demoLabel?: string
  /** Custom static visual for features that don't need a GIF slot. */
  visual?: ReactNode
  /** "split" puts copy and media side-by-side on md+ (for full-width cards). */
  layout?: "stacked" | "split"
  className?: string
}

/**
 * Double-bezel feature card: an outer tray shell plus an inner surface,
 * so cards read as machined plates instead of flat boxes.
 */
export function FeatureCard({
  icon: Icon,
  title,
  description,
  tone,
  stat,
  chips,
  demoLabel,
  visual,
  layout = "stacked",
  className,
}: FeatureCardProps) {
  const media = demoLabel ? <DemoPlaceholder label={demoLabel} /> : visual

  const copy = (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span
          className={cn(
            "flex size-10 items-center justify-center rounded-xl border",
            TONE_CLASS[tone],
          )}
        >
          <Icon className="size-5" aria-hidden />
        </span>
        {stat ? (
          <span className="text-2xl font-semibold tracking-tight text-foreground tnum">{stat}</span>
        ) : null}
      </div>
      <h3 className="text-lg font-semibold tracking-tight text-foreground">{title}</h3>
      <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
      {chips?.length ? (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((chip) => (
            <Badge key={chip} variant="outline" className="font-normal">
              {chip}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  )

  return (
    <div className={cn("rounded-2xl border border-border bg-surface-dim p-1.5", className)}>
      <div
        className={cn(
          "h-full rounded-[0.625rem] bg-surface p-6",
          layout === "split" && media
            ? "grid items-center gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
            : "flex flex-col gap-5",
        )}
      >
        {copy}
        {media}
      </div>
    </div>
  )
}
