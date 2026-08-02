import { DiagnosticsPanel } from "./diagnostics-panel"

// Settings view container. Phase 2 exposes the diagnostics panel here; future
// settings (shortcuts, output folder, quality defaults) can be added later.
export function SettingsView() {
  return (
    <section className="flex flex-col gap-4">
      <header>
        <h2 className="text-lg font-semibold">Settings</h2>
        <p className="text-sm text-foreground/70">Diagnostics and benchmark results</p>
      </header>
      <DiagnosticsPanel />
    </section>
  )
}
