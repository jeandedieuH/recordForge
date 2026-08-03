import type { RecorderState } from "@recordforge/contracts"
import { useRecorderStore, useRecorderPolling } from "../../hooks/use-recorder"

function formatDuration(ms: number) {
  const seconds = Math.floor((ms / 1000) % 60)
  const minutes = Math.floor((ms / 1000 / 60) % 60)
  const hours = Math.floor(ms / 1000 / 60 / 60)
  return [hours, minutes, seconds].map((v) => v.toString().padStart(2, "0")).join(":")
}

function formatMarkerTime(ms: number) {
  return formatDuration(ms)
}

// Friendly label + indicator dot color per recorder state, so the status card
// reads like a product UI rather than a raw enum dump.
const STATE_DISPLAY: Record<RecorderState, { label: string; dot: string }> = {
  idle: { label: "Ready", dot: "bg-foreground/40" },
  "selecting-source": { label: "Selecting source", dot: "bg-foreground/40" },
  configuring: { label: "Configuring", dot: "bg-foreground/40" },
  countdown: { label: "Starting", dot: "bg-amber-500" },
  recording: { label: "Recording", dot: "bg-red-500 animate-pulse" },
  paused: { label: "Paused", dot: "bg-amber-500" },
  finalizing: { label: "Finalizing", dot: "bg-primary" },
  completed: { label: "Completed", dot: "bg-emerald-500" },
  failed: { label: "Failed", dot: "bg-red-600" },
  recovering: { label: "Recovering", dot: "bg-primary" },
  "recovery-required": { label: "Recovery required", dot: "bg-amber-500" },
}

// Live status card for the recorder. Polls the Rust backend while a session
// is active so the timer, state, and any error message stay current.
export function RecorderStatus() {
  const { status, error, saveMessage, markers, clearSaveMessage } = useRecorderStore()
  useRecorderPolling()

  const state: RecorderState = status?.state ?? "idle"
  const display = STATE_DISPLAY[state] ?? STATE_DISPLAY.idle
  const duration = status?.recordedMs ?? 0
  const isLive = state === "recording" || state === "paused"

  return (
    <div className="rounded-lg border border-border bg-muted p-4">
      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${display.dot}`}
          data-testid="recorder-state-dot"
          aria-hidden
        />
        <span className="text-sm font-medium" data-testid="recorder-state">
          {display.label}
        </span>
      </div>

      {isLive ? (
        <div className="mt-2 text-3xl font-mono tabular-nums" data-testid="recorder-timer">
          {formatDuration(duration)}
        </div>
      ) : null}

      {/* Raw session id is useful for support/diagnostics but noisy in normal
          use, so it lives behind a collapsed disclosure. */}
      {status?.sessionId ? (
        <details className="mt-2 text-xs text-foreground/60">
          <summary className="cursor-pointer select-none">Session details</summary>
          <span className="mt-1 block break-all font-mono">{status.sessionId}</span>
        </details>
      ) : null}

      {error ? (
        <div role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </div>
      ) : null}

      {saveMessage ? (
        <div
          role="status"
          className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-400"
        >
          {saveMessage}
          <button type="button" className="ml-2 underline" onClick={clearSaveMessage}>
            Dismiss
          </button>
        </div>
      ) : null}

      {markers.length > 0 ? (
        <div className="mt-4">
          <h4 className="mb-2 text-sm font-medium">Markers</h4>
          <ul className="space-y-1 text-sm">
            {markers.map((marker) => (
              <li key={marker.id} className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 rounded-full bg-primary" />
                <span className="font-medium">{marker.label}</span>
                <span className="text-foreground/70">@ {formatMarkerTime(marker.timestampMs)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
