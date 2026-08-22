import { useEffect } from "react"
import { Cloud, HardDrive, RefreshCw, Server, ShieldCheck, Database } from "lucide-react"
import { Button, Card } from "@recordforge/ui"
import { useStorageStore } from "../storage-store"
import { StorageProfilesManager } from "./storage-profiles-manager"
import { UploadJobsPanel } from "./upload-jobs-panel"

interface StorageViewProps {
  onNavigateToSettings?: () => void
}

export function StorageView({}: StorageViewProps) {
  const { profiles, jobs, fetchProfiles, fetchJobs, initListeners } = useStorageStore()

  useEffect(() => {
    fetchProfiles()
    fetchJobs()
    const unsubscribe = initListeners()
    return () => {
      unsubscribe()
    }
  }, [fetchProfiles, fetchJobs, initListeners])

  const s3Profiles = profiles.filter((p) => p.kind === "s3")
  const driveProfiles = profiles.filter((p) => p.kind === "gdrive")

  const activeJobs = jobs.filter((j) => j.state === "pending" || j.state === "uploading")
  const completedJobs = jobs.filter((j) => j.state === "completed")

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto w-full">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-serif text-2xl font-bold tracking-tight text-foreground">
            Storage &amp; Cloud Hub
          </h2>
          <p className="text-xs text-subtle-foreground mt-0.5">
            Monitor local disk space, configure S3 &amp; Google Drive destinations, and track video
            upload transfers.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              fetchProfiles()
              fetchJobs()
            }}
            className="h-8 text-xs gap-1.5"
          >
            <RefreshCw className="size-3.5" />
            Refresh Status
          </Button>
        </div>
      </div>

      {/* Overview Stat Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Local Disk Quota Card */}
        <Card className="p-4 bg-surface border-border flex flex-col justify-between space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="size-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                <HardDrive className="size-4" />
              </div>
              <div>
                <h4 className="text-xs font-semibold text-foreground">Local Recording Storage</h4>
                <p className="text-[11px] text-subtle-foreground">Primary output volume</p>
              </div>
            </div>
            <span className="text-[11px] font-mono font-medium text-foreground">Local First</span>
          </div>

          <div className="space-y-1.5">
            <div className="flex justify-between text-[11px] text-subtle-foreground">
              <span>Saved Recordings</span>
              <span className="font-mono text-foreground font-medium">Automatic WAL Safety</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-surface-dim border border-border">
              <div className="h-full w-[15%] rounded-full bg-primary" />
            </div>
          </div>
        </Card>

        {/* Cloud Destinations Card */}
        <Card className="p-4 bg-surface border-border flex flex-col justify-between space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="size-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                <Cloud className="size-4" />
              </div>
              <div>
                <h4 className="text-xs font-semibold text-foreground">Cloud Destinations</h4>
                <p className="text-[11px] text-subtle-foreground">
                  {profiles.length} configured endpoint{profiles.length === 1 ? "" : "s"}
                </p>
              </div>
            </div>
            <span className="text-[11px] font-mono font-semibold text-primary">
              {profiles.length > 0 ? "Active" : "None"}
            </span>
          </div>

          <div className="flex items-center gap-2 text-[11px] text-subtle-foreground">
            <span className="inline-flex items-center gap-1">
              <Server className="size-3 text-track-screen" />
              {s3Profiles.length} S3
            </span>
            <span>•</span>
            <span className="inline-flex items-center gap-1">
              <Cloud className="size-3 text-track-mic" />
              {driveProfiles.length} Google Drive
            </span>
            <span>•</span>
            <span className="inline-flex items-center gap-1">
              <ShieldCheck className="size-3 text-success" />
              Vault Protected
            </span>
          </div>
        </Card>

        {/* Uploads & Transfers Card */}
        <Card className="p-4 bg-surface border-border flex flex-col justify-between space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="size-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                <Database className="size-4" />
              </div>
              <div>
                <h4 className="text-xs font-semibold text-foreground">Background Transfers</h4>
                <p className="text-[11px] text-subtle-foreground">
                  {activeJobs.length} active, {completedJobs.length} completed
                </p>
              </div>
            </div>
            <span className="text-[11px] font-mono font-medium text-foreground">
              {activeJobs.length > 0 ? `${activeJobs.length} in progress` : "Idle"}
            </span>
          </div>

          <div className="flex items-center justify-between text-[11px] text-subtle-foreground">
            <span>Transfer History</span>
            <span className="font-mono text-foreground font-medium">
              {jobs.length} total transfers
            </span>
          </div>
        </Card>
      </div>

      {/* Main Storage Management Section */}
      <div className="space-y-8">
        <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
          <StorageProfilesManager />
        </div>

        <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
          <UploadJobsPanel />
        </div>
      </div>
    </div>
  )
}
