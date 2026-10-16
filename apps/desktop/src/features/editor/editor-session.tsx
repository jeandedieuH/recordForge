import { useEffect, useRef } from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { isTauri } from "../../lib/settings"
import { useEditorStore } from "../../stores/editor-store"
import { useTimelineStore } from "../../stores/timeline-store"
import { useUpdaterStore } from "../../stores/updater-store"

interface EditorSessionProps {
  recordingId: string
}

/**
 * Phase 1: owns the lifetime of an open editor session.
 *
 * - Loads the project once when the recording id becomes active.
 * - Keeps the media-job listener alive while the user moves between editor and
 *   export panels.
 * - Prevents the window from closing while dirty changes are still being flushed.
 *
 * This component is intentionally non-visual. It is mounted whenever an editor
 * session is active, independent of which panel (editor or export) is visible.
 */
export function EditorSession({ recordingId }: EditorSessionProps) {
  const previousIdRef = useRef<string | null>(null)

  // Load or reload the project when the recording id changes, and keep the
  // media job listener alive for the active session.
  useEffect(() => {
    const previous = previousIdRef.current
    const previousId = previous
    let cancelled = false

    const run = async () => {
      const { load, startListening, closeSession } = useTimelineStore.getState()

      if (previousId && previousId !== recordingId) {
        // Switching recordings while one is open is unusual; flush and reset.
        const closed = await closeSession()
        if (!closed || cancelled) return
      }

      await load(recordingId)
      if (cancelled) return

      await startListening()
    }

    void run()

    previousIdRef.current = recordingId

    return () => {
      cancelled = true
      useTimelineStore.getState().stopListening()
    }
  }, [recordingId])

  // Window close guard: flush pending saves before allowing the window to close.
  useEffect(() => {
    if (!isTauri()) return

    let unlisten: (() => void) | null = null
    let isFlushing = false
    let allowCloseAfterFlush = false

    getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (allowCloseAfterFlush) return

        // Never veto a close while an update install is underway — the spawned
        // installer expects the process to exit, not to be blocked by the
        // editor's dirty-save guard.
        if (useUpdaterStore.getState().status === "installing") return

        const { isDirty, saveStatus } = useEditorStore.getState()
        const { project } = useTimelineStore.getState()
        if (!project || (!isDirty && saveStatus !== "saving")) return

        if (isFlushing) {
          event.preventDefault()
          return
        }

        isFlushing = true
        event.preventDefault()

        try {
          await useTimelineStore.getState().save()
          if (useEditorStore.getState().saveStatus === "error") {
            isFlushing = false
            return
          }
          allowCloseAfterFlush = true
          // close() — not destroy(): destroy() bypasses CloseRequested, which
          // skips the Rust minimize-to-tray handler and permanently tears the
          // window down, leaving the tray icon unable to reopen the app.
          const appWindow = getCurrentWindow()
          await appWindow.close()
          // When minimize-to-tray converted the close into a hide, this
          // webview is still alive: re-arm the guard so the next real close
          // flushes dirty state again. If the window was actually destroyed
          // the webview is gone and this probe never resolves.
          try {
            await appWindow.isVisible()
            allowCloseAfterFlush = false
            isFlushing = false
          } catch {
            // Window destroyed — nothing left to re-arm.
          }
        } catch {
          isFlushing = false
        }
      })
      .then((unsub) => {
        unlisten = unsub
      })

    return () => {
      if (unlisten) unlisten()
    }
  }, [])

  return null
}
