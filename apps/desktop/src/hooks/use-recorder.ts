import { useEffect } from "react"
import { listen } from "@tauri-apps/api/event"
import {
  finalizationProgressSchema,
  recordingCompletedSchema,
  recordingMarkerSchema,
  recordingStatusSchema,
} from "@recordforge/contracts"
import { isTauri } from "../lib/settings"
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
    if (!isTauri()) return
    // Initial fetch on mount
    refreshStatus().catch(() => {})

    const id = setInterval(() => {
      const status = useRecorderStore.getState().status
      if (!status || status.state === "recording" || status.state === "paused") {
        refreshStatus().catch(() => {})
      }
    }, intervalMs)

    return () => clearInterval(id)
  }, [refreshStatus, intervalMs])
}

// Subscribe to the Rust `recorder-status` and `recorder-marker` events so state
// changes triggered outside the React UI (global shortcuts, tray menu) and the
// separate floating window update the main window instantly, without waiting
// for the 1s poll. Markers are broadcast on insertion so every surface shows a
// live count regardless of which input path created them.
//
// Mount this once near the root of each window that shows recorder state.
export function useRecorderStatusEvents() {
  const setStatus = useRecorderStore((s) => s.setStatus)
  const setFinalizationProgress = useRecorderStore((s) => s.setFinalizationProgress)
  const setCompletedRecordingId = useRecorderStore((s) => s.setCompletedRecordingId)
  const appendMarker = useRecorderStore((s) => s.appendMarker)
  const refreshStatus = useRecorderStore((s) => s.refreshStatus)

  useEffect(() => {
    if (!isTauri()) return
    // `listen` returns an unlisten function; the Tauri event payload is wrapped
    // in an `event.payload` field.
    const unlisteners: Array<() => void> = []
    let active = true
    const track = (promise: Promise<() => void>) => {
      void promise.then((fn) => {
        if (active) {
          unlisteners.push(fn)
        } else {
          fn()
        }
      })
    }

    track(
      listen<unknown>("recorder-status", (event) => {
        const parsed = recordingStatusSchema.safeParse(event.payload)
        if (parsed.success) setStatus(parsed.data)
        else void refreshStatus()
      }),
    )

    track(
      listen<unknown>("recorder-finalization-progress", (event) => {
        const parsed = finalizationProgressSchema.safeParse(event.payload)
        if (parsed.success) setFinalizationProgress(parsed.data)
      }),
    )

    track(
      listen<unknown>("recorder-marker", (event) => {
        const parsed = recordingMarkerSchema.safeParse(event.payload)
        if (parsed.success) appendMarker(parsed.data)
      }),
    )

    track(
      listen<unknown>("recording-completed", (event) => {
        const parsed = recordingCompletedSchema.safeParse(event.payload)
        if (parsed.success) setCompletedRecordingId(parsed.data.recordingId)
      }),
    )

    return () => {
      active = false
      for (const unlisten of unlisteners) unlisten()
    }
  }, [refreshStatus, setCompletedRecordingId, setFinalizationProgress, setStatus, appendMarker])
}
