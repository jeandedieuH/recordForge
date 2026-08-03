import { AppShell } from "./app/app-shell"
import { FloatingControls } from "./features/recorder"
import { useRecorderStatusEvents } from "./hooks/use-recorder"

// The floating Tauri window loads index.html?floating=1, so we branch to a
// compact toolbar instead of the full app shell. Both branches subscribe to
// `recorder-status` events so global-shortcut and tray actions update either
// window instantly without waiting for the 1s status poll.
function App() {
  // Subscribe to recorder-status events once for whichever window this is.
  useRecorderStatusEvents()

  const isFloating = new URLSearchParams(window.location.search).get("floating") === "1"
  return isFloating ? <FloatingControls /> : <AppShell />
}

export default App
