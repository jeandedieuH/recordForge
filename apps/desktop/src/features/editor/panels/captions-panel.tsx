import { useMemo, useState } from "react"
import { Captions as CaptionsIcon, Plus, TriangleAlert, Trash2 } from "lucide-react"
import type { CaptionPlacement, CaptionStylePreset } from "@recordforge/contracts"
import { getTotalDuration } from "@recordforge/domain"
import {
  createAddCaptionClipCommand,
  createDeleteTrackCommand,
  createUpdateCaptionTrackCommand,
} from "@recordforge/editor-core"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  EmptyState,
  IconButton,
  ToggleGroup,
  ToggleGroupItem,
  useToast,
} from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"
import { CaptionCueList } from "../captions/caption-cue-list"
import { CaptionImportPanel } from "../captions/caption-import-panel"
import { CaptionStylePicker } from "../captions/caption-style-picker"
import { CAPTION_PLACEMENT_OPTIONS } from "../captions/caption-styles"

export function CaptionsPanel() {
  const execute = useTimelineStore((state) => state.execute)
  const playheadMs = useTimelineStore((state) => state.view.playheadMs)
  const isPlaying = useTimelineStore((state) => state.view.isPlaying)
  const setSelection = useTimelineStore((state) => state.setSelection)
  const captionTrack = useTimelineStore((state) =>
    state.engine?.history.present.tracks.find((track) => track.kind === "captions"),
  )
  const screenDurationMs = useTimelineStore((state) =>
    state.engine ? getTotalDuration(state.engine.history.present) : state.view.durationMs,
  )
  const { toast } = useToast()

  // Shared defaults for every new cue — imported or added at the playhead —
  // and the source for "apply to all".
  const [style, setStyle] = useState<CaptionStylePreset>("default")
  const [placement, setPlacement] = useState<CaptionPlacement>("bottom")
  const [confirmRemoveAll, setConfirmRemoveAll] = useState(false)

  const cueCount = useMemo(
    () => captionTrack?.clips.filter((clip) => clip.kind === "caption").length ?? 0,
    [captionTrack],
  )
  const beyondEndCount = useMemo(
    () =>
      captionTrack?.clips.filter(
        (clip) => clip.kind === "caption" && clip.startMs >= screenDurationMs,
      ).length ?? 0,
    [captionTrack, screenDurationMs],
  )

  function addCaptionAtPlayhead() {
    const clipId = crypto.randomUUID()
    const applied = execute(
      createAddCaptionClipCommand("New caption", playheadMs, 2_000, {
        clipId,
        style,
        placement,
      }),
    )
    if (!applied) {
      toast({
        title: "Caption could not be added",
        description: "Another caption already covers the playhead — move it or pick a free spot.",
        variant: "error",
      })
      return
    }
    setSelection({ kind: "clip", primaryClipId: clipId, clipIds: [clipId] })
  }

  function applyLookToAll() {
    if (!captionTrack) return
    const applied = execute(createUpdateCaptionTrackCommand(captionTrack.id, { style, placement }))
    toast(
      applied
        ? {
            title: "Caption style updated",
            description: `Applied to ${cueCount} caption${cueCount === 1 ? "" : "s"}.`,
            variant: "success",
          }
        : {
            title: "Style could not be applied",
            description: "Unlock the captions track, then try again.",
            variant: "error",
          },
    )
  }

  function removeAllCaptions() {
    if (!captionTrack) return
    const applied = execute(createDeleteTrackCommand(captionTrack.id))
    setConfirmRemoveAll(false)
    if (!applied) {
      toast({
        title: "Captions could not be removed",
        description: "Unlock the captions track, then try again.",
        variant: "error",
      })
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-2 px-4 py-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">Captions</h2>
          <p className="text-xs text-muted-foreground">Import, edit, and style spoken text.</p>
        </div>
        <div className="flex items-center gap-1">
          {cueCount > 0 ? <Badge>{cueCount}</Badge> : null}
          {cueCount > 0 ? (
            <IconButton
              label="Remove all captions"
              className="text-destructive hover:text-destructive"
              onClick={() => setConfirmRemoveAll(true)}
            >
              <Trash2 className="size-4" aria-hidden />
            </IconButton>
          ) : null}
        </div>
      </header>

      {cueCount > 0 && captionTrack ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-2">
          {beyondEndCount > 0 ? (
            <p className="flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11px] text-warning">
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
              {beyondEndCount} caption{beyondEndCount === 1 ? "" : "s"} start
              {beyondEndCount === 1 ? "s" : ""} after the video ends and won&apos;t export.
            </p>
          ) : null}
          <CaptionCueList
            track={captionTrack}
            playheadMs={playheadMs}
            isPlaying={isPlaying}
            screenDurationMs={screenDurationMs}
          />
        </div>
      ) : (
        <div className="flex-1 px-3">
          <EmptyState
            icon={CaptionsIcon}
            title="No captions yet"
            description="Drop an SRT or VTT file below, or add a caption at the playhead."
            className="h-full justify-center py-6"
          />
        </div>
      )}

      <footer className="flex flex-col gap-3 border-t border-border px-4 py-3">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-foreground">Caption look</span>
            {cueCount > 0 ? (
              <button
                type="button"
                onClick={applyLookToAll}
                className="text-[11px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              >
                Apply to all cues
              </button>
            ) : null}
          </div>
          <CaptionStylePicker value={style} onChange={setStyle} />
          <ToggleGroup
            type="single"
            value={placement}
            onValueChange={(value) => {
              if (value) setPlacement(value as CaptionPlacement)
            }}
            className="flex w-full rounded-md border border-border"
            aria-label="Caption placement"
          >
            {CAPTION_PLACEMENT_OPTIONS.map((option) => (
              <ToggleGroupItem key={option.value} value={option.value} className="flex-1 text-xs">
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        <Button
          variant="secondary"
          size="sm"
          className="w-full"
          onClick={addCaptionAtPlayhead}
        >
          <Plus className="size-4" aria-hidden />
          Add caption at playhead
        </Button>

        <CaptionImportPanel style={style} placement={placement} />
      </footer>

      <AlertDialog open={confirmRemoveAll} onOpenChange={setConfirmRemoveAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove all captions?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the captions track and all {cueCount} caption
              {cueCount === 1 ? "" : "s"}. You can undo this action.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={removeAllCaptions}>Remove captions</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
