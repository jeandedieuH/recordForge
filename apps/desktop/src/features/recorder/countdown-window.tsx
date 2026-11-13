import { CountdownOverlay } from "./countdown-overlay"
import { cancelRecordingStart, confirmRecordingStart } from "../../lib/recorder"

interface CountdownParams {
  sessionId?: string
  seconds?: number
  sourceName?: string
}

// Thin window shell: it reads the session parameters injected by Rust and
// hands the countdown over to the capsule overlay, which owns the timing,
// cancellation, and the "capture is live" confirmation.
export function CountdownWindow() {
  const params = new URLSearchParams(window.location.search)
  const windowParams =
    typeof window !== "undefined"
      ? (
          window as unknown as {
            __RECORD_FORGE_COUNTDOWN_PARAMS?: CountdownParams
          }
        ).__RECORD_FORGE_COUNTDOWN_PARAMS
      : undefined

  const sessionId = params.get("sessionId") ?? windowParams?.sessionId ?? ""
  const secondsValue = Number.parseInt(
    params.get("seconds") ?? String(windowParams?.seconds ?? "3"),
    10,
  )
  const seconds = secondsValue === 5 ? 5 : secondsValue === 0 ? 0 : 3
  const sourceName = params.get("sourceName") ?? windowParams?.sourceName ?? "Selected target"

  if (!sessionId) return null

  // A zero-second countdown never opens this window (`prepare_recording`
  // starts the session directly), so anything reaching here counts down.
  return (
    <CountdownOverlay
      seconds={Math.max(1, seconds)}
      sourceName={sourceName}
      onComplete={() => confirmRecordingStart(sessionId)}
      onCancel={() => cancelRecordingStart(sessionId)}
    />
  )
}
