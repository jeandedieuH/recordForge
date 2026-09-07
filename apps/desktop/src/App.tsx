import { useEffect } from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { AppShell } from "./app/app-shell"
import { AppErrorBoundary } from "./components/error-boundary"
import {
  CaptureBoundaryOverlay,
  CountdownWindow,
  FloatingControls,
  RegionPickerWindow,
  WebcamPreviewWindow,
} from "./features/recorder"
import { useRecorderPolling, useRecorderStatusEvents } from "./hooks/use-recorder"
import { isTauri } from "./lib/settings"
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
  const isWebcamPreview =
    params.get("webcam_preview") === "1" ||
    params.get("webcam-preview") === "1" ||
    windowKind === "webcam-preview"

  useEffect(() => {
    const root = document.documentElement
    if (isFloating) root.dataset.floating = "true"
    if (isBoundary) root.dataset.boundary = "true"
    if (isCountdown) root.dataset.countdown = "true"
    if (isRegionPicker) root.dataset.regionPicker = "true"
    if (isWebcamPreview) {
      root.dataset.webcamPreview = "true"
      root.setAttribute("data-webcam-preview", "true")
    }
    return () => {
      delete root.dataset.floating
      delete root.dataset.boundary
      delete root.dataset.countdown
      delete root.dataset.regionPicker
      delete root.dataset.webcamPreview
      root.removeAttribute("data-webcam-preview")
    }
  }, [isBoundary, isCountdown, isFloating, isRegionPicker, isWebcamPreview])

  // Reveal the main window smoothly on startup once React has mounted and the
  // initial DOM/theme is ready. This eliminates any transparent/empty window flash.
  useEffect(() => {
    if (!isTauri()) return
    const isAuxiliary = isFloating || isBoundary || isCountdown || isRegionPicker || isWebcamPreview
    if (!isAuxiliary) {
      const animFrame = requestAnimationFrame(() => {
        const appWindow = getCurrentWindow()
        void appWindow.show().then(() => {
          void appWindow.setFocus()
        })
      })
      return () => cancelAnimationFrame(animFrame)
    }
  }, [isBoundary, isCountdown, isFloating, isRegionPicker, isWebcamPreview])

  return (
    <AppErrorBoundary>
      {isCountdown ? (
        <CountdownWindow />
      ) : isBoundary ? (
        <BoundaryWindow />
      ) : isRegionPicker ? (
        <RegionPickerWindow />
      ) : isFloating ? (
        <FloatingControls />
      ) : isWebcamPreview ? (
        <WebcamPreviewWindow />
      ) : (
        <AppShell />
      )}
    </AppErrorBoundary>
  )
}

export default App
