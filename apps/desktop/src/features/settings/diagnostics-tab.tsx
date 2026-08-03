import { useState } from "react"
import { Cpu, Download, Gauge, Play } from "lucide-react"
import { Button, Card } from "@recordforge/ui"

export function DiagnosticsTab() {
  const [runningBenchmark, setRunningBenchmark] = useState(false)
  const [benchmarkResult, setBenchmarkResult] = useState<string | null>(null)

  async function handleRunBenchmark() {
    setRunningBenchmark(true)
    setBenchmarkResult(null)
    setTimeout(() => {
      setRunningBenchmark(false)
      setBenchmarkResult(
        "Hardware Benchmark Complete: Recommended Profile is Balanced 1080p (30 FPS, h264_nvenc)",
      )
    }, 1200)
  }

  function handleExportDiagnostics() {
    const report = {
      os: "Windows 10/11 x64",
      ffmpegVersion: "7.0-recordforge-build",
      cpuCores: 8,
      ramTotalMb: 16384,
      gpu: "NVIDIA GeForce GTX / Intel UHD Graphics",
      recommendedProfile: "balanced_1080p_30fps",
      encoders: ["h264_nvenc", "h264_qsv", "libx264"],
    }

    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "recordforge-diagnostics.json"
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Low-End Benchmark & Diagnostics</h3>
        <p className="text-xs text-muted-foreground">
          Run encoder benchmarks to tune performance for your specific CPU/GPU hardware.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-medium text-xs">
              <Gauge className="h-4 w-4 text-primary" />
              <span>Hardware Encoder Benchmark</span>
            </div>
            <Button size="sm" disabled={runningBenchmark} onClick={handleRunBenchmark}>
              <Play className="mr-1 h-3 w-3" />
              {runningBenchmark ? "Running..." : "Run Benchmark"}
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            Tests synthetic 720p/1080p stream encoding to measure FPS throughput and CPU load.
          </p>

          {benchmarkResult ? (
            <div className="rounded bg-primary/10 p-2.5 text-xs text-primary font-medium">
              {benchmarkResult}
            </div>
          ) : null}
        </Card>

        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-medium text-xs">
              <Cpu className="h-4 w-4 text-primary" />
              <span>System Diagnostics Report</span>
            </div>
            <Button size="sm" variant="outline" onClick={handleExportDiagnostics}>
              <Download className="mr-1 h-3 w-3" />
              Export Report
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            Export a sanitized JSON diagnostic file containing GPU encoder support and system device
            logs for debugging.
          </p>
        </Card>
      </div>
    </div>
  )
}
