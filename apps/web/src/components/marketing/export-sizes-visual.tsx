const RATIOS = [
  { label: "16:9", frameClass: "aspect-video w-28 md:w-32" },
  { label: "9:16", frameClass: "aspect-[9/16] h-28 md:h-32" },
  { label: "1:1", frameClass: "aspect-square h-20 md:h-24" },
  { label: "4:5", frameClass: "aspect-[4/5] h-24 md:h-28" },
]

/**
 * Static stand-in for the export-formats card — one source frame reframed
 * into the four export aspect ratios. Cheaper (and clearer) than a GIF.
 */
export function ExportSizesVisual() {
  return (
    <div className="rounded-2xl border border-border bg-surface-dim p-1.5">
      <div className="flex items-end justify-center gap-4 rounded-[0.625rem] border border-dashed border-border-strong/70 bg-surface px-6 py-6">
        {RATIOS.map((ratio) => (
          <div key={ratio.label} className="flex flex-col items-center gap-2">
            <div
              aria-hidden
              className={`${ratio.frameClass} rounded-md border-2 border-track-captions/60 bg-surface-dim shadow-e1`}
            />
            <span className="text-xs font-medium text-muted-foreground tnum">{ratio.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
