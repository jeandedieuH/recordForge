import { useEffect, useState } from "react"
import { getVersion } from "@tauri-apps/api/app"
import { AlertCircle, CheckCircle2, Download, RefreshCw, ShieldCheck } from "lucide-react"
import type { UpdateReadinessBlocker } from "@recordforge/contracts"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Progress,
  Skeleton,
  useToast,
} from "@recordforge/ui"
import { isTauri } from "../../lib/settings"
import { useUpdaterStore } from "../../stores/updater-store"

export interface UpdateCardProps {
  onBeforeInstall?: () => Promise<void>
}

const BLOCKER_MESSAGES: Record<UpdateReadinessBlocker, string> = {
  recording: "Finish or cancel the active recording first.",
  "recording-finalizing": "Wait for the recording to finish finalizing.",
  "media-job-active": "Wait for the active media preparation or export job to finish.",
  "upload-active": "Wait for active uploads to finish or cancel them.",
  "operation-active": "Wait for the current native operation to finish.",
  "update-in-progress": "Another update installation is already in progress.",
}

export function UpdateCard({ onBeforeInstall }: UpdateCardProps) {
  const { toast } = useToast()
  const status = useUpdaterStore((state) => state.status)
  const update = useUpdaterStore((state) => state.update)
  const readiness = useUpdaterStore((state) => state.readiness)
  const errorMessage = useUpdaterStore((state) => state.errorMessage)
  const downloadedBytes = useUpdaterStore((state) => state.downloadedBytes)
  const contentLength = useUpdaterStore((state) => state.contentLength)
  const checkForUpdate = useUpdaterStore((state) => state.checkForUpdate)
  const installUpdate = useUpdaterStore((state) => state.installUpdate)
  const [currentVersion, setCurrentVersion] = useState<string | null>(null)

  useEffect(() => {
    if (!isTauri()) return
    void getVersion()
      .then(setCurrentVersion)
      .catch(() => setCurrentVersion(null))
  }, [])

  if (!isTauri() || import.meta.env.DEV) {
    return (
      <Card className="rounded-2xl border border-border bg-surface shadow-e1">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-primary" />
            <CardTitle className="text-base font-semibold text-foreground">
              Application Updates
            </CardTitle>
          </div>
          <CardDescription className="text-xs text-subtle-foreground">
            Signed updates are checked by packaged desktop builds.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-xs text-subtle-foreground">
          Build the packaged application to test the GitHub Releases updater.
        </CardContent>
      </Card>
    )
  }

  const isChecking = status === "checking"
  const isPreparing = status === "preparing"
  const isDownloading = status === "downloading"
  const isInstalling = status === "installing"
  const isBusy = isChecking || isPreparing || isDownloading || isInstalling
  const downloadProgress = contentLength ? downloadedBytes / contentLength : 0

  async function handleCheck() {
    await checkForUpdate()
    const result = useUpdaterStore.getState()
    if (result.status === "up-to-date") {
      toast({
        title: "RecordForge is up to date",
        description: currentVersion
          ? `Version ${currentVersion} is the latest release.`
          : undefined,
        variant: "success",
      })
    } else if (result.status === "error") {
      toast({
        title: "Update check failed",
        description: result.errorMessage ?? "Could not check for updates.",
        variant: "error",
      })
    }
  }

  async function handleInstall() {
    await installUpdate(onBeforeInstall)
    const result = useUpdaterStore.getState()
    if (result.status === "error") {
      toast({
        title: "Update failed",
        description: result.errorMessage ?? "The update could not be installed.",
        variant: "error",
      })
    }
  }

  return (
    <Card className="rounded-2xl border border-border bg-surface shadow-e1">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-primary" />
            <div>
              <CardTitle className="text-base font-semibold text-foreground">
                Application Updates
              </CardTitle>
              <CardDescription className="text-xs text-subtle-foreground">
                Signed RecordForge releases from GitHub.
              </CardDescription>
            </div>
          </div>
          <Badge variant={status === "error" ? "warning" : "outline"} className="text-[10px]">
            {currentVersion ? `Current v${currentVersion}` : "Desktop"}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 text-xs">
        {isChecking ? (
          <div className="space-y-2" aria-label="Checking for updates">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-full max-w-md" />
          </div>
        ) : null}

        {!isChecking && status === "up-to-date" ? (
          <div className="flex items-start gap-2.5 text-subtle-foreground">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
            <div>
              <p className="font-medium text-foreground">You are up to date</p>
              <p className="mt-1">The latest signed release is installed.</p>
            </div>
          </div>
        ) : null}

        {!isChecking && status === "available" && update ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2.5">
              <Download className="mt-0.5 size-4 shrink-0 text-accent" />
              <div className="min-w-0">
                <p className="font-medium text-foreground">Version {update.version} is available</p>
                <p className="mt-1 text-subtle-foreground">
                  The installer will be verified before it changes the application.
                </p>
              </div>
            </div>
            {update.body ? (
              <div className="max-h-32 overflow-y-auto rounded-lg border border-border bg-surface-dim p-3 whitespace-pre-wrap text-subtle-foreground">
                {update.body}
              </div>
            ) : null}
          </div>
        ) : null}

        {isPreparing ? (
          <div className="space-y-2" role="status" aria-live="polite">
            <p className="font-medium text-foreground">Preparing the update</p>
            <p className="text-subtle-foreground">
              Saving editor changes and checking that native work is idle.
            </p>
            <Skeleton className="h-1.5 w-full" />
          </div>
        ) : null}

        {isDownloading ? (
          <div className="space-y-2" role="status" aria-live="polite">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium text-foreground">Downloading update</span>
              <span className="tnum text-subtle-foreground">
                {contentLength ? `${Math.round(downloadProgress * 100)}%` : "Preparing…"}
              </span>
            </div>
            <Progress value={downloadProgress} aria-label="Update download progress" />
            <p className="text-subtle-foreground">
              {formatBytes(downloadedBytes)}
              {contentLength ? ` of ${formatBytes(contentLength)}` : " downloaded"}
            </p>
          </div>
        ) : null}

        {isInstalling ? (
          <div className="flex items-start gap-2.5" role="status" aria-live="polite">
            <RefreshCw className="mt-0.5 size-4 shrink-0 animate-spin text-accent" />
            <div>
              <p className="font-medium text-foreground">Installing update</p>
              <p className="mt-1 text-subtle-foreground">
                RecordForge will close and restart when the updater finishes installing.
              </p>
            </div>
          </div>
        ) : null}

        {status === "blocked" && readiness ? (
          <div className="flex items-start gap-2.5" role="alert">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-warning" />
            <div>
              <p className="font-medium text-foreground">Update waiting for a safe moment</p>
              <ul className="mt-1 space-y-1 text-subtle-foreground">
                {readiness.blockers.map((blocker) => (
                  <li key={blocker}>{BLOCKER_MESSAGES[blocker]}</li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}

        {status === "error" ? (
          <div className="flex items-start gap-2.5" role="alert">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-recording" />
            <div>
              <p className="font-medium text-foreground">Could not complete the update</p>
              <p className="mt-1 text-subtle-foreground">{errorMessage}</p>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={status === "available" || status === "blocked" ? "primary" : "outline"}
            size="sm"
            loading={isBusy}
            disabled={isBusy}
            onClick={() =>
              void (status === "available" || status === "blocked"
                ? handleInstall()
                : handleCheck())
            }
          >
            {status === "available" || status === "blocked" ? (
              <>
                <Download className="size-3.5" />
                {status === "blocked" ? "Try update again" : "Update now"}
              </>
            ) : (
              <>
                <RefreshCw className="size-3.5" />
                Check for updates
              </>
            )}
          </Button>
          {status === "error" && update ? (
            <Button variant="outline" size="sm" onClick={() => void handleInstall()}>
              Retry update
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
