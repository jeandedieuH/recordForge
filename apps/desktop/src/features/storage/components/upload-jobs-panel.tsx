import { useEffect } from "react"
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  Server,
  Trash2,
  XCircle,
} from "lucide-react"
import { Badge, Button, Card, Progress } from "@recordforge/ui"
import { calculateProgress, formatBytes, formatEta, formatSpeed } from "@recordforge/storage-core"
import { useStorageStore } from "../storage-store"
import { openUrl } from "@tauri-apps/plugin-opener"

export function UploadJobsPanel() {
  const { jobs, isLoadingJobs, fetchJobs, cancelUpload, retryUpload, deleteJob, initListeners } =
    useStorageStore()

  useEffect(() => {
    fetchJobs()
    const unsubscribe = initListeners()
    return () => {
      unsubscribe()
    }
  }, [fetchJobs, initListeners])

  async function handleCopyUrl(url: string) {
    await navigator.clipboard.writeText(url)
  }

  async function handleOpenUrl(url: string) {
    try {
      await openUrl(url)
    } catch {
      window.open(url, "_blank")
    }
  }

  const activeJobs = jobs.filter((j) => j.state === "pending" || j.state === "uploading")

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-semibold flex items-center gap-2">
            <Cloud className="h-4 w-4 text-primary" />
            Cloud Uploads & Transfers
          </h4>
          <p className="text-xs text-muted-foreground">
            Monitor real-time video upload progress, speed, and cloud links.
          </p>
        </div>

        {activeJobs.length > 0 ? (
          <Badge variant="outline" className="gap-1.5 text-xs text-primary border-primary/30">
            <Loader2 className="h-3 w-3 animate-spin" />
            {activeJobs.length} Active Transfer{activeJobs.length > 1 ? "s" : ""}
          </Badge>
        ) : null}
      </div>

      {isLoadingJobs && jobs.length === 0 ? (
        <div className="flex items-center justify-center p-6 text-xs text-muted-foreground gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading transfers...
        </div>
      ) : jobs.length === 0 ? (
        <Card className="p-6 border-dashed text-center flex flex-col items-center justify-center space-y-1.5 bg-muted/10">
          <Cloud className="h-6 w-6 text-muted-foreground/40" />
          <div className="text-xs font-medium text-foreground">No Transfer History</div>
          <p className="text-[11px] text-muted-foreground">
            Exports uploaded to S3 or Google Drive will appear here.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => {
            const progress = calculateProgress(job.bytesUploaded, job.totalBytes, job.speedBps)
            const isUploading = job.state === "uploading" || job.state === "pending"
            const isCompleted = job.state === "completed"
            const isFailed = job.state === "failed"
            const isCancelled = job.state === "cancelled"

            return (
              <Card
                key={job.id}
                className={`p-3.5 space-y-2.5 transition-all text-xs bg-surface border-border ${
                  isUploading ? "border-primary/40 bg-primary/2" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="h-7 w-7 rounded bg-surface-dim border border-border flex items-center justify-center shrink-0">
                      {job.providerKind === "s3" ? (
                        <Server className="h-3.5 w-3.5 text-primary" />
                      ) : (
                        <Cloud className="h-3.5 w-3.5 text-primary" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="font-semibold truncate text-foreground">{job.remotePath}</div>
                      <div className="text-[11px] text-subtle-foreground truncate">
                        {job.providerProfileName ?? "Cloud Destination"} • {formatBytes(job.totalBytes)}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {isUploading ? (
                      <Badge variant="outline" className="text-[10px] gap-1 text-primary border-primary/30">
                        <Loader2 className="h-2.5 w-2.5 animate-spin" />
                        {progress.percentage}%
                      </Badge>
                    ) : isCompleted ? (
                      <Badge className="text-[10px] gap-1 bg-green-500/10 text-green-500 border-green-500/20">
                        <CheckCircle2 className="h-2.5 w-2.5" />
                        Uploaded
                      </Badge>
                    ) : isFailed ? (
                      <Badge className="text-[10px] gap-1 bg-destructive/10 text-destructive border-destructive/20">
                        <AlertCircle className="h-2.5 w-2.5" />
                        Failed
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] text-muted-foreground">
                        <XCircle className="h-2.5 w-2.5 mr-1" />
                        Cancelled
                      </Badge>
                    )}
                  </div>
                </div>

                {isUploading ? (
                  <div className="space-y-1.5 pt-1">
                    <Progress value={progress.percentage} className="h-1.5" />
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                      <span>
                        {formatBytes(job.bytesUploaded)} / {formatBytes(job.totalBytes)}
                      </span>
                      <div className="flex items-center gap-2 font-medium">
                        <span>{formatSpeed(job.speedBps ?? 0)}</span>
                        <span>•</span>
                        <span>ETA: {formatEta(progress.etaSeconds ?? 0)}</span>
                      </div>
                    </div>
                  </div>
                ) : null}

                {job.lastError ? (
                  <div className="text-[11px] text-destructive bg-destructive/10 p-2 rounded flex items-center gap-1.5">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{job.lastError}</span>
                  </div>
                ) : null}

                <div className="flex items-center justify-between pt-1 border-t text-[11px]">
                  <span className="text-muted-foreground text-[10px]">
                    {new Date(job.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>

                  <div className="flex items-center gap-1.5">
                    {isUploading ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs text-destructive hover:bg-destructive/10"
                        onClick={() => cancelUpload(job.id)}
                      >
                        Cancel
                      </Button>
                    ) : null}

                    {isFailed || isCancelled ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs gap-1"
                        onClick={() => retryUpload(job.id)}
                      >
                        <RefreshCw className="h-3 w-3" />
                        Retry
                      </Button>
                    ) : null}

                    {job.remoteUrl ? (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs gap-1"
                          onClick={() => handleCopyUrl(job.remoteUrl!)}
                        >
                          <Copy className="h-3 w-3" />
                          Copy Link
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs gap-1 text-primary"
                          onClick={() => handleOpenUrl(job.remoteUrl!)}
                        >
                          <ExternalLink className="h-3 w-3" />
                          Open
                        </Button>
                      </>
                    ) : null}

                    {!isUploading ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => deleteJob(job.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
