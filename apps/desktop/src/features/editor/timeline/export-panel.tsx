import { useState } from "react"
import { save } from "@tauri-apps/plugin-dialog"
import { Button, Input, Progress } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"

// Final export UI: choose destination, submit the render plan, and show progress.
export function ExportPanel() {
  const store = useTimelineStore()
  const [outputPath, setOutputPath] = useState("")

  async function handleChoosePath() {
    const recording = store.recording
    if (!recording) return
    const path = await save({
      title: "Export edited video",
      defaultPath: recording.name,
      filters: [{ name: "MP4", extensions: ["mp4"] }],
    })
    if (path) {
      setOutputPath(path)
    }
  }

  async function handleExport() {
    if (!outputPath) return
    await store.export(outputPath)
  }

  const exportJob = store.activeExportJob

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted p-4">
      <h3 className="text-sm font-medium">Export</h3>

      <div className="flex items-end gap-2">
        <Input
          placeholder="Output path"
          value={outputPath}
          onChange={(e) => setOutputPath(e.target.value)}
          className="flex-1"
          readOnly
        />
        <Button onClick={handleChoosePath} variant="secondary">
          Choose
        </Button>
      </div>

      <Button onClick={handleExport} disabled={!outputPath} className="w-full">
        Export final video
      </Button>

      {exportJob ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="capitalize text-foreground/80">{exportJob.stage}</span>
            <span className="text-foreground/60">{Math.round(exportJob.progress * 100)}%</span>
          </div>
          <Progress value={exportJob.progress} />
          {exportJob.error ? <p className="text-xs text-red-600">{exportJob.error}</p> : null}
        </div>
      ) : null}
    </div>
  )
}
