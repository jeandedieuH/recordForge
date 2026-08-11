import {
  Activity,
  AlertCircle,
  CheckCircle2,
  HardDrive,
  HeartPulse,
  ShieldAlert,
} from "lucide-react"
import { Badge, Button, Popover, PopoverContent, PopoverTrigger } from "@recordforge/ui"
import { useEffect } from "react"
import { useRecorderStore } from "../../../stores/recorder-store"
import { isTauri } from "../../../lib/settings"
import { useTimelineStore } from "../../../stores/timeline-store"
import { useEditorStore } from "../../../stores/editor-store"

export function HealthPopover() {
  const recovery = useRecorderStore((state) => state.recovery)
  const diagnostics = useRecorderStore((state) => state.diagnostics)
  const loadRecovery = useRecorderStore((state) => state.loadRecovery)
  const loadDiagnostics = useRecorderStore((state) => state.loadDiagnostics)

  const missingAssets = useTimelineStore((state) => state.missingAssets)
  const activeJob = useTimelineStore((state) => state.activeJob)
  const saveError = useEditorStore((state) => state.saveError)
  const saveStatus = useEditorStore((state) => state.saveStatus)

  // Load recovery and diagnostics once when the popover first mounts so the
  // badge can reflect actionable issues without waiting for a manual refresh.
  useEffect(() => {
    if (!isTauri()) return
    void Promise.all([loadRecovery(), loadDiagnostics()])
  }, [loadRecovery, loadDiagnostics])

  const recoverableCount = recovery.filter((session) => session.isRecoverable).length
  const hasDiagnostics = diagnostics !== null
  const isJobFailed = activeJob?.status === "failed"
  const hasIssue =
    recoverableCount > 0 ||
    missingAssets.length > 0 ||
    saveStatus === "error" ||
    isJobFailed ||
    !hasDiagnostics

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 px-2"
          aria-label="Open health status"
        >
          {hasIssue ? (
            <>
              <ShieldAlert className="size-4 text-warning" aria-hidden />
              <span className="hidden text-warning sm:inline">Health</span>
            </>
          ) : (
            <>
              <CheckCircle2 className="size-4 text-success" aria-hidden />
              <span className="hidden text-subtle-foreground sm:inline">Healthy</span>
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-80 space-y-3 rounded-lg border border-border bg-elevated p-3 text-xs text-foreground shadow-e2"
        align="end"
      >
        <div className="flex items-center justify-between border-b border-border pb-2">
          <span className="font-semibold">Editor health</span>
          {hasIssue ? (
            <Badge variant="warning">Action needed</Badge>
          ) : (
            <Badge variant="success">All clear</Badge>
          )}
        </div>

        <HealthSection
          icon={HeartPulse}
          title="Recovery sessions"
          status={
            recoverableCount > 0
              ? `${recoverableCount} recoverable`
              : recovery.length > 0
                ? `${recovery.length} checked`
                : "None found"
          }
          isWarning={recoverableCount > 0}
        >
          {recovery.length === 0 ? (
            <p className="text-subtle-foreground">No recovery sessions on this device.</p>
          ) : (
            <ul className="max-h-24 overflow-y-auto space-y-1">
              {recovery.map((session) => (
                <li
                  key={session.sessionId}
                  className={`flex items-center justify-between ${
                    session.isRecoverable ? "text-warning" : "text-subtle-foreground"
                  }`}
                >
                  <span className="truncate">{session.sessionId}</span>
                  {session.isRecoverable ? <Badge variant="warning">Recover</Badge> : null}
                </li>
              ))}
            </ul>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 h-6 text-[10px]"
            onClick={() => void loadRecovery()}
          >
            Refresh recovery
          </Button>
        </HealthSection>

        <HealthSection
          icon={Activity}
          title="Diagnostics"
          status={hasDiagnostics ? "Ready" : "Pending"}
          isWarning={!hasDiagnostics}
        >
          {diagnostics ? (
            <ul className="space-y-1 text-subtle-foreground">
              <li>FFmpeg {diagnostics.platform.ffmpegVersion}</li>
              <li>OS {diagnostics.platform.os}</li>
              {diagnostics.platform.cpu ? <li>CPU {diagnostics.platform.cpu}</li> : null}
            </ul>
          ) : (
            <p className="text-subtle-foreground">Diagnostics have not finished loading yet.</p>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 h-6 text-[10px]"
            onClick={() => void loadDiagnostics()}
          >
            Refresh diagnostics
          </Button>
        </HealthSection>

        <HealthSection
          icon={HardDrive}
          title="Missing assets"
          status={missingAssets.length > 0 ? `${missingAssets.length} missing` : "None"}
          isWarning={missingAssets.length > 0}
        >
          {missingAssets.length === 0 ? (
            <p className="text-subtle-foreground">All project assets are linked.</p>
          ) : (
            <ul className="max-h-24 overflow-y-auto space-y-1 text-subtle-foreground">
              {missingAssets.map((assetId) => (
                <li key={assetId} className="truncate">
                  {assetId}
                </li>
              ))}
            </ul>
          )}
        </HealthSection>

        {activeJob ? (
          <HealthSection
            icon={AlertCircle}
            title="Background job"
            status={`${activeJob.kind} · ${activeJob.status}`}
            isWarning={activeJob.status === "failed"}
          >
            <p className="text-subtle-foreground">
              {activeJob.status === "running"
                ? `Progress ${Math.round((activeJob.progress ?? 0) * 100)}%`
                : (activeJob.message ?? "No additional details")}
            </p>
          </HealthSection>
        ) : null}

        {saveError ? (
          <div
            className="rounded border border-recording/30 bg-recording/10 p-2 text-[11px] text-recording"
            role="status"
          >
            <span className="font-semibold">Save failed:</span> {saveError}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

interface HealthSectionProps {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>
  title: string
  status: string
  isWarning?: boolean
  children?: React.ReactNode
}

function HealthSection({ icon: Icon, title, status, isWarning, children }: HealthSectionProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="size-3.5 text-subtle-foreground" aria-hidden />
          <span className="font-medium">{title}</span>
        </div>
        <span className={isWarning ? "text-warning" : "text-subtle-foreground"}>{status}</span>
      </div>
      {children ? <div className="pl-5">{children}</div> : null}
    </div>
  )
}
