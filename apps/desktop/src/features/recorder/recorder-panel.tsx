import { useCallback, useState } from "react"
import { useRecorderStore } from "../../hooks/use-recorder"
import { CountdownOverlay } from "./countdown-overlay"
import { RecorderControls } from "./recorder-controls"
import { RecorderStatus } from "./recorder-status"

// Main recorder panel. It wraps the live status, source/configuration controls,
// and the optional 3-2-1 countdown overlay that runs before recording begins.
export function RecorderPanel() {
  const [counting, setCounting] = useState(false)
  const startRecording = useRecorderStore((s) => s.start)

  const handleStart = useCallback(() => {
    setCounting(true)
  }, [])

  const handleCountdownComplete = useCallback(() => {
    setCounting(false)
    void startRecording()
  }, [startRecording])

  return (
    <section className="relative flex flex-col gap-4">
      <RecorderStatus />
      <RecorderControls onStart={handleStart} />

      {counting ? <CountdownOverlay seconds={3} onComplete={handleCountdownComplete} /> : null}
    </section>
  )
}
