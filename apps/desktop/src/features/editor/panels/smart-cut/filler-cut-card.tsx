import { useMemo, useState } from "react"
import { createRippleDeleteRangesCommand } from "@recordforge/editor-core"
import {
  collectAudioClipsForStream,
  detectFillerWords,
  mapTranscriptToTimeline,
  mergeFillerCandidates,
  type FillerCandidate,
  type FillerLanguage,
  type FillerWord,
} from "@recordforge/editor-core"
import type { TimelineClip, TimelineState } from "@recordforge/contracts"
import { Badge, Button, EmptyState, SimpleSelect, Switch, useToast } from "@recordforge/ui"
import { AlertTriangle, Check, Scissors, Sparkles, Undo2 } from "lucide-react"
import { useLicenseStore } from "../../../../stores/license-store"
import { useTimelineStore } from "../../../../stores/timeline-store"
import { ProBadge } from "../../../licensing/pro-badge"

const LANGUAGES: Array<{ value: FillerLanguage; label: string }> = [
  { value: "en", label: "English" },
  { value: "fr", label: "Français" },
  { value: "es", label: "Español" },
  { value: "de", label: "Deutsch" },
]

const KIND_LABEL: Record<FillerCandidate["kind"], string> = {
  strict: "filler",
  phrase: "phrase",
  repeat: "repeat",
}

function formatSaved(ms: number): string {
  const seconds = Math.max(0, ms) / 1000
  return seconds < 10 ? `${seconds.toFixed(1)} s` : `${Math.round(seconds)} s`
}

/**
 * Timeline words for every transcribed caption track: the cue `sourceWords`
 * are asset-time, so they go through the same coverage mapping caption resync
 * uses before filler detection sees them in timeline time.
 */
function collectTimelineWords(timeline: TimelineState, recordingId: string | undefined) {
  if (!recordingId) return { words: [] as FillerWord[], captions: 0 }
  const captions = timeline.tracks
    .flatMap((track) => track.clips)
    .filter(
      (clip): clip is Extract<TimelineClip, { kind: "caption" }> =>
        clip.kind === "caption" && (clip.sourceWords?.length ?? 0) > 0,
    )
  let words: FillerWord[] = []
  for (const stream of new Set(captions.map((clip) => clip.sourceStreamIndex ?? -1))) {
    const streamCaptions = captions.filter((clip) => (clip.sourceStreamIndex ?? -1) === stream)
    const sourceWords = streamCaptions.flatMap((clip) =>
      (clip.sourceWords ?? []).map((word) => ({
        text: word.text,
        startMs: word.startMs,
        endMs: word.endMs,
        spaceBefore: true,
      })),
    )
    const clips = collectAudioClipsForStream(timeline, recordingId, stream === -1 ? null : stream)
    words = words.concat(mapTranscriptToTimeline(sourceWords, clips).words)
  }
  return { words, captions: captions.length }
}

/**
 * Filler-word removal for Smart Cut (M2 #6), Pro via the `smart-cut` key.
 *
 * The detector runs over the transcript already attached to the captions, so a
 * review is instant and nothing is re-transcribed. Accepted candidates go out as
 * one `ripple-delete-ranges` command, exactly like silence removal.
 */
export function FillerCutCard() {
  const isPro = useLicenseStore((state) => state.status.tier === "pro")
  const openUpgradeDialog = useLicenseStore((state) => state.openUpgradeDialog)
  const recording = useTimelineStore((state) => state.recording)
  const timeline = useTimelineStore((state) => state.engine?.history.present ?? null)
  const seek = useTimelineStore((state) => state.seek)
  const execute = useTimelineStore((state) => state.execute)
  const { toast } = useToast()

  const [language, setLanguage] = useState<FillerLanguage>("en")
  const [includePhrases, setIncludePhrases] = useState(false)
  const [includeRepeats, setIncludeRepeats] = useState(false)
  const [excluded, setExcluded] = useState<string[]>([])

  const { words, captions } = useMemo(
    () => (timeline ? collectTimelineWords(timeline, recording?.id) : { words: [], captions: 0 }),
    [timeline, recording?.id],
  )

  const candidates = useMemo(
    () =>
      timeline
        ? detectFillerWords(words, {
            language,
            includePhrases,
            includeRepeats,
            paddingMs: 40,
            fps: timeline.canvas.fps,
          })
        : [],
    [timeline, words, language, includePhrases, includeRepeats],
  )

  const selected = candidates.filter((candidate) => !excluded.includes(candidate.id))
  const ranges = mergeFillerCandidates(selected)
  const removedMs = ranges.reduce((total, range) => total + (range.endMs - range.startMs), 0)

  if (!isPro) {
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-surface p-3.5 shadow-xs">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-secondary" aria-hidden />
          <h3 className="text-sm font-semibold text-foreground">Filler words</h3>
          <ProBadge />
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Strip "um", "uh" and dead phrases from your captions in one undoable cut.
        </p>
        <Button
          variant="primary"
          size="sm"
          className="w-full"
          onClick={() => openUpgradeDialog(["smart-cut"])}
        >
          <Sparkles className="size-3.5" data-icon="inline-start" />
          <span>Upgrade to unlock</span>
        </Button>
      </div>
    )
  }

  function toggleCandidate(id: string) {
    setExcluded((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    )
  }

  function apply() {
    if (ranges.length === 0) return
    const ok = execute(createRippleDeleteRangesCommand(ranges))
    if (!ok) {
      toast({
        variant: "error",
        title: "Filler removal could not be applied",
        description: "The selected ranges are invalid for the current timeline.",
      })
      return
    }
    setExcluded([])
    toast({
      variant: "success",
      title: "Fillers removed",
      description: `${ranges.length} ${ranges.length === 1 ? "cut" : "cuts"} — ${formatSaved(removedMs)} saved. Press Ctrl+Z to undo.`,
    })
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-surface p-3.5 shadow-xs">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-secondary" aria-hidden />
          <h3 className="text-sm font-semibold text-foreground">Filler words</h3>
          <ProBadge />
        </div>
        {candidates.length > 0 ? (
          <Badge variant="accent" className="text-[10px] font-mono">
            {candidates.length} found
          </Badge>
        ) : null}
      </div>

      {captions === 0 ? (
        <EmptyState
          icon={Scissors}
          title="No transcript yet"
          description="Generate AI captions first — filler detection reads the word timings the transcript already carries."
          className="px-4 py-6"
        />
      ) : (
        <>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Finds disfluencies in your captions and removes them with the pauses around them. Review
            each one before cutting.
          </p>

          <div className="flex items-center justify-between gap-2 text-[11px] text-subtle-foreground">
            <span>Spoken language</span>
            <SimpleSelect
              aria-label="Filler language"
              size="sm"
              value={language}
              onValueChange={(value) => {
                setLanguage(value as FillerLanguage)
                setExcluded([])
              }}
              className="w-32"
              options={LANGUAGES}
            />
          </div>

          <label className="flex items-center justify-between gap-2 text-[11px] text-subtle-foreground">
            <span>Include phrases ("you know", "en fait")</span>
            <Switch
              checked={includePhrases}
              onCheckedChange={(value) => {
                setIncludePhrases(value)
                setExcluded([])
              }}
              aria-label="Include filler phrases"
            />
          </label>

          <label className="flex items-center justify-between gap-2 text-[11px] text-subtle-foreground">
            <span>Include repeated words ("I I think")</span>
            <Switch
              checked={includeRepeats}
              onCheckedChange={(value) => {
                setIncludeRepeats(value)
                setExcluded([])
              }}
              aria-label="Include repeated words"
            />
          </label>

          {candidates.length === 0 ? (
            <EmptyState
              icon={Check}
              title="No fillers found"
              description="Try enabling phrases or repeated words, or pick the language you actually spoke."
              className="px-4 py-6"
            />
          ) : (
            <>
              <div className="max-h-56 overflow-y-auto rounded-md border border-border/70">
                <ul className="divide-y divide-border/60">
                  {candidates.map((candidate) => {
                    const isExcluded = excluded.includes(candidate.id)
                    return (
                      <li key={candidate.id}>
                        <button
                          type="button"
                          className="flex w-full items-start gap-2 px-2 py-1.5 text-left hover:bg-overlay"
                          onClick={() => toggleCandidate(candidate.id)}
                          onDoubleClick={() => seek(candidate.startMs)}
                          aria-pressed={!isExcluded}
                        >
                          <span
                            className={`mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-sm border ${
                              isExcluded
                                ? "border-border bg-transparent"
                                : "border-primary bg-primary text-primary-foreground"
                            }`}
                            aria-hidden
                          >
                            {isExcluded ? null : <Check className="size-2.5" />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              <span
                                className={`truncate font-mono text-[11px] ${
                                  isExcluded
                                    ? "text-muted-foreground line-through"
                                    : "text-foreground"
                                }`}
                              >
                                {candidate.text}
                              </span>
                              <span className="rounded-sm bg-overlay px-1 font-mono text-[9px] uppercase tracking-wider text-subtle-foreground">
                                {KIND_LABEL[candidate.kind]}
                              </span>
                            </span>
                            <span className="block truncate text-[10px] text-subtle-foreground">
                              {candidate.context}
                            </span>
                          </span>
                          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                            {formatSaved(candidate.endMs - candidate.startMs)}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 flex-1 text-xs"
                  onClick={() => setExcluded([])}
                  disabled={excluded.length === 0}
                >
                  <Undo2 className="size-3.5" data-icon="inline-start" />
                  Select all
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-7 flex-1 text-xs font-semibold"
                  disabled={ranges.length === 0}
                  onClick={apply}
                >
                  <Scissors className="size-3.5" data-icon="inline-start" />
                  <span>
                    Cut{" "}
                    {ranges.length === 0
                      ? "nothing"
                      : `${ranges.length} · −${formatSaved(removedMs)}`}
                  </span>
                </Button>
              </div>

              {ranges.length / Math.max(1, selected.length) < 1 ? (
                <p className="flex items-start gap-1.5 text-[10px] leading-relaxed text-subtle-foreground">
                  <AlertTriangle className="mt-px size-3 shrink-0 text-warning" aria-hidden />
                  Overlapping cuts merge, so {selected.length} selected fillers become{" "}
                  {ranges.length} splice{ranges.length === 1 ? "" : "s"}.
                </p>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  )
}
