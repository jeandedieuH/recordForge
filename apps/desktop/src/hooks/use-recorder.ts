import { useEffect } from "react"
import { listen } from "@tauri-apps/api/event"
import type { RecordingStatus } from "@recordforge/contracts"
import { useRecorderStore } from "../stores/recorder-store"

// Re-export the recorder Zustand store so the rest of the app can subscribe
// to recorder state and dispatch recorder actions.
export { useRecorderStore } from "../stores/recorder-store"
export type { TransportAction } from "../stores/recorder-store"

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

// Subscribe to the Rust `recorder-status` event so state changes triggered
// outside the React UI (global shortcuts, tray menu) and the separate floating
// window update the main window instantly, without waiting for the 1s poll.
//
// Mount this once near the root of each window that shows recorder state.
export function useRecorderStatusEvents() {
  const setStatus = useRecorderStore((s) => s.setStatus)

  useEffect(() => {
    // `listen` returns an unlisten function; the Tauri event payload is wrapped
    // in an `event.payload` field.
    let unlisten: (() => void) | undefined
    let active = true

    listen<RecordingStatus>("recorder-status", (event) => {
      setStatus(event.payload)
    }).then((fn) => {
      if (active) {
        unlisten = fn
      } else {
        fn()
      }
    })

    return () => {
      active = false
      unlisten?.()
    }
  }, [setStatus])
}
