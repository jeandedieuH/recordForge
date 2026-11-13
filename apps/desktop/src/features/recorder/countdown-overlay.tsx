import { useCallback, useEffect, useRef, useState } from "react"
import { Check, CircleAlert, X } from "lucide-react"
import { IconButton } from "@recordforge/ui"

type CountdownPhase = "counting" | "starting" | "recording" | "cancelling" | "error"

interface CountdownOverlayProps {
  seconds?: number
  sourceName?: string
  onComplete: () => Promise<void>
  onCancel: () => Promise<void>
}

const RING_RADIUS = 13
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
// How long the "Recording" confirmation stays up before the capsule fades.
const RECORDING_HOLD_MS = 900

// Compact start capsule shown over the capture target while the countdown
// runs. It deliberately covers almost nothing: the old full-screen scrim hid
// the very thing the user was about to demonstrate. The frame around the
// capture area is drawn by the boundary window instead.
export function CountdownOverlay({
  seconds = 3,
  sourceName = "Selected target",
  onComplete,
  onCancel,
}: CountdownOverlayProps) {
  const [phase, setPhase] = useState<CountdownPhase>("counting")
  const [remainingMs, setRemainingMs] = useState(seconds * 1000)
  const [error, setError] = useState<string | null>(null)
  const [hidden, setHidden] = useState(false)

  const completeRef = useRef(onComplete)
  const cancelRef = useRef(onCancel)
  completeRef.current = onComplete
  cancelRef.current = onCancel

  // Guard against React StrictMode double-mounting in development, which
  // creates two intervals that both eventually fire onComplete — causing
  // startRecording to be called twice ("recording is already active").
  const firedRef = useRef(false)
  const deadlineRef = useRef(0)
  const intervalRef = useRef(0)

  const fail = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause))
    setPhase("error")
  }, [])

  const beginStart = useCallback(async () => {
    if (firedRef.current) return
    firedRef.current = true
    setPhase("starting")
    try {
      await completeRef.current()
      setPhase("recording")
    } catch (cause) {
      firedRef.current = false
      fail(cause)
    }
  }, [fail])

  const handleCancel = useCallback(async () => {
    if (firedRef.current) return
    firedRef.current = true
    setPhase("cancelling")
    try {
      await cancelRef.current()
      setHidden(true)
    } catch (cause) {
      firedRef.current = false
      fail(cause)
    }
  }, [fail])

  // Absolute deadline + 100 ms tick: the ring sweeps smoothly and the start
  // never drifts from chained timeouts.
  useEffect(() => {
    deadlineRef.current = performance.now() + seconds * 1000
    setRemainingMs(seconds * 1000)
    setPhase("counting")
    setHidden(false)
    setError(null)
    firedRef.current = false

    const tick = () => {
      const left = deadlineRef.current - performance.now()
      setRemainingMs(Math.max(0, left))
      if (left <= 0) {
        window.clearInterval(intervalRef.current)
        void beginStart()
      }
    }
    intervalRef.current = window.setInterval(tick, 100)
    return () => window.clearInterval(intervalRef.current)
  }, [seconds, beginStart])

  // Fade out once the capture is confirmed live, then let the native side
  // close the window that follows.
  useEffect(() => {
    if (phase !== "recording") return
    const timer = window.setTimeout(() => setHidden(true), RECORDING_HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [phase])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || phase !== "counting") return
      void handleCancel()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [handleCancel, phase])

  const totalMs = Math.max(1, seconds * 1000)
  const progress = phase === "counting" ? 1 - remainingMs / totalMs : 1
  const ringClass =
    phase === "recording"
      ? "stroke-success"
      : phase === "error"
        ? "stroke-recording"
        : "stroke-primary"

  // Announce phase changes only — the per-second tick would otherwise flood a
  // screen reader.
  const announcement =
    phase === "counting"
      ? `Recording starts in ${seconds} seconds. Press Escape to cancel.`
      : phase === "starting"
        ? "Starting capture."
        : phase === "recording"
          ? "Recording started."
          : phase === "cancelling"
            ? "Cancelling."
            : `Could not start recording. ${error ?? ""}`

  return (
    <div
      className={`flex h-screen w-screen items-center justify-center p-1.5 transition-opacity duration-base select-none ${
        hidden ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
    >
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
      {/* Single-line badge: numeral ring, target, icon-only cancel. The source
          name is the one piece of text worth keeping — the armed frame already
          shows the area, and a hint line made the badge big enough to compete
          with the content being recorded. */}
      <div className="flex w-full items-center gap-2.5 rounded-full border border-border-strong bg-surface/95 py-1.5 pr-1.5 pl-2.5 shadow-e1 backdrop-blur-xl">
        <div className="relative flex size-7 shrink-0 items-center justify-center">
          <svg className="absolute inset-0 size-full -rotate-90" viewBox="0 0 32 32" aria-hidden>
            <circle
              cx="16"
              cy="16"
              r={RING_RADIUS}
              className="fill-none stroke-border-strong"
              strokeWidth="2.5"
            />
            <circle
              cx="16"
              cy="16"
              r={RING_RADIUS}
              className={`fill-none transition-[stroke-dashoffset,stroke] duration-100 ease-linear ${ringClass}`}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={RING_CIRCUMFERENCE * (1 - progress)}
            />
          </svg>
          {phase === "recording" ? (
            <Check className="size-3 text-success" aria-hidden />
          ) : phase === "error" ? (
            <CircleAlert className="size-3 text-recording" aria-hidden />
          ) : (
            <span
              key={Math.ceil(remainingMs / 1000)}
              aria-hidden
              className="tnum animate-in zoom-in-95 fade-in-0 font-mono text-[10px] font-bold text-foreground duration-fast"
            >
              {Math.max(1, Math.ceil(remainingMs / 1000))}
            </span>
          )}
        </div>

        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-foreground">
          {phase === "recording"
            ? "Recording"
            : phase === "starting"
              ? "Starting capture…"
              : phase === "cancelling"
                ? "Cancelling…"
                : phase === "error"
                  ? "Couldn't start recording"
                  : sourceName}
        </span>

        {phase === "counting" ? (
          <IconButton
            label="Cancel countdown"
            shortcut="Esc"
            onClick={() => void handleCancel()}
            className="size-6 shrink-0 text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
          >
            <X />
          </IconButton>
        ) : phase === "error" ? (
          <IconButton
            label={error ?? "Dismiss"}
            onClick={() => setHidden(true)}
            className="size-6 shrink-0 text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
          >
            <X />
          </IconButton>
        ) : null}
      </div>
    </div>
  )
}
