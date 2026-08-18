import { useEffect } from "react"
import { AppShell } from "./app/app-shell"
import {
  CaptureBoundaryOverlay,
  CountdownWindow,
  FloatingControls,
  RegionPickerWindow,
} from "./features/recorder"
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
  const windowKind =
    typeof window !== "undefined"
      ? (window as unknown as { __RECORD_FORGE_WINDOW_KIND?: string }).__RECORD_FORGE_WINDOW_KIND
      : undefined

  const isFloating = params.get("floating") === "1" || windowKind === "floating"
  const isBoundary = params.get("boundary") === "1" || windowKind === "boundary"
  const isCountdown = params.get("countdown") === "1" || windowKind === "countdown"
  const isRegionPicker =
    params.get("region") === "1" ||
    params.get("region_picker") === "1" ||
    windowKind === "region-picker" ||
    windowKind === "region"
  useEffect(() => {
    const root = document.documentElement
    if (isFloating) root.dataset.floating = "true"
    if (isBoundary) root.dataset.boundary = "true"
    if (isCountdown) root.dataset.countdown = "true"
    if (isRegionPicker) root.dataset.regionPicker = "true"
    return () => {
      delete root.dataset.floating
      delete root.dataset.boundary
      delete root.dataset.countdown
      delete root.dataset.regionPicker
    }
  }, [isBoundary, isCountdown, isFloating, isRegionPicker])

  if (isCountdown) return <CountdownWindow />
  if (isBoundary) return <BoundaryWindow />
  if (isRegionPicker) return <RegionPickerWindow />
  return isFloating ? <FloatingControls /> : <AppShell />
}

export default App
