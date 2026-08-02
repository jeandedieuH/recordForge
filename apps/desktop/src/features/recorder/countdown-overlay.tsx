import { useEffect, useRef, useState } from "react"

interface CountdownOverlayProps {
  seconds?: number
  onComplete: () => void
}

// Full-screen overlay that counts down from the given number of seconds and
// calls onComplete when it reaches zero. Used before starting a recording so
// the user has time to prepare.
export function CountdownOverlay({ seconds = 3, onComplete }: CountdownOverlayProps) {
  const [left, setLeft] = useState(seconds)
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  useEffect(() => {
    setLeft(seconds)
    const id = setInterval(() => {
      setLeft((prev) => {
        if (prev <= 1) {
          onCompleteRef.current()
          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => clearInterval(id)
  }, [seconds])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="text-9xl font-bold tabular-nums text-primary">{left}</div>
    </div>
  )
}
