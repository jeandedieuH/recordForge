import { useEffect, useMemo, useState } from "react"
import type { ManualZoomSegment, ZoomPreset } from "@recordforge/contracts"
import { getCursorPointAtTimelineTime } from "@recordforge/cursor-core"
import { buildSmartZoomSegment } from "@recordforge/editor-core"
import {
  createAddZoomSegmentCommand,
  createDeleteZoomSegmentCommand,
  createDeleteZoomSegmentsCommand,
  createRegenerateZoomSuggestionsCommand,
  createSplitZoomSegmentCommand,
  createUpdateSmartZoomSettingsCommand,
  createUpdateZoomSegmentCommand,
  generateSmartZoomSuggestions,
  getManualZoomSegments,
  getTotalDuration,
} from "@recordforge/editor-core"
import { Plus, Trash2, ZoomIn } from "lucide-react"
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
  ScrollArea,
  useToast,
} from "@recordforge/ui"
import { isCameraRecording } from "../../../lib/library"
import { useTimelineStore } from "../../../stores/timeline-store"
import { SmartZoomCard } from "./focus/smart-zoom-card"
import { ReviewSuggestionsCard } from "./focus/review-suggestions-card"
import { ZoomSegmentCard } from "./focus/zoom-segment-card"

function formatTimecode(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  const millis = Math.floor((ms % 1000) / 10)
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${millis.toString().padStart(2, "0")}`
}

export function FocusPanel() {
  const execute = useTimelineStore((state) => state.execute)
  const setSelection = useTimelineStore((state) => state.setSelection)
  const seek = useTimelineStore((state) => state.seek)
  const timeline = useTimelineStore((state) => state.engine?.history.present)
  const view = useTimelineStore((state) => state.view)
  const cursorTelemetry = useTimelineStore((state) => state.cursorTelemetry)
  const cursorEngine = useTimelineStore((state) => state.cursorEngine)
  const cursorTelemetryStatus = useTimelineStore((state) => state.cursorTelemetryStatus)
  const isCamera = useTimelineStore((state) => isCameraRecording(state.recording))

  const playheadMs = view.playheadMs
  const segments = useMemo(() => (timeline ? getManualZoomSegments(timeline) : []), [timeline])
  const selectedId = view.selection?.kind === "zoom" ? view.selection.segmentId : null

  // Mirrors the preservation rule in applyRegenerateZoomSuggestions: user-authored
  // (manual/follow/legacy) and locked segments survive suggestion regeneration.
  const keptSegmentCount = useMemo(
    () =>
      segments.filter(
        (segment) =>
          segment.locked ||
          segment.source === "manual" ||
          segment.source === "follow" ||
          (segment.source === undefined && segment.mode !== "auto"),
      ).length,
    [segments],
  )

  const canvas = timeline?.canvas ?? { width: 1920, height: 1080 }
  const smartZoomPreset = timeline?.smartZoomSettings?.preset ?? "product-demo"

  const [preset, setPreset] = useState<ZoomPreset>(smartZoomPreset)
  const [reviewing, setReviewing] = useState<ManualZoomSegment[] | null>(null)
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false)
  const { toast } = useToast()

  // Locked segments survive a bulk delete — same protection rule the single
  // delete and suggestion regeneration already apply.
  const removableIds = useMemo(
    () => segments.filter((segment) => !segment.locked).map((segment) => segment.id),
    [segments],
  )
  const lockedCount = segments.length - removableIds.length

  useEffect(() => {
    setPreset(smartZoomPreset)
  }, [smartZoomPreset])

  const timelineDuration = timeline ? getTotalDuration(timeline) : 0

  function onPresetChange(next: ZoomPreset) {
    setPreset(next)
    if (!timeline) return
    execute(createUpdateSmartZoomSettingsCommand({ preset: next }))
  }

  function addManual() {
    if (!timeline) return
    const startMs = playheadMs
    const defaultEnd = Math.min(timelineDuration || startMs + 1_500, startMs + 1_500)
    if (defaultEnd <= startMs) return

    // Evaluate the cursor at the playhead so the new segment focuses there.
    const cursorPoint = getCursorPointAtTimelineTime(
      timeline,
      startMs,
      cursorTelemetry,
      cursorEngine,
    )
    const segment = buildSmartZoomSegment(timeline, cursorPoint, {
      segmentId: crypto.randomUUID(),
      startMs,
      endMs: defaultEnd,
      preset,
      mode: "follow-cursor",
    })

    execute(
      createAddZoomSegmentCommand(
        segment.startMs,
        segment.startMs + segment.durationMs,
        segment.target,
        {
          segmentId: segment.id,
          scale: segment.scale,
          easing: segment.easing,
          transitionInMs: segment.transitionInMs,
          transitionOutMs: segment.transitionOutMs,
          mode: "follow-cursor",
          source: "manual",
          preset,
          followSpeed: segment.followSpeed,
          label: segment.label,
        },
      ),
    )
    setSelection({ kind: "zoom", segmentId: segment.id })
  }

  function generateSuggestions() {
    if (!timeline || !cursorTelemetry || cursorTelemetryStatus !== "available") return []
    return generateSmartZoomSuggestions(cursorTelemetry, timeline, {
      ...(timeline.smartZoomSettings ?? {}),
      durationMs: getTotalDuration(timeline),
    })
  }

  function startReview() {
    const suggestions = generateSuggestions()
    if (suggestions.length === 0) return
    setReviewing(suggestions)
  }

  function acceptSuggestions(selectedSuggestions?: ManualZoomSegment[]) {
    const toApply = selectedSuggestions ?? reviewing
    if (!toApply || toApply.length === 0) return
    execute(createRegenerateZoomSuggestionsCommand(toApply))
    setReviewing(null)
  }

  function rejectSuggestions() {
    setReviewing(null)
  }

  function selectSegment(segment: ManualZoomSegment) {
    setSelection({ kind: "zoom", segmentId: segment.id })
    seek(segment.startMs)
  }

  function jumpToSegment(segment: ManualZoomSegment) {
    seek(segment.startMs)
    setSelection({ kind: "zoom", segmentId: segment.id })
  }

  function splitSegment(segment: ManualZoomSegment) {
    const splitTimeMs = segment.startMs + Math.floor(segment.durationMs / 2)
    execute(createSplitZoomSegmentCommand(segment.id, splitTimeMs))
  }

  function deleteSegment(segment: ManualZoomSegment) {
    execute(createDeleteZoomSegmentCommand(segment.id))
    if (selectedId === segment.id) setSelection(null)
  }

  function toggleLock(segment: ManualZoomSegment) {
    execute(createUpdateZoomSegmentCommand(segment.id, { locked: !segment.locked }))
  }

  function requestDeleteAll() {
    if (removableIds.length === 0) {
      toast({
        title: "All zoom keyframes are locked",
        description: "Unlock a keyframe before deleting it.",
      })
      return
    }
    setConfirmDeleteAll(true)
  }

  function deleteAllSegments() {
    setConfirmDeleteAll(false)
    const applied = execute(createDeleteZoomSegmentsCommand(removableIds))
    if (!applied) {
      toast({ title: "Zoom keyframes could not be removed", variant: "error" })
      return
    }
    if (view.selection?.kind === "zoom" && removableIds.includes(view.selection.segmentId)) {
      setSelection(null)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      {/* Panel Header */}
      <div className="flex items-center justify-between border-b border-border pb-2.5">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <ZoomIn className="size-4 text-primary" aria-hidden />
          <h2>Focus & Zoom</h2>
        </div>
        {segments.length > 0 ? (
          <Badge variant="default" className="text-[10px] font-mono">
            {segments.length} segment{segments.length === 1 ? "" : "s"}
          </Badge>
        ) : null}
      </div>

      {/* Smart Zoom Settings Card */}
      <SmartZoomCard
        preset={preset}
        onPresetChange={onPresetChange}
        telemetryStatus={cursorTelemetryStatus}
        isCameraRecording={isCamera}
        onReviewSuggestions={startReview}
        disabled={!timeline}
      />

      {/* Suggestion Review Banner (when active) */}
      {reviewing ? (
        <ReviewSuggestionsCard
          suggestions={reviewing}
          canvas={canvas}
          keptSegmentCount={keptSegmentCount}
          onAccept={acceptSuggestions}
          onReject={rejectSuggestions}
          onSeek={seek}
        />
      ) : null}

      {/* Add Manual Zoom Primary Action */}
      <Button
        variant="secondary"
        size="sm"
        className="h-8.5 w-full text-xs font-semibold shadow-xs border border-border-strong hover:border-primary/50 transition-all"
        disabled={!timeline}
        onClick={addManual}
      >
        <Plus className="size-3.5" data-icon="inline-start" />
        <span>Add manual zoom at {formatTimecode(playheadMs)}</span>
      </Button>

      {/* Zoom Keyframe Segments Section */}
      <div className="flex flex-col gap-2 pt-1">
        <div className="flex items-center justify-between px-0.5">
          <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
            Zoom Keyframes
          </span>
          <div className="flex items-center gap-1">
            <span className="text-[10px] font-mono text-subtle-foreground">
              {segments.length} total
            </span>
            {segments.length > 0 ? (
              <IconButton
                label="Delete all zoom keyframes"
                className="size-6 text-destructive hover:text-destructive"
                onClick={requestDeleteAll}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </IconButton>
            ) : null}
          </div>
        </div>

        {segments.length === 0 ? (
          <EmptyState
            icon={ZoomIn}
            title="No Zoom Segments"
            description="Add a manual zoom keyframe at the playhead or generate smart zoom from cursor activity."
            action={
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={!timeline}
                onClick={addManual}
              >
                <Plus className="size-3" data-icon="inline-start" />
                Add Zoom Keyframe
              </Button>
            }
            className="py-6 px-4"
          />
        ) : (
          // Cap the height so many keyframes scroll inside the list instead of
          // stretching the whole panel.
          <ScrollArea className="max-h-96 w-full border border-border p-2 rounded-2xl">
            <div className="flex flex-col gap-2 pr-1">
              {segments.map((segment) => {
                const isSelected = selectedId === segment.id
                const isPlayheadInside =
                  playheadMs >= segment.startMs &&
                  playheadMs <= segment.startMs + segment.durationMs

                return (
                  <ZoomSegmentCard
                    key={segment.id}
                    segment={segment}
                    canvas={canvas}
                    selected={isSelected}
                    isPlayheadInside={isPlayheadInside}
                    onSelect={() => selectSegment(segment)}
                    onJumpToStart={() => jumpToSegment(segment)}
                    onSplit={() => splitSegment(segment)}
                    onToggleLock={() => toggleLock(segment)}
                    onDelete={() => deleteSegment(segment)}
                  />
                )
              })}
            </div>
          </ScrollArea>
        )}
      </div>

      <AlertDialog open={confirmDeleteAll} onOpenChange={setConfirmDeleteAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete all zoom keyframes?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes {removableIds.length} zoom keyframe
              {removableIds.length === 1 ? "" : "s"}.
              {lockedCount > 0
                ? ` ${lockedCount} locked keyframe${lockedCount === 1 ? "" : "s"} will be kept.`
                : ""}{" "}
              You can undo this action.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={deleteAllSegments}>Delete keyframes</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
