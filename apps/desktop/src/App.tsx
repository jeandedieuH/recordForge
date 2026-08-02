import { AppShell } from "./app/app-shell"
import { FloatingControls } from "./features/recorder"

// The floating Tauri window loads index.html?floating=1, so we branch to a
// compact toolbar instead of the full app shell.
function App() {
  const isFloating = new URLSearchParams(window.location.search).get("floating") === "1"
  return isFloating ? <FloatingControls /> : <AppShell />
}

export default App
