import { useState } from "react"
import { CountdownOverlay } from "./countdown-overlay"
import { cancelRecordingStart, confirmRecordingStart } from "../../lib/recorder"
import { toErrorMessage } from "../../lib/errors"

export function CountdownWindow() {
  const params = new URLSearchParams(window.location.search)
  const sessionId = params.get("sessionId") ?? ""
  const secondsValue = Number.parseInt(params.get("seconds") ?? "3", 10)
  const seconds = secondsValue === 5 ? 5 : 3
  const sourceName = params.get("sourceName") ?? "Selected Target"
  const [error, setError] = useState<string | null>(null)

  if (!sessionId) return null

  async function handleComplete() {
    try {
      await confirmRecordingStart(sessionId)
    } catch (cause) {
      setError(toErrorMessage(cause))
    }
  }

  async function handleCancel() {
    try {
      await cancelRecordingStart(sessionId)
    } catch (cause) {
      setError(toErrorMessage(cause))
    }
  }

  return (
    <>
      <CountdownOverlay
        seconds={seconds}
        sourceName={sourceName}
        onComplete={() => void handleComplete()}
        onCancel={() => void handleCancel()}
      />
      {error ? (
        <div className="fixed inset-x-4 bottom-4 z-60 rounded-md bg-red-950/90 p-3 text-center text-xs text-red-100">
          {error}
        </div>
      ) : null}
    </>
  )
}
