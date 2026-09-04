import { useState } from "react"
import { Button, NumberInputField } from "@recordforge/ui"
import type { LibraryRecording } from "@recordforge/contracts"

interface MediaPrepareDialogProps {
  recording: LibraryRecording | null
  onClose: () => void
  onPrepare: (
    recording: LibraryRecording,
    options: { force: boolean; thumbnailIntervalSec: number },
  ) => void
  onCleanup: (recordingId: string) => void
}

export function MediaPrepareDialog({
  recording,
  onClose,
  onPrepare,
  onCleanup,
}: MediaPrepareDialogProps) {
  const [force, setForce] = useState(false)
  const [thumbnailIntervalSec, setThumbnailIntervalSec] = useState(5)
  const [isCleaning, setIsCleaning] = useState(false)

  if (!recording) return null

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!recording) return
    onPrepare(recording, {
      force,
      thumbnailIntervalSec: Math.max(1, thumbnailIntervalSec),
    })
    onClose()
  }

  async function handleCleanup() {
    if (!recording) return
    setIsCleaning(true)
    try {
      await onCleanup(recording.id)
    } finally {
      setIsCleaning(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg">
        <h3 className="mb-4 text-lg font-semibold">Prepare {recording.name}</h3>

        <form onSubmit={handleSubmit} className="space-y-4">
          <NumberInputField
            id="thumbnail-interval"
            label="Thumbnail interval"
            unit="s"
            min={1}
            value={thumbnailIntervalSec}
            onChange={(val) => setThumbnailIntervalSec(val || 1)}
          />

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={force}
              onChange={(e) => setForce(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            Force rebuild (delete existing derivatives first)
          </label>

          <div className="flex flex-col gap-2 pt-2 sm:flex-row">
            <Button type="submit" className="flex-1">
              Prepare
            </Button>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" variant="ghost" disabled={isCleaning} onClick={handleCleanup}>
              {isCleaning ? "Cleaning..." : "Delete derivatives"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
