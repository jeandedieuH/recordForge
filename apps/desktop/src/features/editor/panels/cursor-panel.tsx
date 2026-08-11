import type { CursorEffectClip, CursorSettings } from "@recordforge/contracts"
import { defaultCursorSettings } from "@recordforge/contracts"
import { cursorRangeOverrideLabels } from "@recordforge/cursor-core"
import {
  createAddCursorRangeCommand,
  createDeleteCursorRangeCommand,
  createUpdateCursorRangeCommand,
  createUpdateCursorSettingsCommand,
  getTotalDuration,
} from "@recordforge/editor-core"
import { MousePointer2, Plus } from "lucide-react"
import { Badge, Button } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"
import { CursorInspector } from "../cursor"

export function CursorPanel() {
  const execute = useTimelineStore((state) => state.execute)
  const setSelection = useTimelineStore((state) => state.setSelection)
  const project = useTimelineStore((state) => state.project)
  const timeline = useTimelineStore((state) => state.engine?.history.present)
  const view = useTimelineStore((state) => state.view)

  const cursorSettings = timeline?.canvas.cursorSettings ?? defaultCursorSettings
  const cursorAssetId = project?.assets.find((asset) => asset.role === "cursor_events")?.id
  const selectedRange = view.selection?.kind === "range" ? view.selection : null
  const cursorTrack = timeline?.tracks.find((track) => track.kind === "cursor")
  const cursorRanges = (cursorTrack?.clips.filter((clip) => clip.kind === "cursor-effect") ??
    []) as CursorEffectClip[]

  function handleCursorChange(updated: Partial<CursorSettings>) {
    execute(createUpdateCursorSettingsCommand(updated))
  }

  function addCursorRange() {
    if (!cursorAssetId || !timeline) return
    const startMs = selectedRange?.startMs ?? 0
    const endMs = selectedRange?.endMs ?? Math.max(1, getTotalDuration(timeline))
    const rangeId = crypto.randomUUID()
    execute(
      createAddCursorRangeCommand(cursorAssetId, startMs, endMs, {
        rangeId,
        presetId: cursorSettings.preset,
        scale: cursorSettings.scale,
        settings: cursorSettings,
      }),
    )
    setSelection({
      kind: "clip",
      primaryClipId: rangeId,
      clipIds: [rangeId],
      trackId: cursorTrack?.id,
    })
  }

  function selectRange(range: CursorEffectClip) {
    setSelection({
      kind: "clip",
      primaryClipId: range.id,
      clipIds: [range.id],
      trackId: cursorTrack?.id,
    })
  }

  function toggleRangeEnabled(range: CursorEffectClip) {
    execute(createUpdateCursorRangeCommand(range.id, { enabled: !range.enabled }))
  }

  function toggleRangeLocked(range: CursorEffectClip) {
    execute(createUpdateCursorRangeCommand(range.id, { locked: !range.locked }))
  }

  function clearRangeOverrides(range: CursorEffectClip) {
    execute(
      createUpdateCursorRangeCommand(range.id, {
        presetId: cursorSettings.preset,
        scale: cursorSettings.scale,
        smoothing: cursorSettings.smoothMovement ? "smooth" : "off",
        settings: {},
        replaceSettings: true,
      }),
    )
  }

  function deleteRange(range: CursorEffectClip) {
    execute(createDeleteCursorRangeCommand(range.id))
  }

  function badgeVariant(
    variant: "default" | "secondary" | "outline" | "warning",
  ): "default" | "accent" | "outline" | "warning" {
    if (variant === "secondary") return "outline"
    if (variant === "default") return "accent"
    return variant
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

      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-foreground">Cursor ranges</span>
        <Button
          variant="secondary"
          size="sm"
          className="h-7 text-[11px]"
          disabled={!cursorAssetId}
          onClick={addCursorRange}
        >
          <Plus data-icon="inline-start" />
          Add range
        </Button>
      </div>

      {cursorRanges.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-subtle-foreground">
          {cursorAssetId
            ? "Add a cursor effect range to override the project profile for part of the timeline."
            : "No cursor telemetry is available for this recording."}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {cursorRanges.map((range) => {
            const badges = cursorRangeOverrideLabels(range, cursorSettings)
            return (
              <div
                key={range.id}
                className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-dim p-2 text-[11px]"
              >
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className="min-w-0 truncate text-left text-foreground"
                    onClick={() => selectRange(range)}
                  >
                    {formatCursorTime(range.startMs)} →{" "}
                    {formatCursorTime(range.startMs + range.durationMs)}
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1.5 text-[10px]"
                      onClick={() => toggleRangeEnabled(range)}
                    >
                      {range.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1.5 text-[10px]"
                      onClick={() => toggleRangeLocked(range)}
                    >
                      {range.locked ? "Unlock" : "Lock"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1.5 text-[10px] text-recording hover:text-recording"
                      onClick={() => deleteRange(range)}
                      disabled={range.locked}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
                {badges.length > 0 ? (
                  <>
                    <div className="flex flex-wrap gap-1">
                      {badges.map((badge) => (
                        <Badge
                          key={badge.key}
                          variant={badgeVariant(badge.variant)}
                          className="text-[10px]"
                        >
                          {badge.label}
                        </Badge>
                      ))}
                    </div>
                    {!range.locked ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-fit text-[10px]"
                        onClick={() => clearRangeOverrides(range)}
                      >
                        Clear overrides
                      </Button>
                    ) : null}
                  </>
                ) : !range.locked ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-fit text-[10px]"
                    onClick={() => selectRange(range)}
                  >
                    Edit to override profile
                  </Button>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function formatCursorTime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const remainder = Math.floor(ms % 1000)
  return `${seconds}.${remainder.toString().padStart(3, "0")}s`
}
