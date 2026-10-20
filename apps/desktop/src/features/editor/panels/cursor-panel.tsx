import type { CursorSettings } from "@recordforge/contracts"
import { defaultCursorSettings } from "@recordforge/contracts"
import { createUpdateCursorSettingsCommand } from "@recordforge/editor-core"
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
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-3">
      <CursorInspector settings={cursorSettings} onChange={handleCursorChange} />
    </div>
  )
}
