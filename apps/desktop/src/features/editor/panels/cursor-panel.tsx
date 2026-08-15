import type { CursorSettings } from "@recordforge/contracts"
import { defaultCursorSettings } from "@recordforge/contracts"
import { createUpdateCursorSettingsCommand } from "@recordforge/editor-core"
import { MousePointer2 } from "lucide-react"
import { useTimelineStore } from "../../../stores/timeline-store"
import { CursorInspector } from "../cursor"

export function CursorPanel() {
  const execute = useTimelineStore((state) => state.execute)
  const timeline = useTimelineStore((state) => state.engine?.history.present)

  const cursorSettings = timeline?.canvas.cursorSettings ?? defaultCursorSettings

  function handleCursorChange(updated: Partial<CursorSettings>) {
    execute(createUpdateCursorSettingsCommand(updated))
  }

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <div className="flex items-center gap-2 border-b border-border pb-2 text-sm font-semibold text-foreground">
        <MousePointer2 className="size-4 text-primary" aria-hidden />
        <h2>Cursor</h2>
      </div>

      <div className="rounded-lg border border-border bg-surface-dim p-2">
        <CursorInspector settings={cursorSettings} onChange={handleCursorChange} />
      </div>
    </div>
  )
}
