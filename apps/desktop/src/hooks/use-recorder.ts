import { useEffect } from "react"
import { useRecorderStore } from "../stores/recorder-store"

// Re-export the recorder Zustand store so the rest of the app can subscribe
// to recorder state and dispatch recorder actions.
export { useRecorderStore } from "../stores/recorder-store"

// Poll the Rust recorder while a session is active so the UI timer and state
// stay current. We read the latest status from the store inside the interval
// to avoid resetting the interval on every status update.
export function useRecorderPolling(intervalMs = 1000) {
  const refreshStatus = useRecorderStore((s) => s.refreshStatus)

  useEffect(() => {
    const id = setInterval(() => {
      const status = useRecorderStore.getState().status
      if (status?.state === "recording" || status?.state === "paused") {
        refreshStatus().catch(() => {})
      }
    }, intervalMs)

    return () => clearInterval(id)
  }, [refreshStatus, intervalMs])
}
