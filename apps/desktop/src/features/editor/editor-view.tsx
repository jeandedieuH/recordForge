import { TimelineView } from "./timeline"

interface EditorViewProps {
  recordingId: string
  onClose: () => void
}

// Dedicated editor view for a prepared recording.
// The timeline view owns the preview, playback, and editing surface.
export function EditorView({ recordingId, onClose }: EditorViewProps) {
  return <TimelineView recordingId={recordingId} onClose={onClose} />
}
