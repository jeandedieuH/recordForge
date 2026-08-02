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

// Live status card for the recorder. Polls the Rust backend while a session
// is active so the timer, state, and any error message stay current.
export function RecorderStatus() {
  const { status, error, markers } = useRecorderStore()
  useRecorderPolling()

  const duration = status?.recordedMs ?? 0

  return (
    <div className="rounded-lg border border-border bg-muted p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Recorder state</span>
        <span
          className={`text-sm font-semibold ${
            status?.state === "recording" ? "text-primary" : "text-foreground"
          }`}
          data-testid="recorder-state"
        >
          {status?.state ?? "idle"}
        </span>
      </div>

      {status?.state === "recording" || status?.state === "paused" ? (
        <div className="mt-2 text-2xl font-mono tabular-nums" data-testid="recorder-timer">
          {formatDuration(duration)}
        </div>
      ) : null}

      {status?.sessionId ? (
        <div className="mt-1 text-xs text-foreground/70">Session: {status.sessionId}</div>
      ) : null}

      {error ? <div className="mt-2 text-sm text-red-600">{error}</div> : null}

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
