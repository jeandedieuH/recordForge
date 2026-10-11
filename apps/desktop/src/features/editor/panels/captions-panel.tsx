import { useMemo, useState } from "react"
import {
  Captions as CaptionsIcon,
  MoveHorizontal,
  Plus,
  RefreshCw,
  Replace,
  TriangleAlert,
  Trash2,
} from "lucide-react"
import { getTotalDuration } from "@recordforge/domain"
import { DEFAULT_CAPTION_DESIGN } from "@recordforge/contracts"
import {
  analyzeCaptionSync,
  countCaptionTextMatches,
  createAddCaptionClipCommand,
  createDeleteTrackCommand,
  createReplaceCaptionTextCommand,
  createResyncCaptionsCommand,
  createShiftCaptionsCommand,
  resolveCaptionDesign,
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
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Switch,
  useToast,
} from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"
import { CaptionCueList } from "../captions/caption-cue-list"
import { CaptionImportPanel } from "../captions/caption-import-panel"
import { AiCaptionsCard } from "../captions/ai-captions-card"
import { CaptionDesignControls } from "../captions/caption-design-controls"

// Shift-popover quick deltas (ms) — one row earlier, one row later.
const SHIFT_DELTAS = [-100, -1_000, 100, 1_000]
const FALLBACK_CANVAS = { width: 1920, height: 1080 }

function shiftDeltaLabel(deltaMs: number): string {
  const abs = Math.abs(deltaMs)
  const amount = abs >= 1_000 ? `${abs / 1_000}s` : `${abs}ms`
  return deltaMs < 0 ? `−${amount}` : `+${amount}`
}

export function CaptionsPanel() {
  const execute = useTimelineStore((state) => state.execute)
  const playheadMs = useTimelineStore((state) => state.view.playheadMs)
  const isPlaying = useTimelineStore((state) => state.view.isPlaying)
  const setSelection = useTimelineStore((state) => state.setSelection)
  const captionTrack = useTimelineStore((state) =>
    state.engine?.history.present.tracks.find((track) => track.kind === "captions"),
  )
  const timelineCanvas = useTimelineStore((state) => state.engine?.history.present.canvas)
  const screenDurationMs = useTimelineStore((state) =>
    state.engine ? getTotalDuration(state.engine.history.present) : state.view.durationMs,
  )
  const { toast } = useToast()

  const [confirmRemoveAll, setConfirmRemoveAll] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [find, setFind] = useState("")
  const [replace, setReplace] = useState("")
  const [matchCase, setMatchCase] = useState(false)
  const [replaceHint, setReplaceHint] = useState<string | null>(null)
  const [shiftOpen, setShiftOpen] = useState(false)

  const timeline = useTimelineStore((state) => state.engine?.history.present)

  const cueCount = useMemo(
    () => captionTrack?.clips.filter((clip) => clip.kind === "caption").length ?? 0,
    [captionTrack],
  )
  // Cheap staleness signal — replays each AI cue's container-time provenance
  // through the current audio coverage; memoized on the timeline.
  const syncReport = useMemo(
    () =>
      timeline && captionTrack
        ? analyzeCaptionSync(timeline, captionTrack)
        : { total: 0, displaced: 0, dropped: 0 },
    [timeline, captionTrack],
  )
  const staleCount = syncReport.displaced + syncReport.dropped
  const resyncDisabled = !captionTrack || captionTrack.locked || staleCount === 0
  const resyncHint = captionTrack?.locked
    ? "Unlock the captions track to resync"
    : staleCount === 0
      ? syncReport.total > 0
        ? "AI captions already match the edited audio"
        : "No AI-generated captions to resync"
      : "Re-align AI captions with the edited audio"
  const beyondEndCount = useMemo(
    () =>
      captionTrack?.clips.filter(
        (clip) => clip.kind === "caption" && clip.startMs >= screenDurationMs,
      ).length ?? 0,
    [captionTrack, screenDurationMs],
  )
  const captionDesign = useMemo(
    () => (captionTrack ? resolveCaptionDesign(captionTrack) : DEFAULT_CAPTION_DESIGN),
    [captionTrack],
  )
  // Live match counter — mirrors the command's literal-substring, fold-unless-
  // matchCase rule via the exported engine helper.
  const matchInfo = useMemo(
    () =>
      captionTrack
        ? countCaptionTextMatches(captionTrack.clips, {
            find,
            matchCase,
            wholeWord: false,
          })
        : { matches: 0, cues: 0 },
    [captionTrack, find, matchCase],
  )

  function addCaptionAtPlayhead() {
    const clipId = crypto.randomUUID()
    // New cues inherit the track design — no per-clip overrides on creation.
    const applied = execute(
      createAddCaptionClipCommand("New caption", playheadMs, 2_000, { clipId }),
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

  function replaceAll() {
    if (!captionTrack || !find) return
    const applied = execute(
      createReplaceCaptionTextCommand({
        trackId: captionTrack.id,
        find,
        replace,
        matchCase,
      }),
    )
    if (!applied) {
      setReplaceHint("No matches")
      return
    }
    setReplaceHint(null)
    toast({
      title: `Updated ${matchInfo.cues} caption${matchInfo.cues === 1 ? "" : "s"}`,
      variant: "success",
    })
  }

  function shiftBy(deltaMs: number) {
    if (!captionTrack) return
    // Null means nothing can move (already at t=0 or no cues); the command
    // coalesces so a direction streak stays one undo step.
    const command = createShiftCaptionsCommand(captionTrack, deltaMs)
    if (!command) {
      toast({ title: "Captions already at the start" })
      return
    }
    execute(command)
  }

  // Re-times AI cues through the current audio coverage — no whisper re-run.
  // Counts come from diffing the sync report across the state transition.
  function resyncCaptions() {
    if (!captionTrack || !timeline) return
    const before = analyzeCaptionSync(timeline, captionTrack)
    const beforeCues = captionTrack.clips.filter((clip) => clip.kind === "caption").length
    const applied = execute(createResyncCaptionsCommand(captionTrack.id))
    if (!applied) {
      toast({
        title: "Captions could not be resynced",
        description: "Unlock the captions track, then try again.",
        variant: "error",
      })
      return
    }
    const nextTrack = useTimelineStore
      .getState()
      .engine?.history.present.tracks.find((t) => t.id === captionTrack.id)
    const afterCues = nextTrack?.clips.filter((clip) => clip.kind === "caption").length ?? 0
    const removed = Math.max(before.dropped, beforeCues - afterCues)
    toast({
      title:
        before.displaced > 0
          ? `Re-aligned ${before.displaced} caption${before.displaced === 1 ? "" : "s"}`
          : "Captions resynced",
      ...(removed > 0
        ? { description: `${removed} cue${removed === 1 ? "" : "s"} removed — their audio was cut` }
        : {}),
      variant: "success",
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-2 px-4 py-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">Captions</h2>
          <p className="text-xs text-muted-foreground">Import, edit, and style spoken text.</p>
        </div>
        <div className="flex items-center gap-1">
          <IconButton
            label="Find and replace"
            aria-pressed={findOpen}
            className={findOpen ? "bg-overlay text-foreground" : undefined}
            disabled={!captionTrack}
            onClick={() => setFindOpen((open) => !open)}
          >
            <Replace className="size-4" aria-hidden />
          </IconButton>
          {/* Disabled buttons swallow pointer events — the wrapper carries
              the reason tooltip instead. */}
          <span className="inline-flex" title={resyncDisabled ? resyncHint : undefined}>
            <IconButton label="Resync captions" disabled={resyncDisabled} onClick={resyncCaptions}>
              <RefreshCw className="size-4" aria-hidden />
            </IconButton>
          </span>
          <Popover open={shiftOpen} onOpenChange={setShiftOpen}>
            <PopoverTrigger asChild>
              <IconButton label="Shift captions" disabled={!captionTrack || captionTrack.locked}>
                <MoveHorizontal className="size-4" aria-hidden />
              </IconButton>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56">
              <div className="flex flex-col gap-2">
                <span className="text-xs font-semibold text-foreground">Shift all captions</span>
                <div className="grid grid-cols-2 gap-1.5">
                  {SHIFT_DELTAS.map((delta) => (
                    <Button
                      key={delta}
                      variant="outline"
                      size="sm"
                      className="text-xs"
                      onClick={() => shiftBy(delta)}
                    >
                      {shiftDeltaLabel(delta)}
                    </Button>
                  ))}
                </div>
                <p className="text-[11px] text-subtle-foreground">
                  Moves every caption clip on the track.
                </p>
              </div>
            </PopoverContent>
          </Popover>
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

      {captionTrack && findOpen ? (
        <div className="flex flex-col gap-2 border-b border-border px-4 py-2.5">
          <div className="flex items-center gap-1.5">
            <Input
              aria-label="Find caption text"
              placeholder="Find…"
              value={find}
              onChange={(event) => {
                setFind(event.target.value)
                setReplaceHint(null)
              }}
              className="h-7 flex-1 text-xs"
            />
            <Input
              aria-label="Replace with"
              placeholder="Replace…"
              value={replace}
              onChange={(event) => setReplace(event.target.value)}
              className="h-7 flex-1 text-xs"
            />
          </div>
          <div className="flex items-center gap-2">
            <Switch aria-label="Match case" checked={matchCase} onCheckedChange={setMatchCase} />
            <span className="text-[11px] font-medium text-muted-foreground">Aa</span>
            <span className="min-w-0 flex-1 truncate text-right text-[11px] text-subtle-foreground">
              {find ? `${matchInfo.matches} matches in ${matchInfo.cues} captions` : ""}
            </span>
            <Button
              variant="secondary"
              size="sm"
              className="h-7 shrink-0 text-xs"
              disabled={!find || captionTrack.locked}
              onClick={replaceAll}
            >
              Replace all
            </Button>
          </div>
          {replaceHint ? (
            <p className="text-[11px] text-subtle-foreground" role="status">
              {replaceHint}
            </p>
          ) : null}
        </div>
      ) : null}

      {captionTrack?.muted ? (
        <div className="px-4 pb-2">
          <p className="flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11px] text-warning">
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
            Captions track is muted — nothing renders in preview or export.
          </p>
        </div>
      ) : null}

      {captionTrack && staleCount > 0 ? (
        <div className="px-4 pb-2">
          <p className="flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11px] text-warning">
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">
              {staleCount} caption{staleCount === 1 ? " is" : "s are"} out of sync with the edited
              audio — Resync or regenerate below.
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-6 shrink-0 border-warning/50 px-2 text-[11px] text-warning hover:bg-warning/20"
              disabled={captionTrack.locked}
              onClick={resyncCaptions}
            >
              Resync
            </Button>
          </p>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-2">
        {captionTrack ? (
          <section
            aria-label="Caption look"
            className="rounded-lg border border-border bg-surface p-3"
          >
            <CaptionDesignControls track={captionTrack} />
          </section>
        ) : null}

        {cueCount > 0 && captionTrack ? (
          <>
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
              design={captionDesign}
              canvas={timelineCanvas ?? FALLBACK_CANVAS}
            />
          </>
        ) : (
          <div className="flex-1">
            <EmptyState
              icon={CaptionsIcon}
              title="No captions yet"
              description="Drop an SRT or VTT file below, or add a caption at the playhead."
              className="h-full justify-center py-6"
            />
          </div>
        )}
      </div>

      <footer className="flex flex-col gap-3 border-t border-border px-4 py-3">
        <AiCaptionsCard />

        <CaptionImportPanel />

        <Button variant="secondary" size="sm" className="w-full" onClick={addCaptionAtPlayhead}>
          <Plus className="size-4" aria-hidden />
          Add caption at playhead
        </Button>
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
