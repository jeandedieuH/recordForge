import { useEffect, useMemo, useRef, useState } from "react"
import { CircleAlert, Pencil, Scissors, Sparkles, Trash2 } from "lucide-react"
import type {
  CanvasAspectRatio,
  CaptionClip,
  CaptionDesign,
  TimelineTrack,
} from "@recordforge/contracts"
import {
  analyzeCaptionCue,
  createDeleteClipsCommand,
  createMergeCaptionClipsCommand,
  createSplitClipCommand,
} from "@recordforge/editor-core"
import { Badge, Button, IconButton, ScrollArea, Textarea, cn, useToast } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"
import { useTimelineInteraction } from "../timeline/use-timeline-interaction"

interface CaptionCueListProps {
  track: TimelineTrack
  playheadMs: number
  isPlaying: boolean
  screenDurationMs: number
  design: CaptionDesign
  canvas: { width: number; height: number; aspectRatio?: CanvasAspectRatio }
}

function formatCueTime(ms: number): string {
  const totalSeconds = ms / 1_000
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds - minutes * 60
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`
}

function isCueActive(clip: CaptionClip, playheadMs: number): boolean {
  return playheadMs >= clip.startMs && playheadMs < clip.startMs + clip.durationMs
}

const CHIP_CLASS = "px-1 py-0 font-sans text-[10px] font-normal leading-tight [&_svg]:size-2.5"

/**
 * Playhead-synced cue editor: click a row to seek and select the clip on the
 * timeline; the pencil toggles inline text editing; the active cue follows
 * playback without stealing scroll while paused. Ctrl/Cmd+click multi-selects
 * rows for merging; the scissors splits a cue at the playhead. Rows carry
 * readability badges from the same layout engine the renderer uses.
 */
export function CaptionCueList({
  track,
  playheadMs,
  isPlaying,
  screenDurationMs,
  design,
  canvas,
}: CaptionCueListProps) {
  const seek = useTimelineStore((state) => state.seek)
  const setSelection = useTimelineStore((state) => state.setSelection)
  const execute = useTimelineStore((state) => state.execute)
  const selectedClipId = useTimelineStore((state) =>
    state.view.selection?.kind === "clip" ? state.view.selection.primaryClipId : null,
  )
  const interaction = useTimelineInteraction()
  const { toast } = useToast()

  const cues = useMemo(
    () =>
      track.clips
        .filter((clip): clip is CaptionClip => clip.kind === "caption")
        .sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id)),
    [track.clips],
  )

  // Readability diagnostics — cue objects are immutable, so a changed
  // text/timing re-derives `cues` and the whole map recomputes.
  const analyses = useMemo(() => {
    const map = new Map<string, ReturnType<typeof analyzeCaptionCue>>()
    for (const cue of cues) {
      map.set(
        cue.id,
        analyzeCaptionCue(
          { text: cue.text, startMs: cue.startMs, endMs: cue.startMs + cue.durationMs },
          design,
          canvas,
        ),
      )
    }
    return map
  }, [cues, design, canvas])

  const activeCueId = useMemo(
    () => cues.find((cue) => isCueActive(cue, playheadMs))?.id ?? null,
    [cues, playheadMs],
  )

  // Follow the active cue during playback only — while paused the list keeps
  // the user's scroll position so rows don't jump out from under the cursor.
  const activeRowRef = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (isPlaying && activeCueId) {
      activeRowRef.current?.scrollIntoView({ block: "nearest" })
    }
  }, [isPlaying, activeCueId])

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [mergeIds, setMergeIds] = useState<ReadonlySet<string>>(new Set())

  // Ids of deleted clips fall out automatically; the raw set stays untouched.
  const mergeSelection = useMemo(() => {
    const live = new Set(cues.map((cue) => cue.id))
    return new Set([...mergeIds].filter((id) => live.has(id)))
  }, [mergeIds, cues])

  function commitEdit(clipId: string) {
    const text = draft.trim()
    setEditingId(null)
    if (!text) return
    interaction.updateCaption(clipId, { text }, { phase: "commit" })
  }

  function selectCue(clip: CaptionClip) {
    seek(clip.startMs)
    setSelection({ kind: "clip", primaryClipId: clip.id, clipIds: [clip.id] })
  }

  // Plain click keeps select/seek; Ctrl/Cmd+click only toggles merge membership.
  function handleCueClick(event: React.MouseEvent<HTMLButtonElement>, cue: CaptionClip) {
    if (event.ctrlKey || event.metaKey) {
      if (!track.locked) {
        setMergeIds((prev) => {
          const next = new Set(prev)
          if (next.has(cue.id)) next.delete(cue.id)
          else next.add(cue.id)
          return next
        })
      }
      return
    }
    selectCue(cue)
  }

  function mergeSelected() {
    // Engine wants the cues ordered by startMs — `cues` is already sorted.
    const ids = cues.filter((cue) => mergeSelection.has(cue.id)).map((cue) => cue.id)
    setMergeIds(new Set())
    const applied = execute(createMergeCaptionClipsCommand(ids))
    toast(
      applied
        ? { title: `Merged ${ids.length} captions`, variant: "success" }
        : {
            title: "Captions could not be merged",
            description: "Only adjacent captions on the captions track can be merged.",
            variant: "error",
          },
    )
  }

  function splitAtPlayhead(cue: CaptionClip) {
    const applied = execute(createSplitClipCommand(cue.id, playheadMs))
    if (!applied) {
      toast({
        title: "Caption could not be split",
        description: "Move the playhead inside the cue, then try again.",
        variant: "error",
      })
    }
  }

  return (
    // `min-h-0` alone let flex-1 collapse the list to a sliver in tight
    // panels; the floor keeps ~3 rows visible so the outer column scrolls
    // instead of hiding the overflow inside the inner ScrollArea.
    <div className="flex min-h-40 flex-1 flex-col">
      {mergeSelection.size >= 2 && !track.locked ? (
        <div className="mb-1 flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-2 py-1">
          <span className="text-[11px] text-subtle-foreground">{mergeSelection.size} selected</span>
          <div className="flex items-center gap-1">
            <Button
              variant="secondary"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={mergeSelected}
            >
              Merge {mergeSelection.size} captions
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px] text-subtle-foreground"
              onClick={() => setMergeIds(new Set())}
            >
              Clear
            </Button>
          </div>
        </div>
      ) : null}
      <ScrollArea className="min-h-0 flex-1 rounded-lg border border-border bg-surface-dim">
        <ul className="flex flex-col p-1" aria-label="Caption cues">
          {cues.map((cue, cueIndex) => {
            const isActive = cue.id === activeCueId
            const isSelected = cue.id === selectedClipId
            const isMergeSelected = mergeSelection.has(cue.id)
            const isBeyondEnd = cue.startMs >= screenDurationMs
            const isEditing = editingId === cue.id
            const analysis = analyses.get(cue.id)
            const canSplit =
              !track.locked && playheadMs > cue.startMs && playheadMs < cue.startMs + cue.durationMs

            return (
              <li key={cue.id} ref={isActive ? activeRowRef : undefined}>
                {isEditing ? (
                  <div className="m-0.5 flex flex-col gap-1.5 rounded-md border border-primary/50 bg-surface p-2">
                    <Textarea
                      aria-label="Edit caption text"
                      value={draft}
                      rows={2}
                      autoFocus
                      onChange={(event) => setDraft(event.target.value)}
                      onBlur={() => commitEdit(cue.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                          event.preventDefault()
                          commitEdit(cue.id)
                        }
                        if (event.key === "Escape") {
                          event.preventDefault()
                          setEditingId(null)
                        }
                      }}
                    />
                    <p className="text-[10px] text-subtle-foreground">
                      Ctrl+Enter to save, Esc to cancel
                    </p>
                  </div>
                ) : (
                  <div
                    className={cn(
                      "group relative m-0.5 flex items-start gap-1 rounded-md border border-transparent px-2 py-1.5 transition-colors duration-fast",
                      isActive && "border-track-captions/40 bg-track-captions/10",
                      isSelected && !isActive && "border-primary/40 bg-primary/5",
                      isMergeSelected && !isActive && "border-accent/50 bg-accent-soft",
                      isBeyondEnd && "opacity-60",
                    )}
                  >
                    <button
                      type="button"
                      onClick={(event) => handleCueClick(event, cue)}
                      onDoubleClick={() => {
                        setEditingId(cue.id)
                        setDraft(cue.text)
                      }}
                      className="min-w-0 flex-1 text-left focus-visible:outline-none"
                      aria-label={`Caption at ${formatCueTime(cue.startMs)}: ${cue.text}`}
                      aria-pressed={isMergeSelected}
                    >
                      <span className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] leading-none text-subtle-foreground">
                        <span className="text-subtle-foreground/60">#{cueIndex + 1}</span>
                        {formatCueTime(cue.startMs)}
                        <span aria-hidden>→</span>
                        {formatCueTime(cue.startMs + cue.durationMs)}
                        {isBeyondEnd ? (
                          <span
                            className="inline-flex items-center gap-0.5 text-warning"
                            title="Starts after the video ends — excluded from export"
                          >
                            <CircleAlert className="size-3" aria-hidden />
                          </span>
                        ) : null}
                        {cue.words !== undefined && cue.words.length > 0 ? (
                          <Badge
                            variant="accent"
                            className={CHIP_CLASS}
                            title="Word-level AI timing — editing the text resets it"
                          >
                            <Sparkles aria-hidden /> AI
                          </Badge>
                        ) : null}
                        {analysis && analysis.pages > 1 ? (
                          <Badge
                            variant="warning"
                            className={CHIP_CLASS}
                            title={`Caption splits into ${analysis.pages} pages — consider shortening`}
                          >
                            {analysis.pages} pages
                          </Badge>
                        ) : null}
                        {analysis?.warnings.includes("fast") ? (
                          <Badge
                            variant="warning"
                            className={CHIP_CLASS}
                            title="Reads fast — over 20 characters per second"
                          >
                            fast
                          </Badge>
                        ) : null}
                        {analysis?.warnings.includes("short") ? (
                          <Badge
                            variant="warning"
                            className={CHIP_CLASS}
                            title="On screen for less than half a second"
                          >
                            short
                          </Badge>
                        ) : null}
                      </span>
                      <span className="mt-1 line-clamp-2 block text-xs leading-snug whitespace-pre-line text-foreground wrap-anywhere">
                        {cue.text}
                      </span>
                    </button>
                    {/* Hover actions overlay the row's top-right — a vertical
                        stack here would stretch every row to ~72px on hover. */}
                    <span className="absolute right-1 top-1 flex items-center rounded-md bg-surface/95 opacity-0 shadow-sm ring-1 ring-border transition-opacity duration-fast group-focus-within:opacity-100 group-hover:opacity-100">
                      <span
                        className="inline-flex"
                        {...(canSplit
                          ? {}
                          : {
                              title: track.locked
                                ? "Unlock the captions track to split"
                                : "Move the playhead inside this caption to split",
                            })}
                      >
                        <IconButton
                          label="Split caption at playhead"
                          className="size-6"
                          disabled={!canSplit}
                          onClick={() => splitAtPlayhead(cue)}
                        >
                          <Scissors className="size-3" aria-hidden />
                        </IconButton>
                      </span>
                      <IconButton
                        label="Edit caption"
                        className="size-6"
                        onClick={() => {
                          setEditingId(cue.id)
                          setDraft(cue.text)
                        }}
                      >
                        <Pencil className="size-3" aria-hidden />
                      </IconButton>
                      <IconButton
                        label="Delete caption"
                        className="size-6 text-destructive hover:text-destructive"
                        onClick={() => execute(createDeleteClipsCommand([cue.id]))}
                      >
                        <Trash2 className="size-3" aria-hidden />
                      </IconButton>
                    </span>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </ScrollArea>
    </div>
  )
}
