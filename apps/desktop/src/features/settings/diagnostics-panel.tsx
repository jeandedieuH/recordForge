import { useEffect } from "react"
import { Button } from "@recordforge/ui"
import { useRecorderStore } from "../../hooks/use-recorder"

// Diagnostics panel used in Settings. Fetches and displays the platform, audio
// and video devices, and available encoders. It can also trigger the encoder
// benchmark via the recorder store.
export function DiagnosticsPanel() {
  const { diagnostics, benchmark, isLoading, error, loadDiagnostics, runBenchmark, clearError } =
    useRecorderStore()

  useEffect(() => {
    void loadDiagnostics()
  }, [loadDiagnostics])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Diagnostics</h2>
        <Button disabled={isLoading} onClick={runBenchmark}>
          Run benchmark
        </Button>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-900 dark:bg-red-950">
          {error}
          <button type="button" className="ml-2 underline" onClick={clearError}>
            Dismiss
          </button>
        </div>
      ) : null}

      {diagnostics ? (
        <div className="space-y-4 rounded-lg border border-border bg-muted p-4">
          <section>
            <h3 className="mb-2 text-sm font-medium">Platform</h3>
            <ul className="space-y-1 text-sm text-foreground/80">
              <li>OS: {diagnostics.platform.os}</li>
              <li>FFmpeg: {diagnostics.platform.ffmpegVersion}</li>
              {diagnostics.platform.cpu ? <li>CPU: {diagnostics.platform.cpu}</li> : null}
              {diagnostics.platform.memoryMb ? (
                <li>Memory: {diagnostics.platform.memoryMb} MB</li>
              ) : null}
            </ul>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-medium">Encoders</h3>
            {diagnostics.encoders.length === 0 ? (
              <p className="text-sm text-foreground/70">No encoders detected.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {diagnostics.encoders.map((encoder) => (
                  <li key={encoder.id} className="flex items-center gap-2">
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${
                        encoder.available ? "bg-green-500" : "bg-red-500"
                      }`}
                    />
                    <span>
                      {encoder.name} ({encoder.codec}) {encoder.vendor ? `[${encoder.vendor}]` : ""}
                      {encoder.available ? "" : ` — ${encoder.reason}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-sm font-medium">Audio devices</h3>
            {diagnostics.audioDevices.length === 0 ? (
              <p className="text-sm text-foreground/70">No audio devices found.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {diagnostics.audioDevices.map((device) => (
                  <li key={device.id} className="flex items-center gap-2">
                    <span className="text-foreground/70">{device.kind}</span>
                    <span>
                      {device.name} {device.isDefault ? "(default)" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-sm font-medium">Video devices</h3>
            {diagnostics.videoDevices.length === 0 ? (
              <p className="text-sm text-foreground/70">No video devices found.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {diagnostics.videoDevices.map((device) => (
                  <li key={device.id}>
                    {device.name} {device.isDefault ? "(default)" : ""}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : (
        <p className="text-sm text-foreground/70">Loading diagnostics...</p>
      )}

      {benchmark ? (
        <div className="rounded-lg border border-border bg-muted p-4">
          <h3 className="mb-2 text-sm font-medium">Benchmark</h3>
          <p className="text-sm">
            <span className="font-medium">Recommendation:</span>{" "}
            {benchmark.recommendation.encoderId} with {benchmark.recommendation.profileId}
          </p>
          <p className="text-sm text-foreground/70">{benchmark.recommendation.reason}</p>
          <ul className="mt-2 space-y-1 text-sm">
            {benchmark.results.map((result) => (
              <li key={`${result.encoderId}-${result.profileId}`} className="flex justify-between">
                <span>
                  {result.encoderId} @ {result.profileId}
                </span>
                <span>
                  {result.error ? `error: ${result.error}` : `${result.speed.toFixed(2)}x`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
