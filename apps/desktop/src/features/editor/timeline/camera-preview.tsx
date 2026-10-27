import { useEffect, useMemo, useRef, useState } from "react"
import type {
  CameraClip,
  ClipTransform,
  MediaVideoTrackOutput,
  TimelineClip,
} from "@recordforge/contracts"
import { buildPreviewSegments, type PreviewSegment } from "@recordforge/editor-core"
import { cn } from "@recordforge/ui"
import { Circle, Square } from "lucide-react"
import { toAssetUrl } from "../media/derivative-resources"
import { useDualMediaSlots } from "./playback/use-dual-media-slots"
import { usePlayheadMs } from "./use-playback-state"

interface CameraPreviewProps {
  clips: CameraClip[]
  outputs: MediaVideoTrackOutput[]
  workDir?: string | null
  isPlaying: boolean
  playbackRate: number
  frameMs: number
  canvasWidth: number
  canvasHeight: number
  selectedClipId?: string | null
  onSelectClip?: (clipId: string) => void
  onUpdateTransform?: (
    clipId: string,
    transform: ClipTransform,
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
}

interface CameraGesture {
  clipId: string
  pointerId: number
  mode: "move" | "resize"
  handle?: "nw" | "ne" | "se" | "sw"
  startX: number
  startY: number
  transform: ClipTransform
  moved: boolean
}

interface CameraStreamGroup {
  streamIndex: number
  clips: CameraClip[]
  source: string | null
  width?: number
  height?: number
}

function isClipActive(clip: CameraClip, playheadMs: number): boolean {
  return playheadMs >= clip.startMs && playheadMs < clip.startMs + clip.durationMs
}

function mixBorderColor(color: string | undefined, opacity: number | undefined): string {
  const source = color ?? "var(--color-foreground)"
  const alpha = Math.max(0, Math.min(1, opacity ?? 1))
  return `color-mix(in srgb, ${source} ${Math.round(alpha * 100)}%, transparent)`
}

function buildCameraGroups(
  clips: CameraClip[],
  outputs: MediaVideoTrackOutput[],
  workDir?: string | null,
): CameraStreamGroup[] {
  const outputsByStream = new Map(outputs.map((output) => [output.streamIndex, output]))
  const groups = new Map<number, CameraStreamGroup>()
  for (const clip of clips) {
    const streamIndex = clip.streamIndex ?? -1
    const existing = groups.get(streamIndex)
    if (existing) {
      existing.clips.push(clip)
      continue
    }
    const output = outputsByStream.get(streamIndex)
    const source = output ? toAssetUrl(output.videoPath, workDir) : null
    groups.set(streamIndex, {
      streamIndex,
      clips: [clip],
      source,
      width: output?.width,
      height: output?.height,
    })
  }
  return [...groups.values()].filter((group) => group.source)
}

function computeNextCameraTransform(
  gesture: CameraGesture,
  deltaX: number,
  deltaY: number,
  canvasWidth: number,
  _canvasHeight: number,
): ClipTransform {
  if (gesture.mode === "resize") {
    const handle = gesture.handle ?? "se"
    const aspect = gesture.transform.width / Math.max(1, gesture.transform.height)

    if (handle === "se") {
      const scaleDelta = Math.max(deltaX, deltaY * aspect)
      const nextW = Math.max(80, Math.min(canvasWidth, gesture.transform.width + scaleDelta))
      const nextH = Math.round(nextW / aspect)
      return {
        ...gesture.transform,
        width: Math.round(nextW),
        height: nextH,
        preset: undefined,
      }
    }
    if (handle === "nw") {
      const scaleDelta = Math.max(-deltaX, -deltaY * aspect)
      const nextW = Math.max(80, Math.min(canvasWidth, gesture.transform.width + scaleDelta))
      const nextH = Math.round(nextW / aspect)
      const nextX = gesture.transform.x + (gesture.transform.width - nextW)
      const nextY = gesture.transform.y + (gesture.transform.height - nextH)
      return {
        ...gesture.transform,
        x: Math.round(nextX),
        y: Math.round(nextY),
        width: Math.round(nextW),
        height: nextH,
        preset: undefined,
      }
    }
    if (handle === "ne") {
      const scaleDelta = Math.max(deltaX, -deltaY * aspect)
      const nextW = Math.max(80, Math.min(canvasWidth, gesture.transform.width + scaleDelta))
      const nextH = Math.round(nextW / aspect)
      const nextY = gesture.transform.y + (gesture.transform.height - nextH)
      return {
        ...gesture.transform,
        y: Math.round(nextY),
        width: Math.round(nextW),
        height: nextH,
        preset: undefined,
      }
    }
    // "sw"
    const scaleDelta = Math.max(-deltaX, deltaY * aspect)
    const nextW = Math.max(80, Math.min(canvasWidth, gesture.transform.width + scaleDelta))
    const nextH = Math.round(nextW / aspect)
    const nextX = gesture.transform.x + (gesture.transform.width - nextW)
    return {
      ...gesture.transform,
      x: Math.round(nextX),
      width: Math.round(nextW),
      height: nextH,
      preset: undefined,
    }
  }

  return {
    ...gesture.transform,
    x: Math.round(gesture.transform.x + deltaX),
    y: Math.round(gesture.transform.y + deltaY),
    preset: undefined,
    locked: false,
  }
}

interface CameraStreamSurfaceProps {
  group: CameraStreamGroup
  isPlaying: boolean
  playbackRate: number
  frameMs: number
  canvasWidth: number
  canvasHeight: number
  selectedClipId?: string | null
  onSelectClip?: (clipId: string) => void
  onUpdateTransform?: CameraPreviewProps["onUpdateTransform"]
}

/**
 * One camera stream on a pair of media elements. Position, shape, crop, and
 * border follow the active clip; only the active clip receives gestures and
 * selection even though Smart Cut may have spliced it into hundreds of pieces.
 */
function CameraStreamSurface({
  group,
  isPlaying,
  playbackRate,
  frameMs,
  canvasWidth,
  canvasHeight,
  selectedClipId,
  onSelectClip,
  onUpdateTransform,
}: CameraStreamSurfaceProps) {
  const playheadMs = usePlayheadMs()
  const slot0 = useRef<HTMLVideoElement>(null)
  const slot1 = useRef<HTMLVideoElement>(null)
  const slots = useMemo(
    () =>
      [slot0, slot1] as [
        React.RefObject<HTMLVideoElement | null>,
        React.RefObject<HTMLVideoElement | null>,
      ],
    [],
  )
  const gestureRef = useRef<CameraGesture | null>(null)
  const [naturalDimensions, setNaturalDimensions] = useState<{
    width: number
    height: number
  } | null>(null)
  const segments = useMemo(
    () =>
      group.source
        ? buildPreviewSegments(group.clips as TimelineClip[], () => group.source ?? "")
        : [],
    [group.clips, group.source],
  )

  const { activeSlot } = useDualMediaSlots({
    segments,
    playheadMs,
    isPlaying,
    playbackRate,
    frameMs,
    kind: "camera",
    enabled: Boolean(group.source) && segments.length > 0,
    slots,
    sourceUrlOf: () => group.source,
    onSync: (_slot, _segment: PreviewSegment | null, element) => {
      element.muted = true
    },
  })

  useEffect(() => {
    const cleanups: (() => void)[] = []
    for (const element of [slot0.current, slot1.current]) {
      if (!element) continue
      const update = () => {
        if (element.videoWidth > 0 && element.videoHeight > 0) {
          setNaturalDimensions({ width: element.videoWidth, height: element.videoHeight })
        }
      }
      element.addEventListener("loadedmetadata", update)
      update()
      cleanups.push(() => element.removeEventListener("loadedmetadata", update))
    }
    return () => {
      for (const cleanup of cleanups) cleanup()
    }
  }, [])

  const activeClip =
    group.clips.find(
      (clip) => isClipActive(clip, playheadMs) && clip.transform.visible !== false,
    ) ?? null
  const transform = activeClip?.transform ?? group.clips[0]?.transform
  if (!transform) return null
  const isActive = activeClip !== null
  const isLocked = transform.locked === true
  const isSelected = activeClip !== null && selectedClipId === activeClip.id
  const radius = transform.shape === "circle" ? "50%" : transform.shape === "rounded" ? "12%" : 0
  const crop = transform.crop
  const sourceWidth = group.width ?? naturalDimensions?.width ?? crop?.width ?? canvasWidth
  const sourceHeight = group.height ?? naturalDimensions?.height ?? crop?.height ?? canvasHeight
  const cropWidth = crop?.width ?? sourceWidth
  const cropHeight = crop?.height ?? sourceHeight
  const cropLeft = crop ? -(crop.x / cropWidth) * 100 : 0
  const cropTop = crop ? -(crop.y / cropHeight) * 100 : 0
  const cropVideoWidth = crop ? (sourceWidth / cropWidth) * 100 : 100
  const cropVideoHeight = crop ? (sourceHeight / cropHeight) * 100 : 100
  const borderColor = mixBorderColor(transform.borderColor, transform.borderOpacity)

  function beginDrag(
    event: React.PointerEvent<HTMLDivElement>,
    mode: CameraGesture["mode"] = "move",
    handle?: CameraGesture["handle"],
  ) {
    if (!activeClip) return
    onSelectClip?.(activeClip.id)
    if (!onUpdateTransform || event.button !== 0 || transform.locked) return
    event.stopPropagation()
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureRef.current = {
      clipId: activeClip.id,
      pointerId: event.pointerId,
      mode,
      handle,
      startX: event.clientX,
      startY: event.clientY,
      transform,
      moved: false,
    }
  }

  function moveDrag(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId || !onUpdateTransform) return
    const canvasElement = event.currentTarget.parentElement
    const dx =
      ((event.clientX - gesture.startX) / Math.max(1, canvasElement?.clientWidth ?? 1)) *
      canvasWidth
    const dy =
      ((event.clientY - gesture.startY) / Math.max(1, canvasElement?.clientHeight ?? 1)) *
      canvasHeight
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && !gesture.moved) return
    gesture.moved = true
    event.preventDefault()
    const next = computeNextCameraTransform(gesture, dx, dy, canvasWidth, canvasHeight)
    onUpdateTransform(gesture.clipId, next, { phase: "draft" })
  }

  function finishDrag(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const wasCancelled = event.type === "pointercancel"
    const didMove = gesture.moved
    gestureRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!onUpdateTransform) return

    if (wasCancelled || !didMove) {
      onUpdateTransform(gesture.clipId, gesture.transform, { phase: "cancel" })
      return
    }

    const canvasElement = event.currentTarget.parentElement
    const dx =
      ((event.clientX - gesture.startX) / Math.max(1, canvasElement?.clientWidth ?? 1)) *
      canvasWidth
    const dy =
      ((event.clientY - gesture.startY) / Math.max(1, canvasElement?.clientHeight ?? 1)) *
      canvasHeight
    const next = computeNextCameraTransform(gesture, dx, dy, canvasWidth, canvasHeight)
    onUpdateTransform(gesture.clipId, next, { phase: "commit" })
  }

  const handleSnapPreset = (position: "TL" | "TR" | "BL" | "BR") => {
    if (!onUpdateTransform || !activeClip) return
    const margin = 32
    const w = transform.width
    const h = transform.height
    let x = margin
    let y = margin
    if (position === "TR") {
      x = canvasWidth - w - margin
    } else if (position === "BL") {
      y = canvasHeight - h - margin
    } else if (position === "BR") {
      x = canvasWidth - w - margin
      y = canvasHeight - h - margin
    }
    onUpdateTransform(
      activeClip.id,
      {
        ...transform,
        x: Math.max(0, x),
        y: Math.max(0, y),
        preset: undefined,
      },
      { phase: "commit" },
    )
  }

  const handleSetShape = (shape: "circle" | "rounded" | "rectangle") => {
    if (!onUpdateTransform || !activeClip) return
    onUpdateTransform(
      activeClip.id,
      {
        ...transform,
        shape,
      },
      { phase: "commit" },
    )
  }

  return (
    <div
      role="button"
      tabIndex={isActive ? 0 : -1}
      aria-label={
        isLocked ? "Camera overlay, select to edit" : "Camera overlay, drag to move or resize"
      }
      aria-hidden={!isActive}
      aria-disabled={false}
      className={cn(
        "group absolute z-30 overflow-visible",
        isActive && (isLocked ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"),
        "focus-visible:outline-none",
      )}
      style={{
        left: `${(transform.x / canvasWidth) * 100}%`,
        top: `${(transform.y / canvasHeight) * 100}%`,
        width: `${(transform.width / canvasWidth) * 100}%`,
        height: `${(transform.height / canvasHeight) * 100}%`,
        opacity: isActive ? transform.opacity : 0,
        pointerEvents: isActive ? "auto" : "none",
      }}
      onClick={() => {
        if (activeClip) onSelectClip?.(activeClip.id)
      }}
      onKeyDown={(event) => {
        if (!onUpdateTransform || !activeClip || isLocked || gestureRef.current) return
        const step = event.shiftKey ? 10 : 1
        const delta =
          event.key === "ArrowLeft"
            ? { x: -step, y: 0 }
            : event.key === "ArrowRight"
              ? { x: step, y: 0 }
              : event.key === "ArrowUp"
                ? { x: 0, y: -step }
                : event.key === "ArrowDown"
                  ? { x: 0, y: step }
                  : null
        if (!delta) return
        event.preventDefault()
        onUpdateTransform(
          activeClip.id,
          {
            ...transform,
            x: transform.x + delta.x,
            y: transform.y + delta.y,
            preset: undefined,
            locked: false,
          },
          { phase: "commit" },
        )
      }}
      onPointerDown={(event) => beginDrag(event, "move")}
      onPointerMove={moveDrag}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
    >
      {/* Camera Video Surface — two slots, one visible at a time. */}
      <div
        className="relative size-full overflow-hidden"
        style={{
          borderRadius: radius,
          border: transform.borderWidth
            ? `${transform.borderWidth}px solid ${borderColor}`
            : undefined,
          boxShadow: transform.shadowEnabled
            ? `${transform.shadowOffsetX ?? 0}px ${transform.shadowOffsetY ?? 4}px ${transform.shadowBlur ?? 12}px ${transform.shadowColor ?? "var(--color-pip-shadow)"}`
            : undefined,
        }}
      >
        <video
          ref={slot0}
          muted
          playsInline
          preload="auto"
          className={cn(
            "pointer-events-none absolute max-h-none max-w-none",
            crop ? "object-fill" : "object-cover",
          )}
          style={{
            left: `${cropLeft}%`,
            top: `${cropTop}%`,
            width: `${cropVideoWidth}%`,
            height: `${cropVideoHeight}%`,
            visibility: activeSlot === 0 ? "visible" : "hidden",
          }}
        />
        <video
          ref={slot1}
          muted
          playsInline
          preload="auto"
          className={cn(
            "pointer-events-none absolute max-h-none max-w-none",
            crop ? "object-fill" : "object-cover",
          )}
          style={{
            left: `${cropLeft}%`,
            top: `${cropTop}%`,
            width: `${cropVideoWidth}%`,
            height: `${cropVideoHeight}%`,
            visibility: activeSlot === 1 ? "visible" : "hidden",
          }}
        />
      </div>

      {/* Selection Ring & On-Canvas Direct Manipulation Handles */}
      {isSelected && activeClip && (
        <div className="pointer-events-none absolute inset-0 rounded-[inherit] ring-2 ring-primary ring-offset-1 ring-offset-background/40" />
      )}

      {isSelected && activeClip && !isLocked && onUpdateTransform ? (
        <>
          {/* 4 Corner Resize Handles */}
          <div
            role="button"
            tabIndex={0}
            aria-label="Resize camera northwest"
            className="absolute -top-1.5 -left-1.5 z-40 size-3 cursor-nwse-resize rounded-full border-2 border-primary bg-background shadow-e2"
            onPointerDown={(e) => beginDrag(e, "resize", "nw")}
            onClick={(e) => e.stopPropagation()}
          />
          <div
            role="button"
            tabIndex={0}
            aria-label="Resize camera northeast"
            className="absolute -top-1.5 -right-1.5 z-40 size-3 cursor-nesw-resize rounded-full border-2 border-primary bg-background shadow-e2"
            onPointerDown={(e) => beginDrag(e, "resize", "ne")}
            onClick={(e) => e.stopPropagation()}
          />
          <div
            role="button"
            tabIndex={0}
            aria-label="Resize camera southwest"
            className="absolute -bottom-1.5 -left-1.5 z-40 size-3 cursor-nesw-resize rounded-full border-2 border-primary bg-background shadow-e2"
            onPointerDown={(e) => beginDrag(e, "resize", "sw")}
            onClick={(e) => e.stopPropagation()}
          />
          <div
            role="button"
            tabIndex={0}
            aria-label="Resize camera southeast"
            className="absolute -bottom-1.5 -right-1.5 z-40 size-3 cursor-nwse-resize rounded-full border-2 border-primary bg-background shadow-e2"
            onPointerDown={(e) => beginDrag(e, "resize", "se")}
            onClick={(e) => e.stopPropagation()}
          />

          {/* Floating Direct Action Toolbar */}
          <div
            className="absolute -top-8 left-1/2 -translate-x-1/2 z-40 flex items-center gap-1 rounded-full border border-border/80 bg-background/90 px-2 py-0.5 shadow-e3 backdrop-blur-md"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {/* Shape Switchers */}
            <button
              type="button"
              title="Circle Shape"
              aria-label="Circle Shape"
              onClick={() => handleSetShape("circle")}
              className={cn(
                "flex size-5 items-center justify-center rounded transition-colors",
                transform.shape === "circle"
                  ? "bg-primary text-primary-foreground font-bold"
                  : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
              )}
            >
              <Circle className="size-2.5" aria-hidden />
            </button>
            <button
              type="button"
              title="Rounded Shape"
              aria-label="Rounded Shape"
              onClick={() => handleSetShape("rounded")}
              className={cn(
                "flex size-5 items-center justify-center rounded transition-colors",
                transform.shape === "rounded"
                  ? "bg-primary text-primary-foreground font-bold"
                  : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
              )}
            >
              <Square className="size-2.5 rounded-xs" aria-hidden />
            </button>
            <button
              type="button"
              title="Rectangle Shape"
              aria-label="Rectangle Shape"
              onClick={() => handleSetShape("rectangle")}
              className={cn(
                "flex size-5 items-center justify-center rounded transition-colors",
                transform.shape === "rectangle"
                  ? "bg-primary text-primary-foreground font-bold"
                  : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
              )}
            >
              <Square className="size-2.5" aria-hidden />
            </button>

            <div className="h-3 w-px bg-border/80 mx-0.5" aria-hidden />

            {/* Corner Snap Buttons */}
            <button
              type="button"
              title="Snap Top-Left"
              onClick={() => handleSnapPreset("TL")}
              className="px-1 py-0.5 font-mono text-[9px] font-semibold text-muted-foreground hover:bg-surface-hover hover:text-foreground rounded"
            >
              TL
            </button>
            <button
              type="button"
              title="Snap Top-Right"
              onClick={() => handleSnapPreset("TR")}
              className="px-1 py-0.5 font-mono text-[9px] font-semibold text-muted-foreground hover:bg-surface-hover hover:text-foreground rounded"
            >
              TR
            </button>
            <button
              type="button"
              title="Snap Bottom-Left"
              onClick={() => handleSnapPreset("BL")}
              className="px-1 py-0.5 font-mono text-[9px] font-semibold text-muted-foreground hover:bg-surface-hover hover:text-foreground rounded"
            >
              BL
            </button>
            <button
              type="button"
              title="Snap Bottom-Right"
              onClick={() => handleSnapPreset("BR")}
              className="px-1 py-0.5 font-mono text-[9px] font-semibold text-muted-foreground hover:bg-surface-hover hover:text-foreground rounded"
            >
              BR
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}

/**
 * Camera preview uses prepared per-stream derivatives. Each stream owns a
 * pair of media elements; Smart Cut's pieces inside it are fused into
 * playable segments and swapped without a seek at the cut.
 */
export function CameraPreview({
  clips,
  outputs,
  workDir,
  isPlaying,
  playbackRate,
  frameMs,
  canvasWidth,
  canvasHeight,
  selectedClipId,
  onSelectClip,
  onUpdateTransform,
}: CameraPreviewProps) {
  const groups = useMemo(
    () => buildCameraGroups(clips, outputs, workDir),
    [clips, outputs, workDir],
  )
  return (
    <>
      {groups.map((group) => (
        <CameraStreamSurface
          key={group.streamIndex}
          group={group}
          isPlaying={isPlaying}
          playbackRate={playbackRate}
          frameMs={frameMs}
          canvasWidth={canvasWidth}
          canvasHeight={canvasHeight}
          selectedClipId={selectedClipId}
          onSelectClip={onSelectClip}
          onUpdateTransform={onUpdateTransform}
        />
      ))}
    </>
  )
}
