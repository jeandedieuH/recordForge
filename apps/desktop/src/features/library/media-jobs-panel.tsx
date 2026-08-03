import { useEffect, useMemo } from "react"
import { Button, Progress } from "@recordforge/ui"
import { useJobsStore } from "../../stores/jobs-store"

interface MediaJobsPanelProps {
  // When provided, only show jobs for that recording. Otherwise show all active jobs.
  recordingId?: string
}

// Show active media preparation jobs.
export function MediaJobsPanel({ recordingId }: MediaJobsPanelProps) {
  const startListening = useJobsStore((state) => state.startListening)
  const stopListening = useJobsStore((state) => state.stopListening)
  const loadForRecording = useJobsStore((state) => state.loadForRecording)
  const cancel = useJobsStore((state) => state.cancel)
  const jobs = useJobsStore((state) => state.jobs)

  // Subscribe to the shared job event channel on mount. The store is not in
  // the dependency array because the whole state object changes on every store
  // update and would trigger an infinite effect/cleanup loop. Action references
  // returned by Zustand are stable, so we depend on those instead.
  useEffect(() => {
    void startListening()
    if (recordingId) {
      void loadForRecording(recordingId)
    }
    return () => {
      stopListening()
    }
  }, [recordingId, startListening, stopListening, loadForRecording])

  const visibleJobs = useMemo(
    () =>
      jobs.filter(
        (j) =>
          (!recordingId || j.recordingId === recordingId) &&
          (j.status === "pending" || j.status === "running" || j.status === "failed"),
      ),
    [jobs, recordingId],
  )

  if (visibleJobs.length === 0) return null

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted p-4">
      <h3 className="text-sm font-medium">Media preparation</h3>
      {visibleJobs.map((job) => (
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
              onClick={() => cancel(job.id)}
            >
              Cancel
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  )
}
