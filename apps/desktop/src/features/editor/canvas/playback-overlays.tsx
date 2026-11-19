import { useEffect, useMemo } from "react"
import type { CursorTelemetryFile, ManualZoomSegment, TimelineState } from "@recordforge/contracts"
import {
  createUpdateZoomSegmentCommand,
  findLoupeAtTime,
  resolveCameraShots,
  resolveCursorMotionBlurSamples,
  resolveLoupeAt,
  resolvePreviewComposition,
  resolveScreenMotionBlurStrip,
  zoomTransformToCss,
} from "@recordforge/editor-core"
import {
  fitCursorPoint,
  getCursorPointAtTimelineTime,
  mapCursorPointThroughZoom,
  type CursorEngine,
} from "@recordforge/cursor-core"
import { LoupeOverlay } from "./loupe-overlay"
import { ScreenMotionBlurOverlay } from "./screen-motion-blur-overlay"
import { CustomCursorOverlay } from "../cursor"
import { ZoomCanvasOverlay } from "./zoom-canvas-overlay"
import { usePlayheadMs } from "../timeline/use-playback-state"

export interface PlaybackVideoBounds {
  left: number
  top: number
  width: number
  height: number
  scale: number
  /** CSS px per canvas px (falls back to `scale` for legacy callers). */
  canvasScale?: number
}

interface PlaybackOverlaysProps {
  timeline: TimelineState
  cursorEngine: CursorEngine | null
  cursorTelemetry: CursorTelemetryFile | null
  /** Wrapper around the screen's A/B video slots (the zoom transform target). */
  surfaceRef: React.RefObject<HTMLDivElement | null>
  videoBounds: PlaybackVideoBounds
  isZoomFraming: boolean
  selectedZoomSegment: ManualZoomSegment | null
  borderRadius?: number | string
  onUpdateZoomTarget: (
    segmentId: string,
    update: Parameters<typeof createUpdateZoomSegmentCommand>[1],
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
}

/**
 * Playhead-driven overlay layer for the monitor stack. Subscribing to the
 * playhead here (instead of the parent TimelineView) bounds every video-frame
 * re-render to this small subtree, and the screen's zoom transform is written
 * straight to the video element's style so it never passes through React at
 * all during playback.
 */
export function PlaybackOverlays({
  timeline,
  cursorEngine,
  cursorTelemetry,
  surfaceRef,
  videoBounds,
  isZoomFraming,
  selectedZoomSegment,
  borderRadius,
  onUpdateZoomTarget,
}: PlaybackOverlaysProps) {
  const playheadMs = usePlayheadMs()

  const composition = useMemo(
    () => resolvePreviewComposition(timeline, playheadMs, { cursorEngine }),
    [cursorEngine, timeline, playheadMs],
  )

  const cssZoomTransform = useMemo(
    () =>
      composition?.screen.zoomTransform
        ? zoomTransformToCss(composition.screen.zoomTransform, timeline.canvas, {
            width: videoBounds.width,
            height: videoBounds.height,
          })
        : undefined,
    [composition?.screen.zoomTransform, timeline.canvas, videoBounds],
  )

  // Imperative transform on the slot wrapper: neither <video> element carries a
  // transform in its React style, so writes here survive both parent re-renders
  // and the A/B slot swap at a cut.
  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    const css = isZoomFraming ? undefined : cssZoomTransform
    surface.style.transform = css ?? ""
    surface.style.transformOrigin = "0 0"
    surface.style.willChange = css ? "transform" : ""

    return () => {
      surface.style.transform = ""
      surface.style.willChange = ""
    }
  }, [cssZoomTransform, isZoomFraming, surfaceRef])

  // Real-time GPU shutter-strip motion blur for zoom & pan: deterministic at
  // any timestamp so paused frames, scrubbing, and playback all match export.
  const blurSetting = timeline.canvas.motionBlur
  const screenBlurEnabled = useMemo(() => {
    if (!blurSetting?.enabled) return false
    if ((blurSetting.zoom ?? 0) <= 0 && (blurSetting.pan ?? 0) <= 0) return false
    return resolveCameraShots(timeline, cursorEngine).length > 0
  }, [blurSetting, timeline, cursorEngine])

  const screenMotionBlurStrip = useMemo(() => {
    if (!screenBlurEnabled || isZoomFraming || !composition?.screen.active) return null
    return resolveScreenMotionBlurStrip(
      timeline,
      playheadMs,
      { width: videoBounds.width, height: videoBounds.height },
      cursorEngine,
    )
  }, [
    screenBlurEnabled,
    isZoomFraming,
    composition?.screen.active,
    timeline,
    playheadMs,
    videoBounds.width,
    videoBounds.height,
    cursorEngine,
  ])

  const cursorMotionBlurSamples = useMemo(() => {
    if (!blurSetting?.enabled || (blurSetting.cursor ?? 0) <= 0) return undefined
    if (!composition?.cursor.active || !cursorEngine) return undefined
    const samples = resolveCursorMotionBlurSamples(
      timeline,
      playheadMs,
      cursorEngine,
      { width: videoBounds.width, height: videoBounds.height },
      { isZoomFraming },
    )
    return samples.length > 1 ? samples : undefined
  }, [
    blurSetting,
    composition?.cursor.active,
    cursorEngine,
    timeline,
    playheadMs,
    videoBounds.width,
    videoBounds.height,
    isZoomFraming,
  ])

  const canvasScale = Math.max(0.0001, videoBounds.canvasScale ?? videoBounds.scale)
  const screenRect = useMemo(
    () => ({
      x: videoBounds.left / canvasScale,
      y: videoBounds.top / canvasScale,
      width: videoBounds.width / canvasScale,
      height: videoBounds.height / canvasScale,
    }),
    [videoBounds.left, videoBounds.top, videoBounds.width, videoBounds.height, canvasScale],
  )

  const cursorPointAtPlayhead = useMemo(() => {
    if (composition?.cursor.zoomSpacePoint) return composition.cursor.zoomSpacePoint
    return getCursorPointAtTimelineTime(timeline, playheadMs, cursorTelemetry, cursorEngine)
  }, [composition?.cursor.zoomSpacePoint, timeline, playheadMs, cursorTelemetry, cursorEngine])

  // Displayed cursor tip in canvas pixels (after any active frame zoom) so a
  // Glass Loupe riding the cursor tracks the visible pointer while still
  // magnifying the unzoomed screen point underneath it — matching export.
  const displayCursorPoint = useMemo(() => {
    if (!cursorPointAtPlayhead) return null
    const activeZoom = isZoomFraming ? null : composition?.screen.zoomTransform
    const localPoint =
      composition?.cursor.frame && cursorTelemetry
        ? fitCursorPoint(
            { x: composition.cursor.frame.sourceX, y: composition.cursor.frame.sourceY },
            cursorTelemetry,
            screenRect.width,
            screenRect.height,
          )
        : {
            x: (cursorPointAtPlayhead.x / Math.max(1, timeline.canvas.width)) * screenRect.width,
            y: (cursorPointAtPlayhead.y / Math.max(1, timeline.canvas.height)) * screenRect.height,
          }
    const mapped = activeZoom
      ? mapCursorPointThroughZoom(localPoint, screenRect, timeline.canvas, activeZoom)
      : localPoint
    return {
      x: screenRect.x + mapped.x,
      y: screenRect.y + mapped.y,
    }
  }, [
    cursorPointAtPlayhead,
    isZoomFraming,
    composition?.screen.zoomTransform,
    composition?.cursor.frame,
    cursorTelemetry,
    screenRect,
    timeline.canvas,
  ])

  // Resolve the lens pose once so the overlay and the cursor-suppression
  // decision share it: while a loupe rides the cursor, the drawn pointer
  // hides under the glass (matching the export's lens → cursor order).
  const loupePose = useMemo(() => {
    const segment = findLoupeAtTime(timeline, playheadMs)
    return segment
      ? resolveLoupeAt(segment, timeline, playheadMs, cursorEngine, cursorPointAtPlayhead, {
          screenRect,
          displayCursorPoint,
        })
      : null
  }, [timeline, playheadMs, cursorEngine, cursorPointAtPlayhead, screenRect, displayCursorPoint])

  return (
    <>
      {/* Screen zoom/pan motion blur — sits directly above the screen video
          (z-[2]) and below Glass Loupe (z-[6]) and cursor (z-10). */}
      <ScreenMotionBlurOverlay
        enabled={screenBlurEnabled && !isZoomFraming}
        strip={screenMotionBlurStrip}
        surfaceRef={surfaceRef}
        videoBounds={videoBounds}
        borderRadius={borderRadius}
      />
      {/* Glass Loupe: the lens floats over the screen but under the cursor
          (z-10 below) — the export's screen → lens → cursor order. */}
      <LoupeOverlay
        pose={loupePose}
        surfaceRef={surfaceRef}
        videoBounds={videoBounds}
        canvasWidth={timeline.canvas.width}
        canvasHeight={timeline.canvas.height}
      />
      {composition?.cursor.active &&
      composition.cursor.frame &&
      cursorTelemetry &&
      !(loupePose?.visible && loupePose.following) ? (
        <CustomCursorOverlay
          frame={composition.cursor.frame}
          cursorSettings={composition.cursor.settings}
          telemetry={cursorTelemetry}
          containerWidth={videoBounds.width}
          containerHeight={videoBounds.height}
          canvasWidth={timeline.canvas.width}
          canvasHeight={timeline.canvas.height}
          offsetX={videoBounds.left}
          offsetY={videoBounds.top}
          borderRadius={borderRadius}
          zoomTransform={isZoomFraming ? undefined : composition?.screen.zoomTransform}
          motionBlurSamples={cursorMotionBlurSamples}
        />
      ) : null}

      {selectedZoomSegment ? (
        <ZoomCanvasOverlay
          segment={selectedZoomSegment}
          canvasWidth={timeline.canvas.width}
          canvasHeight={timeline.canvas.height}
          containerWidth={videoBounds.width}
          containerHeight={videoBounds.height}
          offsetX={videoBounds.left}
          offsetY={videoBounds.top}
          canvasScale={canvasScale}
          screenRect={screenRect}
          cursorPointAtPlayhead={cursorPointAtPlayhead}
          displayCursorPoint={displayCursorPoint}
          dimOutsideFrame={isZoomFraming}
          onUpdateTarget={(target, options) =>
            onUpdateZoomTarget(selectedZoomSegment.id, { target }, options)
          }
          onUpdateSegment={(update, options) =>
            onUpdateZoomTarget(selectedZoomSegment.id, update, options)
          }
        />
      ) : null}
    </>
  )
}
