import { ListTodo, X } from "lucide-react"
import { Button, Sheet, SheetContent, SheetTitle, Progress, Badge } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"
import { useJobsStore } from "../../../stores/jobs-store"

interface JobsDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function JobsDrawer({ open, onOpenChange }: JobsDrawerProps) {
  const activeJob = useTimelineStore((state) => state.activeJob)
  const activeExportJob = useTimelineStore((state) => state.activeExportJob)
  const allJobs = useJobsStore((state) => state.jobs)
  const activeJobs = allJobs.filter((job) => job.status === "pending" || job.status === "running")

  const relevantJobs =
    activeJob && !activeJobs.some((job) => job.id === activeJob.id)
      ? [activeJob, ...activeJobs]
      : activeJobs

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[min(80vw,384px)] p-0">
        <SheetTitle className="sr-only">Active jobs</SheetTitle>
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <ListTodo className="size-4 text-primary" aria-hidden />
              <span>Active jobs</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={() => onOpenChange(false)}
              aria-label="Close jobs drawer"
            >
              <X className="size-4" aria-hidden />
            </Button>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {relevantJobs.length === 0 && !activeExportJob ? (
              <p className="text-sm text-subtle-foreground">No active jobs.</p>
            ) : (
              <div className="flex flex-col gap-3">
                {activeExportJob ? <JobCard job={activeExportJob} title="Export" /> : null}
                {relevantJobs.map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    title={job.kind === "prepare" ? "Prepare" : job.kind}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function JobCard({
  job,
  title,
}: {
  job: {
    id: string
    status: string
    progress?: number
    message?: string | null
    kind: string
  }
  title: string
}) {
  const isRunning = job.status === "running" || job.status === "pending"
  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-medium text-foreground">{title}</span>
        <Badge
          variant={
            job.status === "failed" ? "recording" : job.status === "completed" ? "success" : "info"
          }
        >
          {job.status}
        </Badge>
      </div>
      {isRunning ? (
        <div className="space-y-1">
          <Progress value={job.progress ?? 0} />
          <div className="text-right font-mono text-subtle-foreground">
            {Math.round((job.progress ?? 0) * 100)}%
          </div>
        </div>
      ) : null}
      {job.message ? <p className="text-subtle-foreground">{job.message}</p> : null}
    </div>
  )
}
