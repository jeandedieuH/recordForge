import { useEffect, useState } from "react"
import { AlertTriangle, CheckCircle2, Trash2 } from "lucide-react"
import { Button } from "@recordforge/ui"
import type { RecoveryScanResult } from "@recordforge/contracts"
import { useRecorderStore } from "../../stores/recorder-store"

interface RecoveryBannerProps {
  sessions: RecoveryScanResult[]
  onRecovered?: () => void
}

export function RecoveryBanner({ sessions, onRecovered }: RecoveryBannerProps) {
  const [items, setItems] = useState<RecoveryScanResult[]>(sessions)
  const [busySessionId, setBusySessionId] = useState<string | null>(null)
  const recover = useRecorderStore((state) => state.recover)
  const deleteRecovery = useRecorderStore((state) => state.deleteRecovery)

  useEffect(() => {
    setItems(sessions)
  }, [sessions])

  if (items.length === 0) return null

  async function handleRecover(sessionId: string) {
    setBusySessionId(sessionId)
    try {
      await recover(sessionId)
      setItems((prev) => prev.filter((s) => s.sessionId !== sessionId))
      onRecovered?.()
    } catch (err) {
      console.error("Failed to recover session:", err)
    } finally {
      setBusySessionId(null)
    }
  }

  async function handleDiscard(sessionId: string) {
    setBusySessionId(sessionId)
    try {
      await deleteRecovery(sessionId)
      setItems((prev) => prev.filter((s) => s.sessionId !== sessionId))
    } catch (err) {
      console.error("Failed to discard recovery session:", err)
    } finally {
      setBusySessionId(null)
    }
  }

  return (
    <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-amber-900 dark:text-amber-200">
      <div className="flex items-center gap-2 font-medium">
        <AlertTriangle className="h-5 w-5 text-amber-500" />
        <span>Unfinished Recording Session Detected</span>
      </div>
      <p className="mt-1 text-xs text-amber-800/80 dark:text-amber-300/80">
        recordForge detected {items.length} recording session{items.length > 1 ? "s" : ""}{" "}
        interrupted by a force-quit or power loss.
      </p>

      <div className="mt-3 flex flex-col gap-2">
        {items.map((session) => (
          <div
            key={session.sessionId}
            className="flex items-center justify-between rounded bg-background/50 p-2 text-xs"
          >
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span className="font-mono">{session.sessionId.slice(0, 8)}</span>
                <span className="text-muted-foreground">
                  {session.isRecoverable
                    ? `(${(session.outputSizeBytes / 1024 / 1024).toFixed(1)} MB captured)`
                    : "(Incomplete / 0 MB valid data)"}
                </span>
                {!session.isRecoverable && (
                  <span className="rounded bg-destructive/15 px-1.5 py-0.2 text-[10px] font-medium text-destructive">
                    Corrupt / Unrecoverable
                  </span>
                )}
              </div>
              {session.validationError && !session.isRecoverable ? (
                <span className="text-[11px] text-muted-foreground">
                  {session.validationError}
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busySessionId === session.sessionId}
                onClick={() => handleDiscard(session.sessionId)}
              >
                <Trash2 className="mr-1 h-3 w-3" />
                Discard
              </Button>
              <Button
                size="sm"
                disabled={busySessionId === session.sessionId || !session.isRecoverable}
                title={!session.isRecoverable ? "No valid video fragments to recover" : undefined}
                onClick={() => handleRecover(session.sessionId)}
              >
                <CheckCircle2 className="mr-1 h-3 w-3" />
                Recover Video
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
