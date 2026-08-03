import { useState } from "react"
import { Trash2, Undo2 } from "lucide-react"
import { Button } from "@recordforge/ui"
import type { LibraryRecording } from "@recordforge/contracts"
import { deleteRecording, emptyTrash, restoreRecording } from "../../lib/library"

interface TrashViewProps {
  trashedRecordings: LibraryRecording[]
  onRefresh?: () => void
}

export function TrashView({ trashedRecordings, onRefresh }: TrashViewProps) {
  const [busyId, setBusyId] = useState<string | null>(null)

  async function handleRestore(id: string) {
    setBusyId(id)
    try {
      await restoreRecording(id)
      onRefresh?.()
    } finally {
      setBusyId(null)
    }
  }

  async function handlePermanentDelete(id: string) {
    setBusyId(id)
    try {
      await deleteRecording(id)
      onRefresh?.()
    } finally {
      setBusyId(null)
    }
  }

  async function handleEmptyTrash() {
    try {
      await emptyTrash()
      onRefresh?.()
    } catch (err) {
      console.error("Failed to empty trash:", err)
    }
  }

  if (trashedRecordings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center text-muted-foreground">
        <Trash2 className="mb-2 h-8 w-8 opacity-40" />
        <p className="font-medium">Trash is Empty</p>
        <p className="text-xs">
          Deleted recordings will appear here before being permanently removed.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">
          Trash ({trashedRecordings.length} item{trashedRecordings.length === 1 ? "" : "s"})
        </h3>
        <Button size="sm" variant="destructive" onClick={handleEmptyTrash}>
          <Trash2 className="mr-1 h-3.5 w-3.5" />
          Empty Trash
        </Button>
      </div>

      <div className="divide-y rounded-lg border border-border/50 bg-card">
        {trashedRecordings.map((rec) => (
          <div key={rec.id} className="flex items-center justify-between p-3 text-xs">
            <div>
              <p className="font-medium text-foreground">{rec.name}</p>
              <p className="text-muted-foreground">
                {(rec.sizeBytes / 1024 / 1024).toFixed(1)} MB • {rec.width}x{rec.height}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busyId === rec.id}
                onClick={() => handleRestore(rec.id)}
              >
                <Undo2 className="mr-1 h-3 w-3" />
                Restore
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={busyId === rec.id}
                onClick={() => handlePermanentDelete(rec.id)}
              >
                Delete Permanently
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
