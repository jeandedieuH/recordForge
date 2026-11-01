import { memo, useMemo } from "react"
import type {
  AudioClip,
  AudioVolumeKeyframe,
  TimelineClip,
  TimelineTrack,
} from "@recordforge/contracts"
import type { SnapTarget } from "@recordforge/editor-core"
import { Sparkles } from "lucide-react"
import { cn } from "@recordforge/ui"
import type {
  ThumbnailManifest,
  VideoTrackThumbnailResources,
  WaveformResources,
} from "../../media/derivative-resources"
import { toAssetUrl } from "../../media/derivative-resources"
import { TimelineClipItem } from "../timeline-clip-item"
import type { CursorRangeAction } from "../timeline-lanes"
import { getClipLaneTheme, laneStyle, type LaneTheme } from "./lane-theme"
import { computeClipSublanes, type ClipRuns } from "./timeline-clip-runs"
import { TimelineRunLabel } from "./timeline-run-label"
import type { EdgeAutoScroll } from "./use-edge-auto-scroll"
import type { TimelineGestureInfo } from "./timeline-gesture-overlay"

export interface TimelineLaneRowProps {
  track: TimelineTrack
  index: number
  top: number
  height: number
  pixelsPerMs: number
  visibleStartMs: number
  visibleEndMs: number
  scrollLeftPx: number
  tool: "select" | "split" | "range"
  collapsed: boolean
  frameMs: number
  // Clips intersecting the visible window plus any clip pinned by an active
  // gesture (an invalid move shows the original, which can scroll out).
  clips: TimelineClip[]
  // Non-overlap lanes carry run layout; overlap lanes get null and use
  // sublanes instead.
  runLayout: ClipRuns | null
  laneTheme: LaneTheme
  sourceDurationMs?: number
  // Screen-track gaps, already computed by the parent.
  screenGaps: { startMs: number; endMs: number }[]
  hasSelectedClip: boolean
  soloDimmed: boolean
  selectedClipIds: ReadonlySet<string>
  canGroup: boolean
  canUngroup: boolean
  // Screen-track sprite; camera clips resolve per-stream below.
  thumbnailManifest: ThumbnailManifest | null
  spriteUrl: string | null
  videoThumbnailResources?: VideoTrackThumbnailResources
  workDir?: string | null
  waveformResources: WaveformResources
  snapTargets: SnapTarget[]
  snapEnabled: boolean
  snapThresholdMs: number
  edgeAutoScroll: EdgeAutoScroll
  onGestureHud: (info: TimelineGestureInfo | null) => void
  onSnapGuide: (target: SnapTarget | null) => void
  getTimelineTime: (clientX: number) => number
  onSeek?: (timeMs: number) => void
  onSelectClip: (clip: TimelineClip, track: TimelineTrack, event: React.MouseEvent) => void
  onMoveClip: (
    clip: TimelineClip,
    track: TimelineTrack,
    newStartMs: number,
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
  onTrimClip: (
    clip: TimelineClip,
    track: TimelineTrack,
    edge: "start" | "end",
    edgeTimeMs: number,
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
  onSpriteError: () => void
  onDuplicateClip: (clip: TimelineClip) => void
  onSplitClip: (clip: TimelineClip, splitTimeMs?: number) => void
  onDeleteClip: (clip: TimelineClip, ripple?: boolean) => void
  onCursorRangeAction?: (action: CursorRangeAction) => void
  onUpdateClipAudio?: (
    clip: AudioClip,
    update: {
      volume?: number
      fadeInMs?: number
      fadeOutMs?: number
      volumeKeyframes?: AudioVolumeKeyframe[]
    },
  ) => void
  onRippleDeleteRange?: (startMs: number, endMs: number) => void
  onGroupClips?: () => void
  onUngroupClips?: () => void
}

export const TimelineLaneRow = memo(function TimelineLaneRow({
  track,
  index,
  top,
  height,
  pixelsPerMs,
  visibleStartMs,
  visibleEndMs,
  scrollLeftPx,
  tool,
  collapsed,
  frameMs,
  clips,
  runLayout,
  laneTheme,
  sourceDurationMs,
  screenGaps,
  hasSelectedClip,
  soloDimmed,
  selectedClipIds,
  canGroup,
  canUngroup,
  thumbnailManifest,
  spriteUrl,
  videoThumbnailResources,
  workDir,
  waveformResources,
  snapTargets,
  snapEnabled,
  snapThresholdMs,
  edgeAutoScroll,
  onGestureHud,
  onSnapGuide,
  getTimelineTime,
  onSeek,
  onSelectClip,
  onMoveClip,
  onTrimClip,
  onSpriteError,
  onDuplicateClip,
  onSplitClip,
  onDeleteClip,
  onCursorRangeAction,
  onUpdateClipAudio,
  onRippleDeleteRange,
  onGroupClips,
  onUngroupClips,
}: TimelineLaneRowProps) {
  const isScreenTrack = track.kind === "screen"
  const isCameraTrack = track.kind === "camera"

  const sublaneMap = useMemo(
    () => (runLayout ? null : computeClipSublanes(clips)),
    [runLayout, clips],
  )

  const visibleRuns = useMemo(() => {
    if (laneTheme.labelMode !== "run" || !runLayout) return []
    return runLayout.runs.filter(
      (run) => run.startMs <= visibleEndMs && run.endMs >= visibleStartMs,
    )
  }, [laneTheme.labelMode, runLayout, visibleStartMs, visibleEndMs])

  // Camera clips resolve their sprite by stream index so each webcam stream
  // shows its own frames; fall back to the first loaded manifest when the
  // clip carries no index.
  function cameraThumbnailFor(clip: TimelineClip) {
    if (!isCameraTrack || !videoThumbnailResources) return null
    const resources = [...videoThumbnailResources.byStream.entries()]
    const streamIndex = clip.kind === "camera" ? clip.streamIndex : undefined
    const byIndex =
      streamIndex !== undefined ? videoThumbnailResources.byStream.get(streamIndex) : undefined
    const resolved =
      byIndex?.status === "content"
        ? byIndex
        : resources
            .map(([, resource]) => resource)
            .find((resource) => resource.status === "content")
    if (!resolved || resolved.status !== "content") return null
    return {
      manifest: resolved.data,
      spriteUrl: toAssetUrl(resolved.data.spritePath, workDir),
    }
  }

  return (
    <div
      className={cn(
        "absolute inset-x-0 border-b border-border/50",
        index % 2 === 0 && "bg-surface/25",
        hasSelectedClip && "bg-lane/5",
        track.locked && "bg-surface-dim/60",
        soloDimmed && "opacity-50",
        tool === "split" && "cursor-crosshair",
      )}
      style={{ ...laneStyle(laneTheme.colorVar), top: `${top}px`, height: `${height}px` }}
    >
      {/* Gap-closing affordances on the screen track */}
      {isScreenTrack
        ? screenGaps
            .filter((gap) => gap.startMs <= visibleEndMs && gap.endMs >= visibleStartMs)
            .map((gap) => {
              const gapLeft = gap.startMs * pixelsPerMs
              const gapWidth = Math.max(16, (gap.endMs - gap.startMs) * pixelsPerMs)
              const gapSec = ((gap.endMs - gap.startMs) / 1000).toFixed(1)
              return (
                <div
                  key={`gap-${gap.startMs}-${gap.endMs}`}
                  className="group/gap absolute inset-y-1.5 z-10 flex items-center justify-center rounded-sm border border-dashed border-border-strong/70 bg-surface-dim/30 transition-colors hover:border-lane/70 hover:bg-lane/8"
                  style={{ left: `${gapLeft}px`, width: `${gapWidth}px` }}
                >
                  {onRippleDeleteRange && gapWidth >= 48 ? (
                    <button
                      type="button"
                      className="flex cursor-pointer items-center gap-1 rounded-sm border border-border/80 bg-surface/95 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-muted-foreground opacity-0 shadow-xs transition-opacity group-hover/gap:opacity-100 hover:border-lane/70 hover:text-lane whitespace-nowrap"
                      onClick={(e) => {
                        e.stopPropagation()
                        onRippleDeleteRange(gap.startMs, gap.endMs)
                      }}
                      title={`Close ${gapSec}s gap (ripple delete)`}
                    >
                      <Sparkles className="size-2.5 text-lane" />
                      <span>Close {gapSec}s</span>
                    </button>
                  ) : null}
                </div>
              )
            })
        : null}

      {/* One sticky label per contiguous run on run-labelled lanes */}
      {visibleRuns.map((run) => (
        <TimelineRunLabel
          key={run.id}
          name={track.name}
          icon={laneTheme.icon}
          startMs={run.startMs}
          endMs={run.endMs}
          clipCount={run.clipIds.length}
          pixelsPerMs={pixelsPerMs}
          scrollLeftPx={scrollLeftPx}
        />
      ))}

      {/* Sticky empty-lane hint follows the viewport edge */}
      {track.clips.length === 0 ? (
        <span
          className="pointer-events-none absolute top-1/2 -translate-y-1/2 text-[10px] text-subtle-foreground/60"
          style={{ left: `${scrollLeftPx + 12}px` }}
        >
          No clips
        </span>
      ) : null}

      {clips.map((clip) => {
        const runInfo = runLayout?.byClip.get(clip.id)
        const sublane = sublaneMap?.get(clip.id)
        const clipThumbnails = isCameraTrack ? cameraThumbnailFor(clip) : null
        const selected = selectedClipIds.has(clip.id)
        return (
          <TimelineClipItem
            key={clip.id}
            clip={clip}
            track={track}
            height={height}
            sublaneIndex={sublane?.index}
            sublaneCount={sublane?.count}
            pixelsPerMs={pixelsPerMs}
            selected={selected}
            tool={tool}
            frameMs={frameMs}
            collapsed={collapsed}
            thumbnailManifest={clipThumbnails ? clipThumbnails.manifest : thumbnailManifest}
            spriteUrl={clipThumbnails ? clipThumbnails.spriteUrl : spriteUrl}
            visibleStartMs={visibleStartMs}
            visibleEndMs={visibleEndMs}
            waveformResources={waveformResources}
            snapTargets={snapTargets}
            snapEnabled={snapEnabled}
            snapThresholdMs={snapThresholdMs}
            runPosition={runInfo?.position ?? "single"}
            prevEndMs={runInfo?.prevEndMs ?? null}
            nextStartMs={runInfo?.nextStartMs ?? null}
            showLabel={laneTheme.labelMode === "clip"}
            laneColorVar={getClipLaneTheme(clip, track).colorVar}
            sourceDurationMs={sourceDurationMs}
            isMultiMove={
              ("groupId" in clip && Boolean(clip.groupId)) || (selected && selectedClipIds.size > 1)
            }
            edgeAutoScroll={edgeAutoScroll}
            onGestureHud={onGestureHud}
            onSelectClip={onSelectClip}
            onMoveClip={onMoveClip}
            onTrimClip={onTrimClip}
            getTimelineTime={getTimelineTime}
            onSnapGuide={onSnapGuide}
            onSpriteError={onSpriteError}
            onDuplicateClip={onDuplicateClip}
            onSplitClip={onSplitClip}
            onDeleteClip={onDeleteClip}
            onSeek={onSeek}
            onCursorRangeAction={onCursorRangeAction}
            onUpdateAudio={onUpdateClipAudio}
            canGroup={canGroup}
            canUngroup={canUngroup}
            onGroupClips={onGroupClips}
            onUngroupClips={onUngroupClips}
          />
        )
      })}
    </div>
  )
})
