import { ListTodo, X } from "lucide-react"
import { openUrl } from "@tauri-apps/plugin-opener"
import { Button, Sheet, SheetContent, SheetTitle, Progress, Badge } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"
import { useJobsStore } from "../../../stores/jobs-store"
import { usePublicationStore } from "../../../stores/publication-store"
import { publicationJobIsActive, type PublicationJob } from "@recordforge/contracts"

interface JobsDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function JobsDrawer({ open, onOpenChange }: JobsDrawerProps) {
  const activeJob = useTimelineStore((state) => state.activeJob)
  const activeExportJob = useTimelineStore((state) => state.activeExportJob)
  const allJobs = useJobsStore((state) => state.jobs)
  const publicationJobs = usePublicationStore((state) => state.jobs)
  const cancelPublication = usePublicationStore((state) => state.cancel)
  const activeJobs = allJobs.filter((job) => job.status === "pending" || job.status === "running")

  const relevantJobs =
    activeJob && !activeJobs.some((job) => job.id === activeJob.id)
      ? [activeJob, ...activeJobs]
      : activeJobs

  // Publications are long-lived (background uploads) — active ones first,
  // then a few recent terminal results; never silently dropped.
  const activePublications = publicationJobs.filter(publicationJobIsActive)
  const recentPublications = publicationJobs
    .filter((job) => !publicationJobIsActive(job))
    .slice(0, 5)

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
            {relevantJobs.length === 0 && !activeExportJob && publicationJobs.length === 0 ? (
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
                {activePublications.map((job) => (
                  <PublicationJobCard
                    key={job.id}
                    job={job}
                    onCancel={() => void cancelPublication(job.id)}
                  />
                ))}
                {recentPublications.map((job) => (
                  <PublicationJobCard key={job.id} job={job} />
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

const PROVIDER_LABEL: Record<string, string> = {
  hosted: "Instant Share",
  s3: "Share to bucket",
  youTube: "YouTube publish",
}

function PublicationJobCard({ job, onCancel }: { job: PublicationJob; onCancel?: () => void }) {
  const active = publicationJobIsActive(job)
  const percent =
    job.totalBytes > 0 ? Math.min(100, Math.round((job.uploadedBytes / job.totalBytes) * 100)) : 0
  const resultUrl = job.result?.url
  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-medium text-foreground">
          {PROVIDER_LABEL[job.provider] ?? job.provider}
        </span>
        <Badge
          variant={
            job.status === "failed" || job.status === "uncertain"
              ? "recording"
              : job.status === "completed"
                ? "success"
                : job.status === "cancelled"
                  ? "warning"
                  : "info"
          }
        >
          {job.status}
        </Badge>
      </div>
      {active ? (
        <div className="space-y-1">
          <Progress value={percent} />
          <div className="flex items-center justify-between">
            <span className="font-mono text-subtle-foreground">{percent}%</span>
            {onCancel ? (
              <button
                type="button"
                className="text-subtle-foreground underline-offset-2 hover:underline"
                onClick={onCancel}
              >
                Cancel
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {resultUrl ? (
        <button
          type="button"
          className="break-all text-left text-primary underline-offset-2 hover:underline"
          onClick={() => void openUrl(resultUrl)}
        >
          {resultUrl}
        </button>
      ) : null}
      {job.error ? <p className="text-warning">{job.error.message}</p> : null}
      {job.warnings?.map((warning) => (
        <p key={warning} className="text-subtle-foreground">
          {warning}
        </p>
      ))}
    </div>
  )
}
