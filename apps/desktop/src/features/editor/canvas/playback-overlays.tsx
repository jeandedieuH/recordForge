import { useEffect, useMemo } from "react"
import type { CursorTelemetryFile, ManualZoomSegment, TimelineState } from "@recordforge/contracts"
import {
  createUpdateZoomSegmentCommand,
  resolvePreviewComposition,
  zoomTransformToCss,
} from "@recordforge/editor-core"
import { getCursorPointAtTimelineTime, type CursorEngine } from "@recordforge/cursor-core"
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
  videoRef: React.RefObject<HTMLVideoElement | null>
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
  videoRef,
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

  // Imperative transform: the <video> element carries no transform in its
  // React style prop, so writes here survive parent re-renders untouched.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const css = isZoomFraming ? undefined : cssZoomTransform
    video.style.transform = css ?? ""
    video.style.transformOrigin = "0 0"
    video.style.willChange = css ? "transform" : ""
    return () => {
      video.style.transform = ""
      video.style.willChange = ""
    }
  }, [cssZoomTransform, isZoomFraming, videoRef])

  const cursorPointAtPlayhead = useMemo(() => {
    if (composition?.cursor.zoomSpacePoint) return composition.cursor.zoomSpacePoint
    return getCursorPointAtTimelineTime(timeline, playheadMs, cursorTelemetry, cursorEngine)
  }, [composition?.cursor.zoomSpacePoint, timeline, playheadMs, cursorTelemetry, cursorEngine])

  return (
    <>
      {composition?.cursor.active && composition.cursor.frame && cursorTelemetry ? (
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
