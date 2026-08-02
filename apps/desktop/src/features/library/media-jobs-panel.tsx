import { useEffect } from "react"
import { Button, Progress } from "@recordforge/ui"
import { useJobsStore } from "../../stores/jobs-store"

interface MediaJobsPanelProps {
  // When provided, only show jobs for that recording. Otherwise show all active jobs.
  recordingId?: string
}

// Show active media preparation jobs.
export function MediaJobsPanel({ recordingId }: MediaJobsPanelProps) {
  const store = useJobsStore()

  useEffect(() => {
    void store.startListening()
    if (recordingId) {
      void store.loadForRecording(recordingId)
    }
    return () => {
      store.stopListening()
    }
  }, [recordingId, store])

  const jobs = store.jobs.filter(
    (j) =>
      (!recordingId || j.recordingId === recordingId) &&
      (j.status === "pending" || j.status === "running" || j.status === "failed"),
  )

  if (jobs.length === 0) return null

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted p-4">
      <h3 className="text-sm font-medium">Media preparation</h3>
      {jobs.map((job) => (
        <div key={job.id} className="space-y-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="capitalize text-foreground/80">{job.stage}</span>
            <span className="text-foreground/60">{Math.round(job.progress * 100)}%</span>
          </div>
          <Progress value={job.progress} />
          {job.message ? <p className="text-xs text-foreground/60">{job.message}</p> : null}
          {job.error ? <p className="text-xs text-red-600">{job.error}</p> : null}
          {job.status === "running" ? (
            <Button
              variant="ghost"
              className="h-auto px-2 py-1 text-xs"
              onClick={() => store.cancel(job.id)}
            >
              Cancel
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  )
}
