import type { CursorEffectClip, CursorSettings } from "@recordforge/contracts"
import { cursorSettingsForEffect } from "@recordforge/cursor-core"
import {
  createDeleteCursorRangeCommand,
  createUpdateCursorRangeCommand,
} from "@recordforge/editor-core"
import { MousePointer2 } from "lucide-react"
import { Button } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"
import { CursorInspector } from "../cursor"

interface CursorRangeInspectorProps {
  range: CursorEffectClip
  onClear: () => void
}

export function CursorRangeInspector({ range, onClear }: CursorRangeInspectorProps) {
  const execute = useTimelineStore((state) => state.execute)
  const timeline = useTimelineStore((state) => state.engine?.history.present)
  const baseSettings = timeline?.canvas.cursorSettings
  const rangeSettings = cursorSettingsForEffect(baseSettings, range)

  function handleChange(updated: Partial<CursorSettings>) {
    execute(
      createUpdateCursorRangeCommand(range.id, {
        enabled: updated.enabled,
        presetId: updated.preset,
        scale: updated.scale,
        smoothing:
          updated.smoothMovement === undefined
            ? undefined
            : updated.smoothMovement
              ? "smooth"
              : "off",
        settings: updated,
      }),
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between border-b border-border pb-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <MousePointer2 className="size-4 text-primary" aria-hidden />
          <span>Cursor range</span>
        </div>
        <Button variant="ghost" size="sm" onClick={onClear} className="h-7 text-xs">
          Clear
        </Button>
      </div>

      <CursorInspector settings={rangeSettings} onChange={handleChange} />

      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            execute(
              createUpdateCursorRangeCommand(range.id, {
                locked: !range.locked,
              }),
            )
          }
        >
          {range.locked ? "Unlock range" : "Lock range"}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={range.locked}
          onClick={() => {
            execute(createDeleteCursorRangeCommand(range.id))
            onClear()
          }}
        >
          Delete range
        </Button>
      </div>
    </div>
  )
}
