import { useEffect, useId, useRef, useState } from "react"
import { ChevronDown, SlidersHorizontal } from "lucide-react"
import { useRecorderStore } from "../../../hooks/use-recorder"
import { ScreenProcessingSection } from "./screen-processing-section"

// Per-take decisions live above this fold; GPU path, Smart Zoom and the
// keystroke overlay are set-and-forget preferences, so they default to
// collapsed instead of competing with the Start action.
export function AdvancedSection() {
  const smartZoomEnabled = useRecorderStore((state) => state.preferences.smartZoomEnabled)
  const captureKeystrokes = useRecorderStore((state) => state.preferences.captureKeystrokes)
  const gpuScreenCapture = useRecorderStore((state) => state.preferences.gpuScreenCapture)
  const activeFeatures =
    Number(smartZoomEnabled) + Number(captureKeystrokes) + Number(!gpuScreenCapture)

  const [open, setOpen] = useState(activeFeatures > 0)
  // Preferences hydrate after mount; expand once they prove a feature is armed,
  // but never override a collapse the user just made.
  const userToggled = useRef(false)
  useEffect(() => {
    if (!userToggled.current && activeFeatures > 0) setOpen(true)
  }, [activeFeatures])

  const panelId = useId()
  const summary =
    activeFeatures > 0
      ? `${activeFeatures} option${activeFeatures === 1 ? "" : "s"} changed from default`
      : "GPU path, Smart Zoom, keystroke overlay"

  return (
    <div className="rounded-lg border border-border bg-surface-dim">
      <button
        type="button"
        onClick={() => {
          userToggled.current = true
          setOpen((value) => !value)
        }}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-3.5 py-3 text-left transition-colors duration-fast hover:bg-overlay focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:outline-none"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-overlay text-muted-foreground">
          <SlidersHorizontal className="size-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-foreground">Advanced</span>
          <span className="block truncate text-xs text-subtle-foreground">{summary}</span>
        </span>
        {activeFeatures > 0 ? (
          <span
            className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary"
            aria-hidden
          >
            {activeFeatures} on
          </span>
        ) : null}
        <ChevronDown
          className={`size-4 shrink-0 text-subtle-foreground transition-transform duration-base ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>
      {open ? (
        <div
          id={panelId}
          className="animate-in fade-in-0 slide-in-from-top-1 border-t border-border/60 p-3.5 duration-base"
        >
          <ScreenProcessingSection />
        </div>
      ) : null}
    </div>
  )
}
