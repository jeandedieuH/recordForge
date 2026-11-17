import { useEffect, useMemo, useRef, useState } from "react"
import type {
  CameraClip,
  CameraColor,
  CameraLayoutSegment,
  CanvasAspectRatio,
  ClipTransform,
  FaceTrack,
  MediaVideoTrackOutput,
  TimelineClip,
} from "@recordforge/contracts"
import { cameraColorSchema } from "@recordforge/contracts"
import {
  buildPreviewSegments,
  cameraFrameNudgePatch,
  cameraFramePatchFromRect,
  cameraShortEdge,
  faceCropAt,
  getCameraFrame,
  resolveCameraFrame,
  resolveFaceCropKeyframes,
  screenContentRect,
  snapCameraRect,
  CAMERA_LAYOUT_MARGIN_FRACTION,
  type CameraFramePatch,
  type CameraLayoutPip,
  type CameraSnapGuide,
  type CameraSourceSize,
  type CanvasRect,
  type PreviewSegment,
} from "@recordforge/editor-core"
import { cn } from "@recordforge/ui"
import { CameraFrameView } from "../camera/camera-frame-view"
import { toAssetUrl } from "../media/derivative-resources"
import { useDualMediaSlots } from "./playback/use-dual-media-slots"
import { usePlayheadMs } from "./use-playback-state"
import { useTimelineStore } from "../../../stores/timeline-store"
import {
  getCameraAiArtifacts,
  onCameraAiArtifactsChanged,
  readCameraFaceTrack,
  readCameraLut,
} from "../../../lib/camera-ai"
import { CameraLutCanvas } from "../canvas/camera-lut-canvas"
import { centerCoverCrop, type NormalizedCrop } from "../canvas/camera-cutout"

interface CameraPreviewProps {
  clips: CameraClip[]
  outputs: MediaVideoTrackOutput[]
  workDir?: string | null
  isPlaying: boolean
  playbackRate: number
  frameMs: number
  canvasWidth: number
  canvasHeight: number
  /** Canvas padding, so camera layouts resolve the fitted screen rect. */
  canvasPadding?: number
  /** Canvas ratio feeds the frame resolver's per-ratio preset table. */
  canvasAspectRatio?: CanvasAspectRatio
  /** Camera layout lane (#5); an active window overrides the clip transform. */
  cameraLayouts?: CameraLayoutSegment[]
  /** Image asset URLs, used for the cutout background-image mode. */
  assetUrls?: Readonly<Record<string, string>>
  /** CSS px per canvas px in the preview, so border widths match the render. */
  previewScale?: number
  selectedClipId?: string | null
  onSelectClip?: (clipId: string) => void
  onUpdateFrame?: (
    clipId: string,
    patch: CameraFramePatch,
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
  /** Commit a layout-lane segment edit (pip lane drags). */
  onUpdateCameraLayout?: (segmentId: string, update: { pip?: Partial<CameraLayoutPip> }) => void
}

// Colour preview needs WebGL2; when it is unavailable CameraLutCanvas reports
// onUnavailable and the plain camera video stays visible instead of a black
// frame — the real per-canvas context check replaced a module-level probe.

// Cutout without a grade still needs a colour object for the shared LUT path.
const DEFAULT_CAMERA_COLOR: CameraColor = cameraColorSchema.parse({})

const MIN_CAMERA_SIZE_PX = 80

interface CameraGesture {
  clipId: string
  pointerId: number
  mode: "move" | "resize"
  handle?: "nw" | "ne" | "se" | "sw"
  startX: number
  startY: number
  /** Resolved rect at gesture start (canvas px). */
  startRect: CanvasRect
  /** Resolved rect aspect for aspect-locked resize. */
  aspect: number
  /** Active layout-lane pip segment; set => the drag edits the segment. */
  segmentId: string | null
  segmentPip: CameraLayoutPip | null
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

interface CameraStreamSurfaceProps {
  group: CameraStreamGroup
  isPlaying: boolean
  playbackRate: number
  frameMs: number
  canvasWidth: number
  canvasHeight: number
  canvasPadding?: number
  canvasAspectRatio?: CanvasAspectRatio
  cameraLayouts?: CameraLayoutSegment[]
  assetUrls?: Readonly<Record<string, string>>
  previewScale?: number
  selectedClipId?: string | null
  onSelectClip?: (clipId: string) => void
  onUpdateFrame?: CameraPreviewProps["onUpdateFrame"]
  onUpdateCameraLayout?: CameraPreviewProps["onUpdateCameraLayout"]
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
  canvasPadding = 0,
  canvasAspectRatio,
  cameraLayouts,
  assetUrls = {},
  previewScale = 1,
  selectedClipId,
  onSelectClip,
  onUpdateFrame,
  onUpdateCameraLayout,
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
  const [snapGuides, setSnapGuides] = useState<CameraSnapGuide[]>([])
  // Lane `pip` drags have no draft plumbing: hold a transient canvas-px rect
  // until pointer release commits the layout segment.
  const [dragOverride, setDragOverride] = useState<CanvasRect | null>(null)
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
  // Face tracking (#4c): the preview consumes the same smoothed crop keyframes
  // as the render plan. The track is loaded once per clip; the transform below
  // then follows the playhead.
  const recordingId = useTimelineStore((state) => state.project?.recordingId ?? state.recording?.id)
  // A finished Camera AI run rewrites deterministic artifact paths; the bump
  // reloads the matte and face track without remounting the surface. Starting
  // from the mount time also avoids a stale asset-protocol cache.
  const [artifactsVersion, setArtifactsVersion] = useState(() => Date.now())
  useEffect(
    () => onCameraAiArtifactsChanged(() => setArtifactsVersion((version) => version + 1)),
    [],
  )
  const [faceTrack, setFaceTrack] = useState<FaceTrack | null>(null)
  useEffect(() => {
    if (!recordingId || !activeClip?.faceTracking?.enabled) {
      setFaceTrack(null)
      return
    }
    let cancelled = false
    void readCameraFaceTrack(recordingId, activeClip.streamIndex ?? 0)
      .then((track) => {
        if (!cancelled) setFaceTrack(track)
      })
      .catch(() => {
        if (!cancelled) setFaceTrack(null)
      })
    return () => {
      cancelled = true
    }
  }, [
    recordingId,
    activeClip?.id,
    activeClip?.streamIndex,
    activeClip?.faceTracking?.enabled,
    artifactsVersion,
  ])

  // Cutout (#4b): the matte is a separate grayscale derivative aligned to the
  // same source time as the camera track, so it drives a second dual-slot pair.
  const matteSlot0 = useRef<HTMLVideoElement>(null)
  const matteSlot1 = useRef<HTMLVideoElement>(null)
  const matteSlots = useMemo(
    () =>
      [matteSlot0, matteSlot1] as [
        React.RefObject<HTMLVideoElement | null>,
        React.RefObject<HTMLVideoElement | null>,
      ],
    [],
  )
  const [matteUrl, setMatteUrl] = useState<string | null>(null)
  const cutoutEnabled = activeClip?.cutout?.enabled === true
  useEffect(() => {
    if (!recordingId || !cutoutEnabled) {
      setMatteUrl(null)
      return
    }
    let cancelled = false
    void getCameraAiArtifacts(recordingId, activeClip?.streamIndex ?? 0)
      .then((artifacts) => {
        if (cancelled) return
        const base = artifacts.mattePath ? toAssetUrl(artifacts.mattePath) : null
        // Re-running Camera AI rewrites the same deterministic path; the version
        // keeps the media elements from serving the previous matte.
        setMatteUrl(base ? `${base}${base.includes("?") ? "&" : "?"}v=${artifactsVersion}` : null)
      })
      .catch(() => {
        if (!cancelled) setMatteUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [recordingId, cutoutEnabled, activeClip?.streamIndex, artifactsVersion])

  const { activeSlot: activeMatteSlot } = useDualMediaSlots({
    segments,
    playheadMs,
    isPlaying,
    playbackRate,
    frameMs,
    kind: "camera",
    enabled: Boolean(matteUrl) && segments.length > 0,
    slots: matteSlots,
    sourceUrlOf: () => matteUrl,
    onSync: (_slot, _segment: PreviewSegment | null, element) => {
      element.muted = true
    },
  })

  const [lutCubeText, setLutCubeText] = useState<string | null>(null)
  useEffect(() => {
    const lutId = activeClip?.color?.lutId
    if (!recordingId || !lutId || lutId.startsWith("look:")) {
      setLutCubeText(null)
      return
    }
    let cancelled = false
    void readCameraLut(recordingId, lutId)
      .then((text) => {
        if (!cancelled) setLutCubeText(text)
      })
      .catch(() => {
        if (!cancelled) setLutCubeText(null)
      })
    return () => {
      cancelled = true
    }
  }, [recordingId, activeClip?.color?.lutId])
  const color = activeClip?.color
  const graded = Boolean(
    color &&
    (color.lutId ||
      color.exposure !== 0 ||
      color.contrast !== 0 ||
      color.saturation !== 0 ||
      color.temperature !== 0 ||
      color.tint !== 0),
  )
  const cutout = activeClip?.cutout
  // The matte must exist before the canvas can hide the plain camera video;
  // until then the preview keeps the current (ungraded but visible) frame.
  const cutoutActive = Boolean(cutout?.enabled && matteUrl)
  // The canvas reports its own health: the plain videos stay visible until it
  // proves it can draw, and come back if the GL pipeline dies (context loss or
  // persistent upload failures), so grading can never blank the bubble.
  const [canvasLive, setCanvasLive] = useState(false)
  const [canvasFailed, setCanvasFailed] = useState(false)
  const useCanvas = (graded || cutoutActive) && !canvasFailed
  // A new grade/cutout input is a new pipeline: retry after a fatal failure.
  useEffect(() => {
    setCanvasFailed(false)
  }, [color, cutoutActive, lutCubeText])
  // While the canvas is away the plain video must cover the bubble again.
  useEffect(() => {
    if (!useCanvas) setCanvasLive(false)
  }, [useCanvas])
  // Camera frame model (ADR 023): the preview resolves the same frame the
  // render plan emits — the clip transform migrates to a frame when the clip
  // carries none, and layout-lane windows apply on top at the playhead.
  const frameCanvas = {
    width: canvasWidth,
    height: canvasHeight,
    padding: canvasPadding,
    aspectRatio: canvasAspectRatio,
  }
  const frameSource: CameraSourceSize | undefined =
    group.width && group.height
      ? { width: group.width, height: group.height }
      : naturalDimensions
        ? { width: naturalDimensions.width, height: naturalDimensions.height }
        : undefined
  const resolved = activeClip
    ? resolveCameraFrame({
        frame: getCameraFrame(activeClip, frameCanvas, frameSource),
        canvas: frameCanvas,
        source: frameSource,
        segments: cameraLayouts,
        timeMs: playheadMs,
      })
    : group.clips[0]
      ? // No clip at the playhead: resolve the first clip's base frame so the
        // surface keeps its (invisible) rect like the old transform fallback.
        resolveCameraFrame({
          frame: getCameraFrame(group.clips[0], frameCanvas, frameSource),
          canvas: frameCanvas,
          source: frameSource,
        })
      : null
  // Gestures keep editing the persisted ClipTransform; during a lane window
  // the merged values mirror what the old pose overlay produced.
  const clipTransform = activeClip?.transform ?? group.clips[0]?.transform
  if (!resolved || !clipTransform) return null
  const laneOwnsGeometry = activeClip !== null && resolved.layout !== "base"
  const transform: ClipTransform = laneOwnsGeometry
    ? {
        ...clipTransform,
        x: resolved.rect.x,
        y: resolved.rect.y,
        width: resolved.rect.width,
        height: resolved.rect.height,
        opacity: resolved.opacity,
        shape: resolved.shape,
      }
    : clipTransform
  const isActive = activeClip !== null
  const isLocked = transform.locked === true
  const clipFrame = getCameraFrame(activeClip ?? group.clips[0], frameCanvas, frameSource)
  const isSelected = activeClip !== null && selectedClipId === activeClip.id
  const sourceWidth =
    group.width ?? naturalDimensions?.width ?? transform.crop?.width ?? canvasWidth
  const sourceHeight =
    group.height ?? naturalDimensions?.height ?? transform.crop?.height ?? canvasHeight
  const faceCropKeyframes = (() => {
    if (!activeClip?.faceTracking?.enabled || !faceTrack) return null
    return resolveFaceCropKeyframes({
      track: faceTrack,
      sourceInMs: activeClip.sourceInMs,
      sourceOutMs: activeClip.sourceOutMs,
      outputStartMs: activeClip.startMs,
      outputEndMs: activeClip.startMs + activeClip.durationMs,
      settings: activeClip.faceTracking,
      sourceWidth,
      sourceHeight,
      fps: faceTrack.fps,
    })
  })()
  const trackedCrop = faceCropKeyframes ? faceCropAt(faceCropKeyframes, playheadMs) : null
  // Face-tracked framing wins; frame-backed clips resolve their crop from the
  // frame's framing; legacy clips keep the stored pixel crop — the render
  // plan's exact precedence.
  const crop = trackedCrop ?? (activeClip?.frame && frameSource ? resolved.crop : transform.crop)
  const cropWidth = crop?.width ?? sourceWidth
  const cropHeight = crop?.height ?? sourceHeight
  const cropLeft = crop ? -(crop.x / cropWidth) * 100 : 0
  const cropTop = crop ? -(crop.y / cropHeight) * 100 : 0
  const cropVideoWidth = crop ? (sourceWidth / cropWidth) * 100 : 100
  const cropVideoHeight = crop ? (sourceHeight / cropHeight) * 100 : 100
  const cropNormalized =
    crop && sourceWidth > 0 && sourceHeight > 0
      ? {
          x: crop.x / sourceWidth,
          y: crop.y / sourceHeight,
          width: crop.width / sourceWidth,
          height: crop.height / sourceHeight,
        }
      : null
  const backgroundImageUrl =
    cutout?.background === "image" && cutout.imageAssetId
      ? (assetUrls[cutout.imageAssetId] ?? null)
      : null
  // The plain surface is `object-cover` without a crop and `object-fill` with
  // one; the canvas reproduces that framing so grading/cutout stay aligned.
  const displayCrop: NormalizedCrop =
    cropNormalized ??
    (() => {
      const sourceW = group.width ?? naturalDimensions?.width ?? 0
      const sourceH = group.height ?? naturalDimensions?.height ?? 0
      const targetAspect = transform.width / Math.max(1, transform.height)
      return centerCoverCrop(
        sourceW > 0 && sourceH > 0 ? sourceW / sourceH : targetAspect,
        targetAspect,
      )
    })()
  // Gesture rules: overlay base frames drag via frame patches; a lane `pip`
  // window drags its layout segment instead. Full/split frames, other lane
  // windows, hidden clips and locked presets never drag — pointer down still
  // selects.
  const lanePipSegment =
    activeClip !== null && resolved.layout === "pip" && resolved.segmentId
      ? (cameraLayouts?.find((segment) => segment.id === resolved.segmentId) ?? null)
      : null
  const canDragFrame =
    isActive && resolved.mode === "overlay" && resolved.visible !== false && !laneOwnsGeometry
  const canDragLanePip = lanePipSegment !== null && activeClip !== null
  const isDraggable = (canDragFrame || canDragLanePip) && !transform.locked
  const anchorAreaRect: CanvasRect =
    clipFrame.placement.anchorTo === "content"
      ? screenContentRect(frameCanvas)
      : { x: 0, y: 0, width: canvasWidth, height: canvasHeight }
  const snapMarginPx = lanePipSegment
    ? canvasHeight * CAMERA_LAYOUT_MARGIN_FRACTION
    : Math.round(clipFrame.placement.margin * cameraShortEdge(frameCanvas))
  // Snap threshold is ~6 CSS px expressed in canvas px at the current zoom.
  const snapThresholdPx = 6 / Math.max(0.01, previewScale)

  function handleEdges(handle: CameraGesture["handle"]) {
    return {
      left: handle === "nw" || handle === "sw",
      right: handle === "ne" || handle === "se",
      top: handle === "nw" || handle === "ne",
      bottom: handle === "sw" || handle === "se",
    }
  }

  // Aspect-locked resize candidate: the corner opposite the handle stays
  // fixed, width drives and height follows the locked aspect.
  function resizeCandidate(gesture: CameraGesture, dx: number, dy: number): CanvasRect {
    const handle = gesture.handle ?? "se"
    const aspect = gesture.aspect
    const start = gesture.startRect
    const delta =
      handle === "se"
        ? Math.max(dx, dy * aspect)
        : handle === "nw"
          ? Math.max(-dx, -dy * aspect)
          : handle === "ne"
            ? Math.max(dx, -dy * aspect)
            : Math.max(-dx, dy * aspect)
    // Cap so the aspect-locked rect still fits inside the anchor area.
    const maxW = Math.min(anchorAreaRect.width, anchorAreaRect.height * aspect)
    const nextW = Math.max(MIN_CAMERA_SIZE_PX, Math.min(maxW, start.width + delta))
    const nextH = Math.max(2, Math.round(nextW / aspect))
    const nextX = handle === "nw" || handle === "sw" ? start.x + start.width - nextW : start.x
    const nextY = handle === "nw" || handle === "ne" ? start.y + start.height - nextH : start.y
    return { x: nextX, y: nextY, width: nextW, height: nextH }
  }

  // Re-lock aspect after an edge snap: width wins, height re-derives, the
  // corner opposite the handle stays anchored.
  function lockAspect(
    rect: CanvasRect,
    handle: CameraGesture["handle"],
    aspect: number,
  ): CanvasRect {
    const w = rect.width
    const h = Math.max(2, Math.round(w / aspect))
    const x = handle === "nw" || handle === "sw" ? rect.x + rect.width - w : rect.x
    const y = handle === "nw" || handle === "ne" ? rect.y + rect.height - h : rect.y
    return { x, y, width: w, height: h }
  }

  function gestureRect(gesture: CameraGesture, dx: number, dy: number, snapping: boolean) {
    if (gesture.mode === "resize") {
      const candidate = resizeCandidate(gesture, dx, dy)
      if (!snapping) return { rect: candidate, guides: [] as CameraSnapGuide[] }
      const snapped = snapCameraRect({
        rect: candidate,
        canvas: frameCanvas,
        area: anchorAreaRect,
        marginPx: snapMarginPx,
        thresholdPx: snapThresholdPx,
        mode: "resize",
        activeEdges: handleEdges(gesture.handle),
      })
      return {
        rect: lockAspect(snapped.rect, gesture.handle, gesture.aspect),
        guides: snapped.guides,
      }
    }
    const start = gesture.startRect
    const candidate: CanvasRect = {
      x: Math.min(Math.max(0, start.x + dx), Math.max(0, canvasWidth - start.width)),
      y: Math.min(Math.max(0, start.y + dy), Math.max(0, canvasHeight - start.height)),
      width: start.width,
      height: start.height,
    }
    if (!snapping) return { rect: candidate, guides: [] as CameraSnapGuide[] }
    return snapCameraRect({
      rect: candidate,
      canvas: frameCanvas,
      area: anchorAreaRect,
      marginPx: snapMarginPx,
      thresholdPx: snapThresholdPx,
      mode: "move",
    })
  }

  function canvasDelta(event: React.PointerEvent<HTMLDivElement>, startX: number, startY: number) {
    const canvasElement = event.currentTarget.parentElement
    return {
      dx: ((event.clientX - startX) / Math.max(1, canvasElement?.clientWidth ?? 1)) * canvasWidth,
      dy: ((event.clientY - startY) / Math.max(1, canvasElement?.clientHeight ?? 1)) * canvasHeight,
    }
  }

  function beginDrag(
    event: React.PointerEvent<HTMLDivElement>,
    mode: CameraGesture["mode"] = "move",
    handle?: CameraGesture["handle"],
  ) {
    if (!activeClip) return
    onSelectClip?.(activeClip.id)
    if (!isDraggable || event.button !== 0) return
    const startRect = resolved?.rect
    if (!startRect) return
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
      startRect: { ...startRect },
      aspect: startRect.width / Math.max(1, startRect.height),
      segmentId: canDragLanePip ? lanePipSegment.id : null,
      segmentPip: canDragLanePip ? (lanePipSegment.pip ?? null) : null,
      moved: false,
    }
  }

  function moveDrag(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const { dx, dy } = canvasDelta(event, gesture.startX, gesture.startY)
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && !gesture.moved) return
    gesture.moved = true
    event.preventDefault()
    // Alt disables snapping for the duration of the move.
    const { rect, guides } = gestureRect(gesture, dx, dy, !event.altKey)
    setSnapGuides(guides)
    if (gesture.segmentId) {
      // Lane pip sizeFraction is bounded to [0.05, 0.6] of canvas height.
      const maxH = canvasHeight * 0.6
      setDragOverride(
        rect.height > maxH ? { ...rect, height: maxH, width: maxH * gesture.aspect } : rect,
      )
      return
    }
    if (!onUpdateFrame) return
    onUpdateFrame(
      gesture.clipId,
      cameraFramePatchFromRect({
        frame: clipFrame,
        rect,
        canvas: frameCanvas,
        source: frameSource,
      }),
      { phase: "draft" },
    )
  }

  function finishDrag(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const wasCancelled = event.type === "pointercancel"
    const didMove = gesture.moved
    gestureRef.current = null
    setSnapGuides([])
    setDragOverride(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    if (gesture.segmentId) {
      if (!wasCancelled && didMove && onUpdateCameraLayout) {
        const { dx, dy } = canvasDelta(event, gesture.startX, gesture.startY)
        const { rect } = gestureRect(gesture, dx, dy, !event.altKey)
        onUpdateCameraLayout(gesture.segmentId, {
          pip: {
            ...(gesture.segmentPip ?? {}),
            corner: "custom",
            x: rect.x / canvasWidth,
            y: rect.y / canvasHeight,
            sizeFraction: Math.min(0.6, Math.max(0.05, rect.height / canvasHeight)),
          },
        })
      }
      return
    }
    if (!onUpdateFrame) return

    if (wasCancelled || !didMove) {
      onUpdateFrame(
        gesture.clipId,
        cameraFramePatchFromRect({
          frame: clipFrame,
          rect: gesture.startRect,
          canvas: frameCanvas,
          source: frameSource,
        }),
        { phase: "cancel" },
      )
      return
    }

    const { dx, dy } = canvasDelta(event, gesture.startX, gesture.startY)
    const { rect } = gestureRect(gesture, dx, dy, !event.altKey)
    onUpdateFrame(
      gesture.clipId,
      cameraFramePatchFromRect({
        frame: clipFrame,
        rect,
        canvas: frameCanvas,
        source: frameSource,
      }),
      { phase: "commit" },
    )
  }

  const handleSnapPreset = (position: "TL" | "TR" | "BL" | "BR") => {
    if (!onUpdateFrame || !activeClip) return
    const align =
      position === "TL"
        ? { x: 0, y: 0 }
        : position === "TR"
          ? { x: 1, y: 0 }
          : position === "BL"
            ? { x: 0, y: 1 }
            : { x: 1, y: 1 }
    // A corner pick is a positional choice, so it pins the placement.
    onUpdateFrame(activeClip.id, { placement: { align } }, { phase: "commit" })
  }

  const handleSetShape = (shape: "circle" | "rounded" | "rectangle") => {
    if (!onUpdateFrame || !activeClip) return
    // Keep the current origin so a shape-only change does not pin an auto frame.
    onUpdateFrame(
      activeClip.id,
      { shape, placement: { origin: clipFrame.placement.origin } },
      { phase: "commit" },
    )
  }

  return (
    <>
      <CameraFrameView
        frame={dragOverride ? { ...resolved, rect: dragOverride } : resolved}
        canvasWidth={canvasWidth}
        canvasHeight={canvasHeight}
        previewScale={previewScale}
        active={isActive}
        locked={isLocked}
        selected={isSelected}
        interactive={Boolean(onUpdateFrame) && isDraggable}
        showCornerSnaps={resolved.mode === "overlay" && !lanePipSegment}
        onSelect={() => {
          if (activeClip) onSelectClip?.(activeClip.id)
        }}
        onKeyDown={(event) => {
          if (!onUpdateFrame || !activeClip || !canDragFrame || gestureRef.current) return
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
          onUpdateFrame(
            activeClip.id,
            cameraFrameNudgePatch({
              frame: clipFrame,
              canvas: frameCanvas,
              source: frameSource,
              dxPx: delta.x,
              dyPx: delta.y,
            }),
            { phase: "commit" },
          )
        }}
        onPointerDown={(event) => beginDrag(event, "move")}
        onPointerMove={moveDrag}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onResizeHandleDown={(event, handle) => beginDrag(event, "resize", handle)}
        onSnapPreset={handleSnapPreset}
        onSetShape={handleSetShape}
      >
        <video
          ref={slot0}
          muted
          playsInline
          preload="auto"
          // The asset protocol is a different origin; anonymous CORS keeps the
          // frames origin-clean so the WebGL canvas can upload them (a tainted
          // video makes texImage2D throw and blanked the bubble).
          crossOrigin="anonymous"
          className={cn(
            "pointer-events-none absolute max-h-none max-w-none",
            crop ? "object-fill" : "object-cover",
          )}
          style={{
            left: `${cropLeft}%`,
            top: `${cropTop}%`,
            width: `${cropVideoWidth}%`,
            height: `${cropVideoHeight}%`,
            opacity: useCanvas && canvasLive ? 0 : 1,
            visibility: activeSlot === 0 ? "visible" : "hidden",
          }}
        />
        <video
          ref={slot1}
          muted
          playsInline
          preload="auto"
          crossOrigin="anonymous"
          className={cn(
            "pointer-events-none absolute max-h-none max-w-none",
            crop ? "object-fill" : "object-cover",
          )}
          style={{
            left: `${cropLeft}%`,
            top: `${cropTop}%`,
            width: `${cropVideoWidth}%`,
            height: `${cropVideoHeight}%`,
            opacity: useCanvas && canvasLive ? 0 : 1,
            visibility: activeSlot === 1 ? "visible" : "hidden",
          }}
        />
        {/* Matte slots mirror the camera slots; only the canvas samples them. */}
        <video
          ref={matteSlot0}
          muted
          playsInline
          preload="auto"
          crossOrigin="anonymous"
          aria-hidden
          className="pointer-events-none absolute top-0 left-0 h-px w-px opacity-0"
        />
        <video
          ref={matteSlot1}
          muted
          playsInline
          preload="auto"
          crossOrigin="anonymous"
          aria-hidden
          className="pointer-events-none absolute top-0 left-0 h-px w-px opacity-0"
        />
        {useCanvas ? (
          <CameraLutCanvas
            videoRef={activeSlot === 0 ? slot0 : slot1}
            matteVideoRef={activeMatteSlot === 0 ? matteSlot0 : matteSlot1}
            matteEnabled={cutoutActive}
            color={color ?? DEFAULT_CAMERA_COLOR}
            cubeText={lutCubeText}
            crop={displayCrop}
            cutout={cutoutActive ? cutout : null}
            backgroundImageUrl={backgroundImageUrl}
            displayWidth={transform.width}
            displayHeight={transform.height}
            className="pointer-events-none absolute inset-0 size-full"
            onReady={() => setCanvasLive(true)}
            onUnavailable={() => {
              setCanvasFailed(true)
              setCanvasLive(false)
            }}
          />
        ) : null}
      </CameraFrameView>
      {snapGuides.map((guide, index) => (
        <div
          key={`${guide.axis}-${index}`}
          aria-hidden
          className={cn(
            "pointer-events-none absolute z-40 bg-primary/60",
            guide.axis === "x" ? "top-0 bottom-0 w-px" : "right-0 left-0 h-px",
          )}
          style={
            guide.axis === "x"
              ? { left: `${(guide.position / canvasWidth) * 100}%` }
              : { top: `${(guide.position / canvasHeight) * 100}%` }
          }
        />
      ))}
    </>
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
  canvasPadding,
  canvasAspectRatio,
  cameraLayouts,
  assetUrls,
  previewScale,
  selectedClipId,
  onSelectClip,
  onUpdateFrame,
  onUpdateCameraLayout,
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
          canvasPadding={canvasPadding}
          canvasAspectRatio={canvasAspectRatio}
          cameraLayouts={cameraLayouts}
          assetUrls={assetUrls}
          previewScale={previewScale}
          selectedClipId={selectedClipId}
          onSelectClip={onSelectClip}
          onUpdateFrame={onUpdateFrame}
          onUpdateCameraLayout={onUpdateCameraLayout}
        />
      ))}
    </>
  )
}
