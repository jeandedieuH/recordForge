import { EditorShell } from "./editor-shell"

interface EditorViewProps {
  recordingId: string
  onClose: () => void
  onOpenExport?: () => void
}

export function EditorView({ recordingId, onClose, onOpenExport }: EditorViewProps) {
  return <EditorShell recordingId={recordingId} onClose={onClose} onOpenExport={onOpenExport} />
}
