import { defaultCursorSettings } from "@recordforge/contracts"
import type { CursorEffectClip, CursorSettings, CursorSmoothing } from "@recordforge/contracts"
import { cursorRangeOverrideLabels, cursorSettingsForEffect } from "@recordforge/cursor-core"
import {
  createDeleteCursorRangeCommand,
  createUpdateCursorRangeCommand,
} from "@recordforge/editor-core"
import { MousePointer2 } from "lucide-react"
import { Badge, Button } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"
import { CursorInspector } from "../cursor"

interface CursorRangeInspectorProps {
  range: CursorEffectClip
  onClear: () => void
}

function baseSmoothing(settings: CursorSettings | undefined): CursorSmoothing {
  return settings?.smoothMovement ? "smooth" : "off"
}

function badgeVariant(
  variant: "default" | "secondary" | "outline" | "warning",
): "default" | "accent" | "outline" | "warning" {
  if (variant === "secondary") return "outline"
  if (variant === "default") return "accent"
  return variant
}

export function CursorRangeInspector({ range, onClear }: CursorRangeInspectorProps) {
  const execute = useTimelineStore((state) => state.execute)
  const timeline = useTimelineStore((state) => state.engine?.history.present)
  const baseSettings = timeline?.canvas.cursorSettings ?? defaultCursorSettings
  const rangeSettings = cursorSettingsForEffect(baseSettings, range)
  const badges = cursorRangeOverrideLabels(range, baseSettings)

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

  function clearOverrides() {
    execute(
      createUpdateCursorRangeCommand(range.id, {
        presetId: baseSettings.preset,
        scale: baseSettings.scale,
        smoothing: baseSmoothing(baseSettings),
        settings: {},
        replaceSettings: true,
      }),
    )
  }

  const hasOverrides =
    Object.keys(range.settings ?? {}).length > 0 ||
    range.presetId !== baseSettings.preset ||
    range.scale !== baseSettings.scale ||
    range.smoothing !== baseSmoothing(baseSettings)

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

      {badges.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {badges.map((badge) => (
            <Badge key={badge.key} variant={badgeVariant(badge.variant)} className="text-[10px]">
              {badge.label}
            </Badge>
          ))}
        </div>
      ) : null}

      {hasOverrides ? (
        <p className="rounded-md border border-primary/30 bg-primary/10 px-2 py-1.5 text-[10px] text-primary">
          This range overrides the project cursor profile. Fields that are not set inherit from the
          project default.
        </p>
      ) : (
        <p className="rounded-md border border-border bg-surface px-2 py-1.5 text-[10px] text-muted-foreground">
          This range uses the project cursor profile. Change a setting to create an override.
        </p>
      )}

      <CursorInspector
        settings={rangeSettings}
        onChange={handleChange}
        onReset={clearOverrides}
        resetLabel="Clear overrides"
      />

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
