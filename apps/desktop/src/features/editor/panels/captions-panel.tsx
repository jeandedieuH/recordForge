import { Captions } from "lucide-react"
import { CaptionImportPanel } from "../captions/caption-import-panel"

export function CaptionsPanel() {
  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <div className="flex items-center gap-2 border-b border-border pb-2 text-sm font-semibold text-foreground">
        <Captions className="size-4 text-primary" aria-hidden />
        <h2>Captions</h2>
      </div>
      <p className="text-[11px] leading-relaxed text-subtle-foreground">
        Import timed cues without changing the original media. Select a caption clip in the timeline
        to edit its text, style, and placement.
      </p>
      <CaptionImportPanel />
    </div>
  )
}
