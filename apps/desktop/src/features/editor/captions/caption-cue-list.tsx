import { useEffect, useMemo, useRef, useState } from "react"
import { CircleAlert, Pencil, Trash2 } from "lucide-react"
import type { CaptionClip, TimelineTrack } from "@recordforge/contracts"
import { createDeleteClipsCommand } from "@recordforge/editor-core"
import { IconButton, ScrollArea, Textarea, cn } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"
import { useTimelineInteraction } from "../timeline/use-timeline-interaction"

interface CaptionCueListProps {
  track: TimelineTrack
  playheadMs: number
  isPlaying: boolean
  screenDurationMs: number
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

/**
 * Playhead-synced cue editor: click a row to seek and select the clip on the
 * timeline; the pencil toggles inline text editing; the active cue follows
 * playback without stealing scroll while paused.
 */
export function CaptionCueList({
  track,
  playheadMs,
  isPlaying,
  screenDurationMs,
}: CaptionCueListProps) {
  const seek = useTimelineStore((state) => state.seek)
  const setSelection = useTimelineStore((state) => state.setSelection)
  const execute = useTimelineStore((state) => state.execute)
  const selectedClipId = useTimelineStore((state) =>
    state.view.selection?.kind === "clip" ? state.view.selection.primaryClipId : null,
  )
  const interaction = useTimelineInteraction()

  const cues = useMemo(
    () =>
      track.clips
        .filter((clip): clip is CaptionClip => clip.kind === "caption")
        .sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id)),
    [track.clips],
  )

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

  return (
    <ScrollArea className="min-h-0 flex-1 rounded-lg border border-border bg-surface-dim">
      <ul className="flex flex-col p-1" aria-label="Caption cues">
        {cues.map((cue) => {
          const isActive = cue.id === activeCueId
          const isSelected = cue.id === selectedClipId
          const isBeyondEnd = cue.startMs >= screenDurationMs
          const isEditing = editingId === cue.id

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
                    isBeyondEnd && "opacity-60",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => selectCue(cue)}
                    onDoubleClick={() => {
                      setEditingId(cue.id)
                      setDraft(cue.text)
                    }}
                    className="min-w-0 flex-1 text-left focus-visible:outline-none"
                    aria-label={`Caption at ${formatCueTime(cue.startMs)}: ${cue.text}`}
                  >
                    <span className="flex items-center gap-1.5 font-mono text-[10px] leading-none text-subtle-foreground">
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
                    </span>
                    <span className="mt-1 block text-xs leading-snug whitespace-pre-line text-foreground wrap-anywhere">
                      {cue.text}
                    </span>
                  </button>
                  <span className="flex shrink-0 flex-col opacity-0 transition-opacity duration-fast group-focus-within:opacity-100 group-hover:opacity-100">
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
  )
}
