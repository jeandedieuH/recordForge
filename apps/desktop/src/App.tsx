import { useEffect } from "react"
import { AppShell } from "./app/app-shell"
import { CaptureBoundaryOverlay, CountdownWindow, FloatingControls } from "./features/recorder"
import { useRecorderPolling, useRecorderStatusEvents } from "./hooks/use-recorder"
import { useRecorderStore } from "./stores/recorder-store"

function BoundaryWindow() {
  useRecorderPolling()
  const status = useRecorderStore((state) => state.status)
  const isActive = status?.state === "recording" || status?.state === "paused"

  return (
    <CaptureBoundaryOverlay
      source={null}
      isActive={isActive}
      isPaused={status?.state === "paused"}
    />
  )
}

// Each auxiliary Tauri window uses a query flag so it can share the compiled
// frontend without accidentally rendering the full application shell.
function App() {
  useRecorderStatusEvents()

  const params = new URLSearchParams(window.location.search)
  const isFloating = params.get("floating") === "1"
  const isBoundary = params.get("boundary") === "1"
  const isCountdown = params.get("countdown") === "1"
  useEffect(() => {
    const root = document.documentElement
    if (isFloating) root.dataset.floating = "true"
    if (isBoundary) root.dataset.boundary = "true"
    return () => {
      delete root.dataset.floating
      delete root.dataset.boundary
    }
  }, [isBoundary, isFloating])

  if (isCountdown) return <CountdownWindow />
  if (isBoundary) return <BoundaryWindow />
  return isFloating ? <FloatingControls /> : <AppShell />
}

export default App
