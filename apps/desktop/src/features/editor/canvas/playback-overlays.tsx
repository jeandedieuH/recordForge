import { useEffect, useMemo, useRef } from "react"
import type { CursorTelemetryFile, ManualZoomSegment, TimelineState } from "@recordforge/contracts"
import {
  createUpdateZoomSegmentCommand,
  findLoupeAtTime,
  resolveLoupeAt,
  resolvePreviewComposition,
  zoomTransformToCss,
} from "@recordforge/editor-core"
import { getCursorPointAtTimelineTime, type CursorEngine } from "@recordforge/cursor-core"
import { LoupeOverlay } from "./loupe-overlay"
import { CustomCursorOverlay } from "../cursor"
import { ZoomCanvasOverlay } from "./zoom-canvas-overlay"
import { usePlayheadMs } from "../timeline/use-playback-state"

export interface PlaybackVideoBounds {
  left: number
  top: number
  width: number
  height: number
  scale: number
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
  //
  // Motion blur preview (M2 #1) is approximated here: the export averages
  // sub-frame crops on the GPU, which the webview cannot do per-frame, so a
  // velocity-scaled CSS blur follows the zoom/pan motion. It is a preview hint
  // only — the export applies the exact taps — and it disappears the moment the
  // frame stops moving.
  // Preview motion blur follows the canvas setting: off means no blur at all,
  // and the zoom/pan shutters scale it, so the preview matches what the export
  // will do (the export additionally blurs the cursor through the rasterizer).
  const blurSetting = timeline.canvas.motionBlur
  const previewShutter =
    blurSetting?.enabled === true
      ? Math.max(0, Math.min(1, Math.max(blurSetting.zoom ?? 0, blurSetting.pan ?? 0)))
      : 0
  const lastCropRef = useRef<{ timeMs: number; x: number; y: number; width: number } | null>(null)
  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    const css = isZoomFraming ? undefined : cssZoomTransform
    surface.style.transform = css ?? ""
    surface.style.transformOrigin = "0 0"
    surface.style.willChange = css ? "transform" : ""

    const crop = composition?.screen.zoomTransform?.crop
    const previous = lastCropRef.current
    let blurPx = 0
    if (crop && previous && !isZoomFraming && previewShutter > 0) {
      const elapsed = Math.max(1, playheadMs - previous.timeMs)
      const travelled = Math.hypot(crop.x - previous.x, crop.y - previous.y)
      const scaled = Math.abs(crop.width - previous.width)
      blurPx = Math.min(10, ((travelled + scaled) / elapsed) * 6) * previewShutter
    }
    lastCropRef.current = crop
      ? { timeMs: playheadMs, x: crop.x, y: crop.y, width: crop.width }
      : null
    surface.style.filter = blurPx > 0.4 ? `blur(${blurPx.toFixed(2)}px)` : ""

    return () => {
      surface.style.transform = ""
      surface.style.willChange = ""
      surface.style.filter = ""
    }
  }, [
    composition?.screen.zoomTransform,
    cssZoomTransform,
    isZoomFraming,
    playheadMs,
    previewShutter,
    surfaceRef,
  ])

  const cursorPointAtPlayhead = useMemo(() => {
    if (composition?.cursor.zoomSpacePoint) return composition.cursor.zoomSpacePoint
    return getCursorPointAtTimelineTime(timeline, playheadMs, cursorTelemetry, cursorEngine)
  }, [composition?.cursor.zoomSpacePoint, timeline, playheadMs, cursorTelemetry, cursorEngine])

  // Resolve the lens pose once so the overlay and the cursor-suppression
  // decision share it: while a loupe rides the cursor, the drawn pointer
  // hides under the glass (matching the export's lens → cursor order).
  const loupePose = useMemo(() => {
    const segment = findLoupeAtTime(timeline, playheadMs)
    return segment
      ? resolveLoupeAt(segment, timeline, playheadMs, cursorEngine, cursorPointAtPlayhead)
      : null
  }, [timeline, playheadMs, cursorEngine, cursorPointAtPlayhead])

  return (
    <>
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
          cursorPointAtPlayhead={cursorPointAtPlayhead}
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
