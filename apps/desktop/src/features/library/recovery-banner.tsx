import { useState } from "react"
import { AlertTriangle, CheckCircle2, Trash2 } from "lucide-react"
import { Button } from "@recordforge/ui"
import type { RecoveryScanResult } from "@recordforge/contracts"
import { deleteRecoverySession, recoverSession } from "../../lib/recorder"

interface RecoveryBannerProps {
  sessions: RecoveryScanResult[]
  onRecovered?: () => void
}

export function RecoveryBanner({ sessions, onRecovered }: RecoveryBannerProps) {
  const [items, setItems] = useState<RecoveryScanResult[]>(sessions)
  const [busySessionId, setBusySessionId] = useState<string | null>(null)

  if (items.length === 0) return null

  async function handleRecover(sessionId: string) {
    setBusySessionId(sessionId)
    try {
      await recoverSession(sessionId)
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
      await deleteRecoverySession(sessionId)
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
            <div>
              <span className="font-mono">{session.sessionId.slice(0, 8)}</span>
              <span className="ml-2 text-muted-foreground">
                ({(session.outputSizeBytes / 1024 / 1024).toFixed(1)} MB captured)
              </span>
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
                disabled={busySessionId === session.sessionId}
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
