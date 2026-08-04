import { useCallback, useEffect, useRef, useState } from "react"
import { Video } from "lucide-react"

interface CountdownOverlayProps {
  seconds?: number
  sourceName?: string
  onComplete: () => void
  onCancel?: () => void
}

// Modern, high-visibility overlay that counts down before starting a recording.
// Allows users to prepare their screen or cancel before capture begins.
export function CountdownOverlay({
  seconds = 3,
  sourceName = "Selected Target",
  onComplete,
  onCancel,
}: CountdownOverlayProps) {
  const [left, setLeft] = useState(seconds)
  const onCompleteRef = useRef(onComplete)
  const onCancelRef = useRef(onCancel)
  onCompleteRef.current = onComplete
  onCancelRef.current = onCancel

  // Guard against React StrictMode double-mounting in development, which
  // creates two intervals that both eventually fire onComplete — causing
  // startRecording to be called twice ("recording is already active").
  const firedRef = useRef(false)

  const handleCancel = useCallback(() => {
    if (firedRef.current) return
    firedRef.current = true
    onCancelRef.current?.()
  }, [])

  useEffect(() => {
    firedRef.current = false
    setLeft(seconds)
  }, [seconds])

  useEffect(() => {
    if (left <= 0) {
      if (!firedRef.current) {
        firedRef.current = true
        onCompleteRef.current()
      }
      return
    }

    const timer = setTimeout(() => {
      setLeft((prev) => prev - 1)
    }, 1000)

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onCancelRef.current) {
        clearTimeout(timer)
        handleCancel()
      }
    }

    window.addEventListener("keydown", handleKeyDown)

    return () => {
      clearTimeout(timer)
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [handleCancel, left])

  const progressPercent = ((seconds - left + 1) / seconds) * 100

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-slate-950/85 backdrop-blur-md text-white select-none transition-all duration-300">
      {/* Target Info Badge */}
      <div className="mb-8 flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium backdrop-blur">
        <Video className="size-4 text-primary animate-pulse" />
        <span>Preparing: {sourceName}</span>
      </div>

      {/* Pulsing Animated Countdown Container */}
      <div className="relative flex size-48 items-center justify-center">
        {/* Animated Progress Ring */}
        <svg className="absolute inset-0 size-full -rotate-90" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="44" className="stroke-white/10 fill-none" strokeWidth="6" />
          <circle
            cx="50"
            cy="50"
            r="44"
            className="stroke-primary fill-none transition-all duration-1000 ease-linear"
            strokeWidth="6"
            strokeDasharray="276"
            strokeDashoffset={276 - (276 * progressPercent) / 100}
            strokeLinecap="round"
          />
        </svg>

        {/* Countdown Number */}
        <div
          key={left}
          className="animate-in zoom-in-75 fade-in duration-300 font-mono text-7xl font-extrabold text-white tracking-tighter"
        >
          {left > 0 ? left : "GO!"}
        </div>
      </div>

      {/* The native countdown surface is click-through so it cannot block the desktop. */}
      {onCancel ? (
        <div className="mt-8 rounded-full border border-white/20 bg-white/10 px-5 py-2 text-xs font-semibold text-white/90">
          Press Esc or Ctrl+Shift+R to cancel
        </div>
      ) : null}
    </div>
  )
}
