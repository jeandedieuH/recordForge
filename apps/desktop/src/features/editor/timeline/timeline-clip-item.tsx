import { memo, useEffect, useRef, useState } from "react"
import type {
  AudioClip,
  AudioVolumeKeyframe,
  CursorSmoothing,
  TimelineClip,
  TimelineTrack,
} from "@recordforge/contracts"
import { Copy, Link2, Link2Off, Lock, Scissors, Trash2 } from "lucide-react"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  cn,
} from "@recordforge/ui"
import {
  playheadSnapTarget,
  snapClipStart,
  snapTime,
  snapTrimEdge,
  trackAllowsOverlap,
  type SnapTarget,
} from "@recordforge/editor-core"
import type { ThumbnailManifest, WaveformResources } from "../media/derivative-resources"
import { getPlayheadSnapshot, usePlayheadMs } from "./use-playback-state"
import { ThumbnailFilmstrip } from "./thumbnail-filmstrip"
import { TimelineWaveform } from "./timeline-waveform"
import { TimelineAudioEnvelope } from "./timeline-audio-envelope"
import { formatTimelineTime } from "./timeline-ruler"
import type { CursorRangeAction } from "./timeline-lanes"
import { getClipIcon, laneStyle } from "./lanes/lane-theme"
import type { RunPosition } from "./lanes/timeline-clip-runs"
import { clampTrimEdge, moveOverlaps, type TrimLimit } from "./lanes/timeline-gesture-math"
import { TimelineEdgeHandle } from "./lanes/timeline-edge-handle"
import { AudioFadeHint } from "./lanes/audio-fade-hint"
import type { EdgeAutoScroll } from "./lanes/use-edge-auto-scroll"
import type { TimelineGestureInfo } from "./lanes/timeline-gesture-overlay"

interface ClipGesture {
  pointerId: number
  mode: "move" | "trim-start" | "trim-end"
  initialClientX: number
  initialTimelineMs: number
  initialClipStartMs: number
  initialClipEndMs: number
  // Snapshot at gesture start — clampTrimEdge must run against pre-gesture
  // geometry because drafts rewrite clip.startMs/durationMs.
  clipSnapshot: TimelineClip
  prevEndMs: number | null
  nextStartMs: number | null
  moved: boolean
  invalid: "overlap" | null
  // Snap targets captured at gesture start — includes the live playhead,
  // which is intentionally absent from the memoized prop list so playback
  // ticks do not rebuild it.
  snapTargets: SnapTarget[]
}

export interface TimelineClipItemProps {
  clip: TimelineClip
  track: TimelineTrack
  height: number
  pixelsPerMs: number
  selected: boolean
  frameMs: number
  collapsed: boolean
  thumbnailManifest: ThumbnailManifest | null
  spriteUrl: string | null
  visibleStartMs: number
  visibleEndMs: number
  waveformResources: WaveformResources
  snapTargets: SnapTarget[]
  snapEnabled: boolean
  snapThresholdMs: number
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
  getTimelineTime: (clientX: number) => number
  tool?: "select" | "split" | "range"
  onSnapGuide: (target: SnapTarget | null) => void
  onSpriteError: () => void
  onDuplicateClip: (clip: TimelineClip) => void
  onSplitClip: (clip: TimelineClip, splitTimeMs?: number) => void
  onDeleteClip: (clip: TimelineClip, ripple?: boolean) => void
  onSeek?: (timeMs: number) => void
  onCursorRangeAction?: (action: CursorRangeAction) => void
  onUpdateAudio?: (
    clip: AudioClip,
    update: {
      volume?: number
      fadeInMs?: number
      fadeOutMs?: number
      volumeKeyframes?: AudioVolumeKeyframe[]
    },
  ) => void
  sublaneIndex?: number
  sublaneCount?: number
  // Group affordances act on the whole selection, not just this clip; the
  // parent decides whether they're currently meaningful.
  canGroup?: boolean
  canUngroup?: boolean
  onGroupClips?: () => void
  onUngroupClips?: () => void
  // Seamless-strip layout: which slot this clip occupies inside its run, and
  // the immediate neighbors' edges used to clamp trims.
  runPosition: RunPosition
  prevEndMs: number | null
  nextStartMs: number | null
  // False on run-labelled lanes (one sticky label per run).
  showLabel: boolean
  laneColorVar: string
  sourceDurationMs?: number
  // Group moves bypass the single-clip overlap check — the command layer
  // resolves collisions for multi-clip transactions.
  isMultiMove: boolean
  edgeAutoScroll: EdgeAutoScroll
  onGestureHud: (info: TimelineGestureInfo | null) => void
}

function getClipLabel(clip: TimelineClip, track: TimelineTrack): string {
  if (clip.kind === "screen") return "Screen"
  if (clip.kind === "camera") return "Camera"
  if (clip.kind === "cursor-effect") return `${clip.presetId} cursor`
  if (clip.kind === "caption") return clip.text
  if (clip.kind === "mask") return `${clip.mode} mask`
  if (clip.kind === "annotation")
    return clip.text ? `${clip.annotationType} (${clip.text})` : `${clip.annotationType} shape`
  if (clip.kind === "text") return clip.primaryText || "Title"
  if (clip.kind === "image") return "Graphic overlay"
  if (clip.kind === "audio" && clip.role === "music") return "Music Track"
  return track.name
}

function formatDurationSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

const RUN_CORNERS: Record<RunPosition, string> = {
  single: "rounded-sm",
  first: "rounded-l-sm",
  middle: "",
  last: "rounded-r-sm",
}

export const TimelineClipItem = memo(function TimelineClipItem({
  clip,
  track,
  height,
  pixelsPerMs,
  selected,
  frameMs,
  collapsed,
  thumbnailManifest,
  spriteUrl,
  visibleStartMs,
  visibleEndMs,
  waveformResources,
  snapTargets,
  snapEnabled,
  snapThresholdMs,
  tool = "select",
  onSelectClip,
  onMoveClip,
  onTrimClip,
  getTimelineTime,
  onSnapGuide,
  onSpriteError,
  onDuplicateClip,
  onSplitClip,
  onDeleteClip,
  onSeek,
  onCursorRangeAction,
  onUpdateAudio,
  sublaneIndex = 0,
  sublaneCount = 1,
  canGroup = false,
  canUngroup = false,
  onGroupClips,
  onUngroupClips,
  runPosition,
  prevEndMs,
  nextStartMs,
  showLabel,
  laneColorVar,
  sourceDurationMs,
  isMultiMove,
  edgeAutoScroll,
  onGestureHud,
}: TimelineClipItemProps) {
  const gestureRef = useRef<ClipGesture | null>(null)
  const lastPointerRef = useRef<{ clientX: number; altKey: boolean } | null>(null)
  const suppressClickRef = useRef(false)
  const [activeGesture, setActiveGesture] = useState<ClipGesture["mode"] | null>(null)
  const [activeLimit, setActiveLimit] = useState<TrimLimit | null>(null)
  const [isHovered, setIsHovered] = useState(false)
  const [envelopeActive, setEnvelopeActive] = useState(false)
  const [contextMenuTimeMs, setContextMenuTimeMs] = useState<number | null>(null)

  // Recording streams resolve by stream index; imported audio assets carry no
  // stream index and resolve by asset id instead.
  const waveformResource =
    clip.kind === "audio"
      ? clip.streamIndex !== undefined
        ? (waveformResources.byStream.get(clip.streamIndex) ??
          waveformResources.byAsset.get(clip.assetId))
        : waveformResources.byAsset.get(clip.assetId)
      : undefined
  const waveformData = waveformResource?.status === "content" ? waveformResource.data : null
  const clipTargets = snapTargets.filter((target) => !target.id.startsWith(`${clip.id}:`))
  // Sublanes split the lane's inner height (4px padding top + bottom) with
  // 2px gaps, never smaller than 16px each.
  const clipHeight =
    sublaneCount > 1
      ? Math.max(16, Math.floor((height - 8 - (sublaneCount - 1) * 2) / sublaneCount))
      : Math.max(8, height - 8)
  const clipTop = 4 + (sublaneCount > 1 ? sublaneIndex * (clipHeight + 2) : 0)
  const width = Math.max(clip.durationMs * pixelsPerMs, 2)
  const cursorRange = clip.kind === "cursor-effect" ? clip : null
  const isLocked = track.locked || (cursorRange ? cursorRange.locked : false)
  const isGrouped = "groupId" in clip && Boolean(clip.groupId)
  const isDisabledRange = cursorRange ? cursorRange.enabled === false : false
  const label = getClipLabel(clip, track)
  const ClipIcon = getClipIcon(clip, track)

  const hitWidth = Math.round(Math.min(10, Math.max(4, width * 0.25)))
  const showHandles = !isLocked && tool !== "split" && (width >= 8 || selected)
  const showEnvelope =
    clip.kind === "audio" &&
    Boolean(onUpdateAudio) &&
    !collapsed &&
    width >= 24 &&
    (selected || isHovered || envelopeActive)

  function beginGesture(event: React.PointerEvent<HTMLElement>, mode: ClipGesture["mode"]) {
    if (event.button !== 0 || isLocked) return
    if (event.target instanceof Element && event.target.closest("[data-envelope-interactive]")) {
      return
    }
    event.stopPropagation()
    event.preventDefault()
    const target = event.currentTarget.closest("[data-timeline-clip]")
    if (!(target instanceof HTMLElement)) return
    target.setPointerCapture(event.pointerId)
    gestureRef.current = {
      pointerId: event.pointerId,
      mode,
      initialClientX: event.clientX,
      initialTimelineMs: getTimelineTime(event.clientX),
      initialClipStartMs: clip.startMs,
      initialClipEndMs: clip.startMs + clip.durationMs,
      clipSnapshot: clip,
      prevEndMs,
      nextStartMs,
      moved: false,
      invalid: null,
      snapTargets: [...clipTargets, playheadSnapTarget(getPlayheadSnapshot())],
    }
    // activeGesture stays unset until the pointer actually drags — a plain
    // click must not flash the drag ring/cursor.
  }

  // phase "draft" renders + reports the HUD; "commit" re-runs the identical
  // snap/clamp path so the committed value equals the last draft shown.
  function applyGesture(clientX: number, altKey: boolean, phase: "draft" | "commit") {
    const gesture = gestureRef.current
    if (!gesture) return
    const currentMs = getTimelineTime(clientX)
    const deltaMs = currentMs - gesture.initialTimelineMs
    const snap = { enabled: snapEnabled && !altKey, thresholdMs: snapThresholdMs }
    const duration = gesture.initialClipEndMs - gesture.initialClipStartMs

    if (gesture.mode === "move") {
      const rawStartMs = Math.max(0, Math.round(gesture.initialClipStartMs + deltaMs))
      const snapped = snapClipStart(rawStartMs, duration, gesture.snapTargets, snap)
      onSnapGuide(snapped.snapped ? snapped.target : null)
      const invalid =
        !trackAllowsOverlap(track) &&
        !isMultiMove &&
        moveOverlaps(track, clip.id, snapped.timeMs, duration)
          ? "overlap"
          : null
      gesture.invalid = invalid
      if (phase === "draft") {
        onGestureHud({
          clipId: clip.id,
          trackId: track.id,
          mode: "move",
          originalStartMs: gesture.initialClipStartMs,
          originalEndMs: gesture.initialClipEndMs,
          startMs: snapped.timeMs,
          endMs: snapped.timeMs + duration,
          limit: null,
          invalid,
        })
      }
      // An invalid drop cancels silently — the HUD already explains why.
      onMoveClip(clip, track, snapped.timeMs, {
        phase: phase === "commit" && invalid ? "cancel" : phase,
      })
      return
    }

    const edge = gesture.mode === "trim-start" ? "start" : "end"
    const rawEdgeTimeMs =
      edge === "start"
        ? Math.max(0, Math.round(gesture.initialClipStartMs + deltaMs))
        : Math.max(0, Math.round(gesture.initialClipEndMs + deltaMs))
    const snapped = snapTrimEdge(edge, rawEdgeTimeMs, gesture.snapTargets, snap)
    onSnapGuide(snapped.snapped ? snapped.target : null)
    // Snap first, then clamp — a snap target past a limit must not win.
    const clamped = clampTrimEdge({
      edge,
      edgeMs: snapped.timeMs,
      clip: gesture.clipSnapshot,
      frameMs,
      prevEndMs: gesture.prevEndMs,
      nextStartMs: gesture.nextStartMs,
      sourceDurationMs,
    })
    if (phase === "draft") {
      setActiveLimit(clamped.limit)
      onGestureHud({
        clipId: clip.id,
        trackId: track.id,
        mode: gesture.mode,
        originalStartMs: gesture.initialClipStartMs,
        originalEndMs: gesture.initialClipEndMs,
        startMs: edge === "start" ? clamped.edgeMs : gesture.initialClipStartMs,
        endMs: edge === "end" ? clamped.edgeMs : gesture.initialClipEndMs,
        limit: clamped.limit,
        invalid: null,
      })
    }
    onTrimClip(clip, track, edge, clamped.edgeMs, { phase })
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    if (Math.abs(event.clientX - gesture.initialClientX) < 3 && !gesture.moved) return
    gesture.moved = true
    setActiveGesture(gesture.mode)
    suppressClickRef.current = true
    event.preventDefault()
    lastPointerRef.current = { clientX: event.clientX, altKey: event.altKey }
    applyGesture(event.clientX, event.altKey, "draft")
    // While the pointer hugs the viewport edge the scroll drives the gesture —
    // re-applying at the same clientX follows the time that scrolled under it.
    edgeAutoScroll.track(event.clientX, () => {
      const last = lastPointerRef.current
      if (last) applyGesture(last.clientX, last.altKey, "draft")
    })
  }

  function finishGesture(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const wasCancelled = event.type === "pointercancel"
    const didMove = gesture.moved
    gestureRef.current = null
    lastPointerRef.current = null
    edgeAutoScroll.stop()
    setActiveGesture(null)
    setActiveLimit(null)
    onGestureHud(null)
    onSnapGuide(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    if (wasCancelled || !didMove) {
      if (gesture.mode === "move") {
        onMoveClip(clip, track, gesture.initialClipStartMs, { phase: "cancel" })
      } else {
        const edge = gesture.mode === "trim-start" ? "start" : "end"
        const edgeTimeMs = edge === "start" ? gesture.initialClipStartMs : gesture.initialClipEndMs
        onTrimClip(clip, track, edge, edgeTimeMs, { phase: "cancel" })
      }
      return
    }

    applyGesture(event.clientX, event.altKey, "commit")
  }

  // Unmount mid-gesture (e.g. the clip scrolled out of the virtual window on a
  // lane the gesture overlay doesn't pin): stop the scroll loop and clear
  // lanes-level feedback so nothing lingers.
  const cleanupRef = useRef({ edgeAutoScroll, onGestureHud, onSnapGuide })
  cleanupRef.current = { edgeAutoScroll, onGestureHud, onSnapGuide }
  useEffect(
    () => () => {
      cleanupRef.current.edgeAutoScroll.stop()
      cleanupRef.current.onGestureHud(null)
      cleanupRef.current.onSnapGuide(null)
    },
    [],
  )

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open && !selected) {
          onSelectClip(clip, track, {
            shiftKey: false,
            ctrlKey: false,
            metaKey: false,
          } as unknown as React.MouseEvent)
        }
      }}
    >
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          data-timeline-clip
          aria-label={`${label}, starts ${formatTimelineTime(clip.startMs)}, ${formatDurationSeconds(clip.durationMs)}${isGrouped ? ", grouped" : ""}`}
          aria-description="Alt+Arrow to trim, Ctrl+Arrow to nudge"
          aria-pressed={selected}
          className={cn(
            "group/clip absolute flex items-center select-none overflow-hidden bg-lane/20 outline-none transition-[background-color,box-shadow,opacity] duration-fast ease-forge",
            RUN_CORNERS[runPosition],
            selected
              ? "z-20 bg-lane/35 ring-2 ring-inset ring-foreground"
              : "z-10 ring-1 ring-inset ring-lane/40 hover:bg-lane/28",
            activeGesture && "z-30 ring-2 ring-foreground shadow-e2",
            activeGesture === "move"
              ? "cursor-grabbing"
              : activeGesture
                ? "cursor-ew-resize"
                : tool === "split"
                  ? "cursor-crosshair"
                  : "cursor-grab",
            "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground",
            track.muted && "opacity-40 grayscale",
            isLocked && "cursor-not-allowed opacity-60",
            isDisabledRange && "opacity-50",
          )}
          style={{
            ...laneStyle(laneColorVar),
            left: `${clip.startMs * pixelsPerMs}px`,
            width: `${width}px`,
            height: `${clipHeight}px`,
            top: `${clipTop}px`,
          }}
          onPointerEnter={() => setIsHovered(true)}
          onPointerLeave={() => setIsHovered(false)}
          onPointerDown={(event) => {
            if (tool === "split") {
              if (event.button !== 0 || isLocked) return
              event.stopPropagation()
              event.preventDefault()
              const rawMs = getTimelineTime(event.clientX)
              const snap = snapTime(
                rawMs,
                [...clipTargets, playheadSnapTarget(getPlayheadSnapshot())],
                {
                  enabled: snapEnabled && !event.altKey,
                  thresholdMs: snapThresholdMs,
                },
              )
              const clipEndMs = clip.startMs + clip.durationMs
              let splitTimeMs = Math.round(rawMs)
              if (snap.snapped && snap.timeMs > clip.startMs + 1 && snap.timeMs < clipEndMs - 1) {
                splitTimeMs = snap.timeMs
              }
              if (splitTimeMs > clip.startMs + 1 && splitTimeMs < clipEndMs - 1) {
                onSeek?.(splitTimeMs)
                onSplitClip(clip, splitTimeMs)
              }
              return
            }
            if (
              event.target instanceof Element &&
              event.target.closest("[data-envelope-interactive]")
            ) {
              return
            }
            beginGesture(event, "move")
          }}
          onPointerMove={handlePointerMove}
          onPointerUp={finishGesture}
          onPointerCancel={finishGesture}
          onContextMenu={(event) => {
            const timeMs = getTimelineTime(event.clientX)
            setContextMenuTimeMs(timeMs)
            if (!selected) {
              onSelectClip(clip, track, event)
            }
          }}
          onClick={(event) => {
            if (tool === "split") {
              event.stopPropagation()
              return
            }
            if (
              event.target instanceof Element &&
              event.target.closest("[data-envelope-interactive]")
            ) {
              event.stopPropagation()
              return
            }
            event.stopPropagation()
            if (suppressClickRef.current) {
              suppressClickRef.current = false
              return
            }
            if (onSeek && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
              onSeek(Math.round(getTimelineTime(event.clientX)))
            }
            onSelectClip(clip, track, event)
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              event.stopPropagation()
              event.currentTarget.click()
              return
            }
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
            const direction = event.key === "ArrowLeft" ? -1 : 1
            if (event.altKey) {
              event.preventDefault()
              event.stopPropagation()
              const edge = event.shiftKey
                ? direction === -1
                  ? "end"
                  : "start"
                : direction === -1
                  ? "start"
                  : "end"
              const edgeTimeMs =
                edge === "start"
                  ? clip.startMs + direction * frameMs
                  : clip.startMs + clip.durationMs + direction * frameMs
              // Keyboard trims obey the same source/neighbor limits as drags.
              const clamped = clampTrimEdge({
                edge,
                edgeMs: edgeTimeMs,
                clip,
                frameMs,
                prevEndMs,
                nextStartMs,
                sourceDurationMs,
              })
              onTrimClip(clip, track, edge, clamped.edgeMs, { phase: "commit" })
              return
            }
            if (event.ctrlKey || event.metaKey) {
              event.preventDefault()
              event.stopPropagation()
              const nextStartMs = Math.max(
                0,
                clip.startMs + direction * (event.shiftKey ? 1_000 : frameMs),
              )
              onMoveClip(clip, track, nextStartMs, { phase: "commit" })
            }
          }}
        >
          {/* Filmstrip Thumbnails */}
          {thumbnailManifest && spriteUrl ? (
            <ThumbnailFilmstrip
              clip={clip}
              manifest={thumbnailManifest}
              spriteUrl={spriteUrl}
              pixelsPerMs={pixelsPerMs}
              visibleStartMs={visibleStartMs}
              visibleEndMs={visibleEndMs}
              height={clipHeight}
              onSpriteError={onSpriteError}
            />
          ) : null}

          {/* Waveform Silhouette */}
          {waveformData ? (
            <TimelineWaveform
              clip={clip}
              data={waveformData}
              pixelsPerMs={pixelsPerMs}
              visibleStartMs={visibleStartMs}
              visibleEndMs={visibleEndMs}
              height={clipHeight}
              colorVar={laneColorVar}
              gain={clip.kind === "audio" ? clip.volume * track.volume : 1}
            />
          ) : null}

          {/* Top Accent Bar */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-lane/80" />

          {/* Cut seam between clips inside a seamless run */}
          {(runPosition === "middle" || runPosition === "last") && width >= 6 ? (
            <div className="pointer-events-none absolute inset-y-0 left-0 w-px bg-background/70" />
          ) : null}

          {/* Disabled cursor range: dashed overlay reads "off" at a glance */}
          {isDisabledRange ? (
            <div className="pointer-events-none absolute inset-0 rounded-[inherit] border border-dashed border-foreground/50" />
          ) : null}

          {/* Start Trim Handle */}
          {showHandles ? (
            <TimelineEdgeHandle
              edge="start"
              hitWidth={hitWidth}
              visible={isHovered || selected || activeGesture === "trim-start"}
              active={activeGesture === "trim-start"}
              limited={activeGesture === "trim-start" && activeLimit !== null}
              onPointerDown={(e) => beginGesture(e, "trim-start")}
            />
          ) : null}

          {/* Audio volume envelope — interactive only near the cursor; the
              passive fade hint keeps fades legible otherwise. */}
          {clip.kind === "audio" ? (
            showEnvelope && onUpdateAudio ? (
              <TimelineAudioEnvelope
                clip={clip}
                pixelsPerMs={pixelsPerMs}
                height={clipHeight}
                trackVolume={track.volume}
                isLocked={isLocked}
                className="z-20"
                onUpdateAudio={(update) => onUpdateAudio(clip, update)}
                onInteractingChange={setEnvelopeActive}
              />
            ) : (
              <AudioFadeHint clip={clip} pixelsPerMs={pixelsPerMs} height={clipHeight} />
            )
          ) : null}

          {/* Per-clip label (clip-labelled lanes), level of detail by width */}
          {showLabel && width >= 20 ? (
            <div className="relative z-10 flex min-w-0 flex-1 items-center gap-1.5 px-2 pointer-events-none select-none">
              <ClipIcon className="size-3 shrink-0 text-foreground/80" aria-hidden />
              {width >= 40 ? (
                <>
                  <span className="truncate font-medium text-[11px] text-foreground drop-shadow-xs">
                    {label}
                  </span>
                  {width >= 96 ? (
                    <span className="shrink-0 font-mono text-[9px] font-semibold text-foreground/75 drop-shadow-xs">
                      {formatDurationSeconds(clip.durationMs)}
                    </span>
                  ) : null}
                  {clip.speed !== 1 && width >= 96 ? (
                    <span className="shrink-0 rounded bg-background/60 px-1 font-mono text-[9px] font-bold text-lane">
                      {clip.speed}×
                    </span>
                  ) : null}
                  {isLocked ? (
                    <Lock className="size-2.5 shrink-0 text-warning opacity-80" aria-hidden />
                  ) : null}
                  {isGrouped ? (
                    <Link2 className="size-2.5 shrink-0 text-lane opacity-90" aria-hidden />
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}

          {/* Run-labelled lanes keep the strip clean; a selected clip still
              surfaces its duration so trim feedback isn't lost. */}
          {!showLabel && selected && width >= 56 ? (
            <div className="pointer-events-none absolute right-1 top-1 z-10 rounded-sm bg-background/60 px-1 font-mono text-[9px] text-foreground backdrop-blur-sm">
              {formatDurationSeconds(clip.durationMs)}
            </div>
          ) : null}

          {/* End Trim Handle */}
          {showHandles ? (
            <TimelineEdgeHandle
              edge="end"
              hitWidth={hitWidth}
              visible={isHovered || selected || activeGesture === "trim-end"}
              active={activeGesture === "trim-end"}
              limited={activeGesture === "trim-end" && activeLimit !== null}
              onPointerDown={(e) => beginGesture(e, "trim-end")}
            />
          ) : null}
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent>
        {cursorRange && onCursorRangeAction ? (
          <>
            <ContextMenuItem
              onSelect={() =>
                onCursorRangeAction({ kind: "toggle-enabled", rangeId: cursorRange.id })
              }
            >
              {cursorRange.enabled ? "Hide cursor" : "Show cursor"}
            </ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger>Smoothing</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuRadioGroup
                  value={cursorRange.smoothing}
                  onValueChange={(value) =>
                    onCursorRangeAction({
                      kind: "set-smoothing",
                      rangeId: cursorRange.id,
                      smoothing: value as CursorSmoothing,
                    })
                  }
                >
                  <ContextMenuRadioItem value="smooth">Smooth</ContextMenuRadioItem>
                  <ContextMenuRadioItem value="off">Precise</ContextMenuRadioItem>
                </ContextMenuRadioGroup>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuItem
              onSelect={() => onCursorRangeAction({ kind: "toggle-lock", rangeId: cursorRange.id })}
            >
              {cursorRange.locked ? "Unlock range" : "Lock range"}
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        ) : null}
        <ContextMenuItem onSelect={() => onDuplicateClip(clip)} disabled={isLocked}>
          <Copy className="size-3.5 mr-2" /> Duplicate
        </ContextMenuItem>
        {onGroupClips || onUngroupClips ? (
          <>
            <ContextMenuItem onSelect={() => onGroupClips?.()} disabled={!canGroup || isLocked}>
              <Link2 className="size-3.5 mr-2" /> Group selection (Ctrl+G)
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onUngroupClips?.()} disabled={!canUngroup || isLocked}>
              <Link2Off className="size-3.5 mr-2" /> Ungroup (Ctrl+Shift+G)
            </ContextMenuItem>
          </>
        ) : null}
        <ClipSplitMenuItems
          clip={clip}
          contextMenuTimeMs={contextMenuTimeMs}
          isLocked={isLocked}
          onSplitClip={onSplitClip}
        />
        <ContextMenuSeparator />
        <ContextMenuItem
          className="text-destructive focus:bg-destructive/10 focus:text-destructive"
          onSelect={() => onDeleteClip(clip, false)}
          disabled={isLocked}
        >
          <Trash2 className="size-3.5 mr-2" /> Delete
        </ContextMenuItem>
        <ContextMenuItem
          className="text-destructive focus:bg-destructive/10 focus:text-destructive"
          onSelect={() => onDeleteClip(clip, true)}
          disabled={isLocked}
        >
          <Trash2 className="size-3.5 mr-2" /> Ripple Delete (Shift+Del)
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})

interface ClipSplitMenuItemsProps {
  clip: TimelineClip
  contextMenuTimeMs: number | null
  isLocked: boolean
  onSplitClip: (clip: TimelineClip, splitTimeMs?: number) => void
}

// The split items are the only playhead-dependent UI on a clip. Mounting them
// inside ContextMenuContent (which Radix renders only while open) keeps the
// per-frame playhead subscription off every resting clip item.
function ClipSplitMenuItems({
  clip,
  contextMenuTimeMs,
  isLocked,
  onSplitClip,
}: ClipSplitMenuItemsProps) {
  const playheadMs = usePlayheadMs()
  const isPlayheadInside =
    playheadMs > clip.startMs + 1 && playheadMs < clip.startMs + clip.durationMs - 1
  const isClickInside =
    contextMenuTimeMs !== null &&
    contextMenuTimeMs > clip.startMs + 1 &&
    contextMenuTimeMs < clip.startMs + clip.durationMs - 1

  return (
    <>
      {isPlayheadInside ? (
        <ContextMenuItem onSelect={() => onSplitClip(clip, playheadMs)} disabled={isLocked}>
          <Scissors className="size-3.5 mr-2" /> Split at playhead (
          {formatDurationSeconds(playheadMs)})
        </ContextMenuItem>
      ) : null}
      {isClickInside &&
      (!isPlayheadInside || Math.abs((contextMenuTimeMs ?? 0) - playheadMs) > 200) ? (
        <ContextMenuItem onSelect={() => onSplitClip(clip, contextMenuTimeMs!)} disabled={isLocked}>
          <Scissors className="size-3.5 mr-2" /> Split here (
          {formatDurationSeconds(contextMenuTimeMs!)})
        </ContextMenuItem>
      ) : null}
      {!isPlayheadInside && !isClickInside ? (
        <ContextMenuItem disabled>
          <Scissors className="size-3.5 mr-2" /> Split (playhead outside)
        </ContextMenuItem>
      ) : null}
    </>
  )
}
