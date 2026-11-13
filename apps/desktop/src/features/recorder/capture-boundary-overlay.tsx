import { useEffect, useState } from "react"

export type CaptureBoundaryPhase = "arming" | "recording" | "paused"

interface CaptureBoundaryOverlayProps {
  phase: CaptureBoundaryPhase | null
}

// The recording frame drawn inside a transparent window that already matches
// the capture bounds exactly. It exists to answer "what is being captured?" —
// not to decorate the desktop: the armed frame is bright for the countdown,
// then it fades to a hairline and disappears so the recording gets out of the
// way. State, source, and timer live in the floating toolbar.
const HAIRLINE_VISIBLE_MS = 8_000

export function CaptureBoundaryOverlay({ phase }: CaptureBoundaryOverlayProps) {
  const [dismissed, setDismissed] = useState(false)

  // The frame is only worth watching until the user has confirmed the capture
  // area is right; after that it is permanent chrome.
  useEffect(() => {
    if (phase !== "recording") {
      setDismissed(false)
      return
    }
    const timer = window.setTimeout(() => setDismissed(true), HAIRLINE_VISIBLE_MS)
    return () => window.clearTimeout(timer)
  }, [phase])

  if (!phase) return null

  const armed = phase === "arming"
  const paused = phase === "paused"
  const visible = armed || paused || !dismissed

  return (
    <div
      className={`pointer-events-none fixed inset-0 rounded-lg border transition-opacity duration-slow ease-forge ${
        armed
          ? "border-2 border-primary/70"
          : paused
            ? "border border-warning/60"
            : "border border-primary/25"
      } ${visible ? "opacity-100" : "opacity-0"}`}
      aria-hidden
    />
  )
}
