import { cn } from "@recordforge/ui"

interface SectionHeadingProps {
  eyebrow: string
  title: string
  description?: string
  align?: "center" | "left"
  className?: string
}

/** Eyebrow pill + headline + optional subcopy used to open each landing section. */
export function SectionHeading({
  eyebrow,
  title,
  description,
  align = "center",
  className,
}: SectionHeadingProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4",
        align === "center" ? "items-center text-center" : "items-start text-left",
        className,
      )}
    >
      <span className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-[0.65rem] font-medium uppercase tracking-[0.2em] text-muted-foreground">
        {eyebrow}
      </span>
      <h2 className="max-w-3xl text-balance text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
        {title}
      </h2>
      {description ? (
        <p className="max-w-2xl text-balance text-base leading-relaxed text-muted-foreground">
          {description}
        </p>
      ) : null}
    </div>
  )
}
