import type { MaskClip, MaskMode } from "@recordforge/contracts"
import {
  createAddMaskClipCommand,
  createDeleteClipCommand,
  createUpdateMaskClipCommand,
} from "@recordforge/editor-core"
import { EyeOff, ShieldAlert } from "lucide-react"
import { Button, Switch } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"

const MASK_MODES: { value: MaskMode; label: string }[] = [
  { value: "blur", label: "Blur" },
  { value: "pixelate", label: "Pixelate" },
  { value: "redact", label: "Redact" },
]

export function PrivacyPanel() {
  const execute = useTimelineStore((state) => state.execute)
  const timeline = useTimelineStore((state) => state.engine?.history.present)
  const view = useTimelineStore((state) => state.view)

  const masks =
    timeline?.tracks.flatMap((track) =>
      track.clips.filter((clip): clip is MaskClip => clip.kind === "mask"),
    ) ?? []

  const screenAssetId = timeline?.tracks
    .find((track) => track.kind === "screen")
    ?.clips.find((clip) => clip.kind === "screen")?.assetId

  function addMask(mode: MaskMode) {
    if (!timeline || !screenAssetId) return
    const startMs = Math.round(view.playheadMs)
    const endMs = Math.min(view.durationMs, view.playheadMs + 2_000)
    if (endMs <= startMs) return
    execute(
      createAddMaskClipCommand(screenAssetId, startMs, endMs, mode, {
        x: timeline.canvas.width * 0.3,
        y: timeline.canvas.height * 0.3,
        width: timeline.canvas.width * 0.4,
        height: timeline.canvas.height * 0.25,
      }),
    )
  }

  function toggleEnabled(mask: MaskClip) {
    execute(createUpdateMaskClipCommand(mask.id, { enabled: !mask.enabled }))
  }

  function deleteMask(mask: MaskClip) {
    execute(createDeleteClipCommand(mask.id))
  }

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <div className="flex items-center gap-2 border-b border-border pb-2 text-sm font-semibold text-foreground">
        <EyeOff className="size-4 text-primary" aria-hidden />
        <h2>Privacy</h2>
      </div>

      <p className="text-[11px] leading-relaxed text-subtle-foreground">
        Add masks to hide sensitive areas. Masks are non-destructive and can be moved and resized in
        the preview or timeline.
      </p>

      <div className="flex gap-2">
        {MASK_MODES.map((mode) => (
          <Button
            key={mode.value}
            variant="secondary"
            size="sm"
            className="h-7 text-[11px]"
            disabled={!screenAssetId}
            onClick={() => addMask(mode.value)}
          >
            {mode.label}
          </Button>
        ))}
      </div>

      {masks.length === 0 ? (
        <div className="mt-2 flex items-center gap-2 rounded-md border border-dashed border-border bg-surface-dim p-3 text-[11px] text-subtle-foreground">
          <ShieldAlert className="size-4" aria-hidden />
          <span>No masks. Add one to protect sensitive content.</span>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {masks.map((mask) => (
            <div
              key={mask.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface-dim p-2 text-[11px]"
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate font-medium text-foreground">{mask.mode} mask</span>
                <span className="font-mono text-[10px] text-subtle-foreground">
                  {Math.round(mask.rect.x)}, {Math.round(mask.rect.y)} ·{" "}
                  {Math.round(mask.rect.width)}×{Math.round(mask.rect.height)}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Switch
                  aria-label={`Toggle ${mask.mode} mask`}
                  checked={mask.enabled}
                  onCheckedChange={() => toggleEnabled(mask)}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[10px] text-recording hover:text-recording"
                  onClick={() => deleteMask(mask)}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
