import { memo, useRef, useState } from "react"
import type {
  AudioClip,
  AudioVolumeKeyframe,
  CursorSmoothing,
  TimelineClip,
  TimelineTrack,
} from "@recordforge/contracts"
import {
  AudioLines,
  Captions,
  Copy,
  FileImage,
  Lock,
  Monitor,
  MousePointer2,
  Music,
  Scissors,
  Shapes,
  ShieldAlert,
  Trash2,
  Type,
  Video,
  Volume2,
  type LucideIcon,
} from "lucide-react"
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
import { snapClipStart, snapTrimEdge, type SnapTarget } from "@recordforge/editor-core"
import type { ThumbnailManifest, WaveformResources } from "../media/derivative-resources"
import { ThumbnailStrip } from "./timeline-derivatives"
import { TimelineCanvasWaveform } from "./timeline-canvas-waveform"
import { TimelineAudioEnvelope } from "./timeline-audio-envelope"
import { formatTimelineTime } from "./timeline-ruler"
import type { CursorRangeAction } from "./timeline-lanes"

interface ClipGesture {
  pointerId: number
  mode: "move" | "trim-start" | "trim-end"
  initialClientX: number
  initialTimelineMs: number
  initialClipStartMs: number
  initialClipEndMs: number
  moved: boolean
}

export interface TimelineClipItemProps {
  clip: TimelineClip
  track: TimelineTrack
  height: number
  pixelsPerMs: number
  selected: boolean
  playheadMs: number
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
}

function getClipIcon(clip: TimelineClip, track: TimelineTrack): LucideIcon {
  if (clip.kind === "screen") return Monitor
  if (clip.kind === "camera") return Video
  if (clip.kind === "cursor-effect") return MousePointer2
  if (clip.kind === "caption") return Captions
  if (clip.kind === "mask") return ShieldAlert
  if (clip.kind === "annotation") return Shapes
  if (clip.kind === "text") return Type
  if (clip.kind === "image") return FileImage
  if (clip.kind === "audio" && clip.role === "music") return Music
  if (track.kind === "audio") return Volume2
  return AudioLines
}

function getClipTheme(
  clip: TimelineClip,
  track: TimelineTrack,
): {
  cardClass: string
  accentBorder: string
  handleGlow: string
} {
  if (clip.kind === "annotation" || track.kind === "annotations") {
    return {
      cardClass:
        "border-fuchsia-500/70 bg-gradient-to-b from-fuchsia-500/25 to-fuchsia-500/10 hover:from-fuchsia-500/35 hover:to-fuchsia-500/15 shadow-fuchsia-500/10",
      accentBorder: "border-fuchsia-500",
      handleGlow: "bg-fuchsia-500 text-black",
    }
  }
  if (clip.kind === "text" || track.kind === "titles") {
    return {
      cardClass:
        "border-amber-500/70 bg-gradient-to-b from-amber-500/25 to-amber-500/10 hover:from-amber-500/35 hover:to-amber-500/15 shadow-amber-500/10",
      accentBorder: "border-amber-500",
      handleGlow: "bg-amber-500 text-black",
    }
  }
  if (clip.kind === "image" || track.kind === "graphics") {
    return {
      cardClass:
        "border-cyan-500/70 bg-gradient-to-b from-cyan-500/25 to-cyan-500/10 hover:from-cyan-500/35 hover:to-cyan-500/15 shadow-cyan-500/10",
      accentBorder: "border-cyan-500",
      handleGlow: "bg-cyan-500 text-black",
    }
  }
  if (track.kind === "screen") {
    return {
      cardClass:
        "border-track-screen/70 bg-gradient-to-b from-track-screen/25 to-track-screen/10 hover:from-track-screen/35 hover:to-track-screen/15 shadow-track-screen/10",
      accentBorder: "border-track-screen",
      handleGlow: "bg-track-screen text-black",
    }
  }
  if (track.kind === "camera") {
    return {
      cardClass:
        "border-track-webcam/70 bg-gradient-to-b from-track-webcam/25 to-track-webcam/10 hover:from-track-webcam/35 hover:to-track-webcam/15 shadow-track-webcam/10",
      accentBorder: "border-track-webcam",
      handleGlow: "bg-track-webcam text-black",
    }
  }
  if (track.kind === "cursor") {
    return {
      cardClass:
        "border-primary/70 bg-gradient-to-b from-primary/25 to-primary/10 hover:from-primary/35 hover:to-primary/15 shadow-primary/10",
      accentBorder: "border-primary",
      handleGlow: "bg-primary text-white",
    }
  }
  if (track.kind === "captions") {
    return {
      cardClass:
        "border-track-captions/70 bg-gradient-to-b from-track-captions/25 to-track-captions/10 hover:from-track-captions/35 hover:to-track-captions/15 shadow-track-captions/10",
      accentBorder: "border-track-captions",
      handleGlow: "bg-track-captions text-black",
    }
  }
  if (track.kind === "effects") {
    return {
      cardClass:
        "border-warning/70 bg-gradient-to-b from-warning/25 to-warning/10 hover:from-warning/35 hover:to-warning/15 shadow-warning/10",
      accentBorder: "border-warning",
      handleGlow: "bg-warning text-black",
    }
  }
  if (track.name.toLowerCase().includes("system")) {
    return {
      cardClass:
        "border-track-system/70 bg-gradient-to-b from-track-system/25 to-track-system/10 hover:from-track-system/35 hover:to-track-system/15 shadow-track-system/10",
      accentBorder: "border-track-system",
      handleGlow: "bg-track-system text-black",
    }
  }
  return {
    cardClass:
      "border-track-mic/70 bg-gradient-to-b from-track-mic/25 to-track-mic/10 hover:from-track-mic/35 hover:to-track-mic/15 shadow-track-mic/10",
    accentBorder: "border-track-mic",
    handleGlow: "bg-track-mic text-black",
  }
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

export const TimelineClipItem = memo(function TimelineClipItem({
  clip,
  track,
  height,
  pixelsPerMs,
  selected,
  playheadMs,
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
  onCursorRangeAction,
  onUpdateAudio,
}: TimelineClipItemProps) {
  const gestureRef = useRef<ClipGesture | null>(null)
  const suppressClickRef = useRef(false)
  const [gestureDelta, setGestureDelta] = useState<{ text: string; mode: string } | null>(null)
  const [contextMenuTimeMs, setContextMenuTimeMs] = useState<number | null>(null)

  const waveformResource =
    clip.kind === "audio" ? waveformResources.byStream.get(clip.streamIndex ?? -1) : undefined
  const waveformData = waveformResource?.status === "content" ? waveformResource.data : null
  const clipTargets = snapTargets.filter((target) => !target.id.startsWith(`${clip.id}:`))
  const clipHeight = collapsed ? 24 : Math.max(34, Math.min(height - 14, 44))
  const cursorRange = clip.kind === "cursor-effect" ? clip : null
  const isLocked = track.locked || (cursorRange ? cursorRange.locked : false)

  const isPlayheadInside =
    playheadMs > clip.startMs + 1 && playheadMs < clip.startMs + clip.durationMs - 1
  const isClickInside =
    contextMenuTimeMs !== null &&
    contextMenuTimeMs > clip.startMs + 1 &&
    contextMenuTimeMs < clip.startMs + clip.durationMs - 1

  const ClipIcon = getClipIcon(clip, track)
  const theme = getClipTheme(clip, track)

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
      moved: false,
    }
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const currentMs = getTimelineTime(event.clientX)
    const deltaMs = currentMs - gesture.initialTimelineMs
    if (Math.abs(event.clientX - gesture.initialClientX) < 3 && !gesture.moved) return
    gesture.moved = true
    suppressClickRef.current = true
    event.preventDefault()

    const snap = { enabled: snapEnabled && !event.altKey, thresholdMs: snapThresholdMs }

    if (gesture.mode === "move") {
      const duration = gesture.initialClipEndMs - gesture.initialClipStartMs
      const rawStartMs = Math.max(0, Math.round(gesture.initialClipStartMs + deltaMs))
      const snapped = snapClipStart(rawStartMs, duration, clipTargets, snap)
      onSnapGuide(snapped.snapped ? snapped.target : null)
      setGestureDelta({
        mode: "Move",
        text: `${formatTimelineTime(snapped.timeMs)} (${deltaMs >= 0 ? "+" : ""}${(deltaMs / 1000).toFixed(2)}s)`,
      })
      onMoveClip(clip, track, snapped.timeMs, { phase: "draft" })
      return
    }

    const edge = gesture.mode === "trim-start" ? "start" : "end"
    const rawEdgeTimeMs =
      edge === "start"
        ? Math.max(0, Math.round(gesture.initialClipStartMs + deltaMs))
        : Math.max(0, Math.round(gesture.initialClipEndMs + deltaMs))
    const snapped = snapTrimEdge(edge, rawEdgeTimeMs, clipTargets, snap)
    onSnapGuide(snapped.snapped ? snapped.target : null)
    setGestureDelta({
      mode: edge === "start" ? "Trim In" : "Trim Out",
      text: `${formatTimelineTime(snapped.timeMs)} (${deltaMs >= 0 ? "+" : ""}${(deltaMs / 1000).toFixed(2)}s)`,
    })
    onTrimClip(clip, track, edge, snapped.timeMs, { phase: "draft" })
  }

  function finishGesture(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const wasCancelled = event.type === "pointercancel"
    const didMove = gesture.moved
    gestureRef.current = null
    setGestureDelta(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    if (wasCancelled || !didMove) {
      onSnapGuide(null)
      if (gesture.mode === "move") {
        onMoveClip(clip, track, gesture.initialClipStartMs, { phase: "cancel" })
      } else {
        const edge = gesture.mode === "trim-start" ? "start" : "end"
        const edgeTimeMs = edge === "start" ? gesture.initialClipStartMs : gesture.initialClipEndMs
        onTrimClip(clip, track, edge, edgeTimeMs, { phase: "cancel" })
      }
      return
    }

    const currentMs = getTimelineTime(event.clientX)
    const deltaMs = currentMs - gesture.initialTimelineMs
    const snap = { enabled: snapEnabled && !event.altKey, thresholdMs: snapThresholdMs }

    if (gesture.mode === "move") {
      const duration = gesture.initialClipEndMs - gesture.initialClipStartMs
      const rawStartMs = Math.max(0, Math.round(gesture.initialClipStartMs + deltaMs))
      const snapped = snapClipStart(rawStartMs, duration, clipTargets, snap)
      onSnapGuide(null)
      onMoveClip(clip, track, snapped.timeMs, { phase: "commit" })
      return
    }

    const edge = gesture.mode === "trim-start" ? "start" : "end"
    const rawEdgeTimeMs =
      edge === "start"
        ? Math.max(0, Math.round(gesture.initialClipStartMs + deltaMs))
        : Math.max(0, Math.round(gesture.initialClipEndMs + deltaMs))
    const snapped = snapTrimEdge(edge, rawEdgeTimeMs, clipTargets, snap)
    onSnapGuide(null)
    onTrimClip(clip, track, edge, snapped.timeMs, { phase: "commit" })
  }

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
          aria-label={`${getClipLabel(clip, track)}`}
          aria-pressed={selected}
          className={cn(
            "group/clip absolute flex min-w-8 items-center overflow-hidden rounded-lg border text-left shadow-xs transition-all duration-fast select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
            tool === "split" ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing",
            theme.cardClass,
            selected
              ? "ring-2 ring-primary ring-offset-1 ring-offset-surface-dim shadow-[0_0_12px_rgba(9,77,178,0.45)] z-20"
              : "z-10",
            track.muted && "opacity-40",
            isLocked && "cursor-not-allowed opacity-60",
          )}
          style={{
            left: `${clip.startMs * pixelsPerMs}px`,
            width: `${Math.max(clip.durationMs * pixelsPerMs, 32)}px`,
            height: `${clipHeight}px`,
          }}
          onPointerDown={(event) => {
            if (tool === "split") {
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
              onTrimClip(clip, track, edge, edgeTimeMs, { phase: "commit" })
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
          {/* Top Accent Strip */}
          <div className={cn("absolute inset-x-0 top-0 h-0.5 opacity-80", theme.handleGlow)} />

          {/* Start Trim Handle (Tactile Bracket) */}
          {!isLocked && tool !== "split" ? (
            <div
              className="group/handle-start absolute left-0 inset-y-0 z-30 flex w-3 cursor-col-resize items-center justify-start opacity-0 transition-all duration-fast group-hover/clip:opacity-100 hover:opacity-100"
              onPointerDown={(e) => beginGesture(e, "trim-start")}
              onClick={(e) => e.stopPropagation()}
              title="Drag to trim start (In-point)"
            >
              <div className="flex h-full w-2 items-center justify-center rounded-l-md border-y border-l border-primary/90 bg-primary/40 backdrop-blur-xs transition-colors group-hover/handle-start:bg-primary/80 shadow-xs">
                <div className="flex flex-col gap-0.5">
                  <div className="h-0.5 w-1 rounded-full bg-white/90" />
                  <div className="h-0.5 w-1 rounded-full bg-white/90" />
                  <div className="h-0.5 w-1 rounded-full bg-white/90" />
                </div>
              </div>
            </div>
          ) : null}

          {/* Filmstrip Thumbnails */}
          {thumbnailManifest && spriteUrl ? (
            <ThumbnailStrip
              clip={clip}
              manifest={thumbnailManifest}
              spriteUrl={spriteUrl}
              pixelsPerMs={pixelsPerMs}
              visibleStartMs={visibleStartMs}
              visibleEndMs={visibleEndMs}
              onSpriteError={onSpriteError}
            />
          ) : null}

          {/* High-Performance Canvas Waveforms */}
          {waveformData ? (
            <TimelineCanvasWaveform
              clip={clip}
              data={waveformData}
              pixelsPerMs={pixelsPerMs}
              visibleStartMs={visibleStartMs}
              visibleEndMs={visibleEndMs}
            />
          ) : null}

          {/* Interactive Audio Volume Envelope Curve Overlay */}
          {clip.kind === "audio" && onUpdateAudio && !collapsed ? (
            <TimelineAudioEnvelope
              clip={clip}
              pixelsPerMs={pixelsPerMs}
              height={clipHeight}
              isLocked={isLocked}
              className="z-20"
              onUpdateAudio={(update) => onUpdateAudio(clip, update)}
            />
          ) : null}

          {/* Clip Header Details */}
          <div className="relative z-10 flex min-w-0 flex-1 items-center gap-1.5 px-2 pointer-events-none select-none">
            <ClipIcon className="size-3 shrink-0 opacity-80" aria-hidden />
            <span className="truncate font-medium text-[11px] text-foreground drop-shadow-xs">
              {getClipLabel(clip, track)}
            </span>
            <span className="shrink-0 font-mono text-[9px] font-semibold text-foreground/75 drop-shadow-xs">
              {formatDurationSeconds(clip.durationMs)}
            </span>
            {clip.speed !== 1 ? (
              <span className="shrink-0 rounded bg-black/40 px-1 font-mono text-[9px] font-bold text-primary">
                {clip.speed}×
              </span>
            ) : null}
            {isLocked ? (
              <Lock className="size-2.5 shrink-0 text-warning opacity-80" aria-hidden />
            ) : null}
          </div>

          {/* End Trim Handle (Tactile Bracket) */}
          {!isLocked && tool !== "split" ? (
            <div
              className="group/handle-end absolute right-0 inset-y-0 z-30 flex w-3 cursor-col-resize items-center justify-end opacity-0 transition-all duration-fast group-hover/clip:opacity-100 hover:opacity-100"
              onPointerDown={(e) => beginGesture(e, "trim-end")}
              onClick={(e) => e.stopPropagation()}
              title="Drag to trim end (Out-point)"
            >
              <div className="flex h-full w-2 items-center justify-center rounded-r-md border-y border-r border-primary/90 bg-primary/40 backdrop-blur-xs transition-colors group-hover/handle-end:bg-primary/80 shadow-xs">
                <div className="flex flex-col gap-0.5">
                  <div className="h-0.5 w-1 rounded-full bg-white/90" />
                  <div className="h-0.5 w-1 rounded-full bg-white/90" />
                  <div className="h-0.5 w-1 rounded-full bg-white/90" />
                </div>
              </div>
            </div>
          ) : null}

          {/* Live Drag/Trim Floating HUD Pill */}
          {gestureDelta ? (
            <div className="absolute -top-7.5 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1.5 rounded-full border border-primary/90 bg-surface/95 px-2 py-0.5 font-mono text-[10px] font-semibold text-foreground shadow-e3 backdrop-blur-md whitespace-nowrap animate-in fade-in zoom-in-95">
              <span className="text-primary font-bold">{gestureDelta.mode}</span>
              <span className="text-subtle-foreground">·</span>
              <span className="tabular-nums">{gestureDelta.text}</span>
            </div>
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
        {isPlayheadInside ? (
          <ContextMenuItem onSelect={() => onSplitClip(clip, playheadMs)} disabled={isLocked}>
            <Scissors className="size-3.5 mr-2" /> Split at playhead (
            {formatDurationSeconds(playheadMs)})
          </ContextMenuItem>
        ) : null}
        {isClickInside &&
        (!isPlayheadInside || Math.abs((contextMenuTimeMs ?? 0) - playheadMs) > 200) ? (
          <ContextMenuItem
            onSelect={() => onSplitClip(clip, contextMenuTimeMs!)}
            disabled={isLocked}
          >
            <Scissors className="size-3.5 mr-2" /> Split here (
            {formatDurationSeconds(contextMenuTimeMs!)})
          </ContextMenuItem>
        ) : null}
        {!isPlayheadInside && !isClickInside ? (
          <ContextMenuItem disabled>
            <Scissors className="size-3.5 mr-2" /> Split (playhead outside)
          </ContextMenuItem>
        ) : null}
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
