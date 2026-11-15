import { useCallback, useEffect, useRef } from "react"
import {
  loupeCornerRadius,
  loupeSampleSquare,
  loupeSurfaceScale,
  type LoupePose,
} from "@recordforge/editor-core"
import type { PlaybackVideoBounds } from "./playback-overlays"

export interface LoupeOverlayProps {
  /**
   * Lens pose resolved by the parent (null, or `visible: false`, renders
   * nothing). The parent resolves it once so the pose that draws the lens is
   * the same one that decides whether the cursor hides underneath it.
   */
  pose: LoupePose | null
  /** Wrapper around the screen's A/B video slots (the zoom transform target). */
  surfaceRef: React.RefObject<HTMLDivElement | null>
  videoBounds: PlaybackVideoBounds
  canvasWidth: number
  canvasHeight: number
}

/** The visible A/B slot drives the lens; the hidden one is the pre-seeked standby. */
function pickVideo(surface: HTMLDivElement | null): HTMLVideoElement | null {
  if (!surface) return null
  const slots = Array.from(surface.querySelectorAll("video"))
  return slots.find((slot) => slot.style.visibility === "visible") ?? slots[0] ?? null
}

/**
 * Draw one lens frame: the unzoomed <video> sampled through the same
 * `diameter / scale` square the export's `loupe_sample_square` resolves,
 * clipped by the lens shape. Canvas coords map proportionally onto the screen
 * box — the zoom-space convention every preview overlay shares — and the
 * picture rect inside the element's `object-contain` box is the "content"
 * the sample clamps against, mirroring `frame.rect` in the export.
 */
function drawLoupe(
  canvas: HTMLCanvasElement,
  surface: HTMLDivElement | null,
  pose: LoupePose,
  videoBounds: PlaybackVideoBounds,
  canvasWidth: number,
  canvasHeight: number,
): void {
  const ctx = canvas.getContext("2d")
  if (!ctx) return
  const video = pickVideo(surface)
  if (!video || video.readyState < 2 || video.videoWidth === 0) {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    return
  }

  const scale = loupeSurfaceScale(
    videoBounds.width,
    videoBounds.height,
    canvasWidth,
    canvasHeight,
  )

  // Letterbox-aware picture rect inside the element's object-contain box.
  const elementWidth = video.clientWidth || videoBounds.width
  const elementHeight = video.clientHeight || videoBounds.height
  const fit = Math.min(elementWidth / video.videoWidth, elementHeight / video.videoHeight)
  const pictureWidth = video.videoWidth * fit
  const pictureHeight = video.videoHeight * fit
  const pictureX = (elementWidth - pictureWidth) / 2
  const pictureY = (elementHeight - pictureHeight) / 2

  const content = {
    x: pictureX / scale.x,
    y: pictureY / scale.y,
    width: pictureWidth / scale.x,
    height: pictureHeight / scale.y,
  }
  const sample = loupeSampleSquare(pose, content)

  const sourceX = ((sample.x * scale.x - pictureX) / pictureWidth) * video.videoWidth
  const sourceY = ((sample.y * scale.y - pictureY) / pictureHeight) * video.videoHeight
  const sourceWidth = ((sample.width * scale.x) / pictureWidth) * video.videoWidth
  const sourceHeight = ((sample.height * scale.y) / pictureHeight) * video.videoHeight

  const lensWidth = Math.max(1, pose.rect.width * scale.x)
  const lensHeight = Math.max(1, pose.rect.height * scale.y)
  const ratio = Math.min(2, window.devicePixelRatio || 1)
  const backingWidth = Math.max(1, Math.round(lensWidth * ratio))
  const backingHeight = Math.max(1, Math.round(lensHeight * ratio))
  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth
    canvas.height = backingHeight
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, lensWidth, lensHeight)

  const lensPath = new Path2D()
  if (pose.settings.shape === "circle") {
    lensPath.arc(lensWidth / 2, lensHeight / 2, lensWidth / 2, 0, Math.PI * 2)
  } else {
    lensPath.roundRect(0, 0, lensWidth, lensHeight, loupeCornerRadius(pose) * scale.x)
  }

  ctx.save()
  ctx.clip(lensPath)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = "high"
  ctx.drawImage(
    video,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    lensWidth,
    lensHeight,
  )

  // Glass rim brightening approximates the shader's smoothstep(0.82, 1)
  // radial ramp; the edge refraction pull stays GPU-only.
  if (pose.settings.glass) {
    const rimRadius = Math.max(lensWidth, lensHeight) / 2
    const rim = ctx.createRadialGradient(
      lensWidth / 2,
      lensHeight / 2,
      rimRadius * 0.82,
      lensWidth / 2,
      lensHeight / 2,
      rimRadius,
    )
    rim.addColorStop(0, "rgba(255,255,255,0)")
    rim.addColorStop(1, "rgba(255,255,255,0.35)")
    ctx.fillStyle = rim
    ctx.fillRect(0, 0, lensWidth, lensHeight)
  }

  // Ring: an annulus just inside the lens edge. Stroking the edge path at
  // double width under the lens clip leaves exactly `ringWidth` inside.
  const ringCss = pose.settings.ringWidth * scale.x
  if (ringCss > 0.01 && pose.settings.ringOpacity > 0) {
    ctx.globalAlpha = pose.settings.ringOpacity
    ctx.strokeStyle = pose.settings.ringColor
    ctx.lineWidth = ringCss * 2
    ctx.stroke(lensPath)
    ctx.globalAlpha = 1
  }
  ctx.restore()
}

/**
 * Glass Loupe (#2) preview. A loupe segment never zooms the frame; this lens
 * floats over the recording magnifying the resolved target — the same pose
 * `resolveLoupeAt` feeds the export, so the lens cannot drift. Drawing is
 * imperative: video frames never pass through React state. Rendered below
 * the cursor overlay (export order: screen → lens → cursor).
 */
export function LoupeOverlay({
  pose,
  surfaceRef,
  videoBounds,
  canvasWidth,
  canvasHeight,
}: LoupeOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !pose?.visible) return
    drawLoupe(canvas, surfaceRef.current, pose, videoBounds, canvasWidth, canvasHeight)
  }, [pose, surfaceRef, canvasWidth, canvasHeight, videoBounds])

  // Latest draw in a ref: the listener effect stays mounted while every
  // playhead tick still redraws with fresh pose/geometry.
  const drawRef = useRef(draw)
  useEffect(() => {
    drawRef.current = draw
    draw()
  }, [draw])

  useEffect(() => {
    const surface = surfaceRef.current
    const videos = surface ? Array.from(surface.querySelectorAll("video")) : []
    if (videos.length === 0) return
    const onFrame = () => drawRef.current()
    for (const video of videos) {
      video.addEventListener("seeked", onFrame)
      video.addEventListener("loadeddata", onFrame)
      video.addEventListener("timeupdate", onFrame)
    }
    // requestVideoFrameCallback keeps the lens in lockstep while playing
    // where the webview supports it; timeupdate/seeked cover the rest.
    let cancelled = false
    let frameHandle = 0
    const pump = () => {
      if (cancelled) return
      onFrame()
      const video = pickVideo(surfaceRef.current)
      if (video?.requestVideoFrameCallback) {
        frameHandle = video.requestVideoFrameCallback(pump)
      }
    }
    if (pickVideo(surface)?.requestVideoFrameCallback) pump()
    return () => {
      cancelled = true
      for (const video of videos) {
        video.removeEventListener("seeked", onFrame)
        video.removeEventListener("loadeddata", onFrame)
        video.removeEventListener("timeupdate", onFrame)
        video.cancelVideoFrameCallback?.(frameHandle)
      }
    }
  }, [surfaceRef])

  if (!pose?.visible) return null

  const scale = loupeSurfaceScale(videoBounds.width, videoBounds.height, canvasWidth, canvasHeight)
  const shadowBlurCss = pose.settings.shadowBlur * scale.x
  const shadowed = shadowBlurCss > 0.01 && pose.settings.shadowOpacity > 0

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute"
      style={{
        left: videoBounds.left + pose.rect.x * scale.x,
        top: videoBounds.top + pose.rect.y * scale.y,
        width: pose.rect.width * scale.x,
        height: pose.rect.height * scale.y,
        opacity: pose.presence,
        // SDF drop shadow outside the lens, presence-scaled like the export.
        filter: shadowed
          ? `drop-shadow(0 0 ${shadowBlurCss}px rgba(0,0,0,${pose.settings.shadowOpacity}))`
          : undefined,
      }}
    />
  )
}
