import { TimelineView } from "./timeline"

interface EditorViewProps {
  recordingId: string
  onClose: () => void
  onOpenExport?: () => void
}

export function EditorView({ recordingId, onClose, onOpenExport }: EditorViewProps) {
  return <TimelineView recordingId={recordingId} onClose={onClose} onOpenExport={onOpenExport} />
}
