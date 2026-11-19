import { useCallback, useEffect, useRef } from "react"
import { loupeCornerRadius, loupeSampleSquare, type LoupePose } from "@recordforge/editor-core"
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
 * clipped by the lens shape. Both the lens geometry and the picture rect are
 * expressed in canvas pixels scaled uniformly by `canvasScale` so the lens
 * stays a true circle/square across 9:16, 1:1, padded, and side-by-side layouts.
 */
function drawLoupe(
  canvas: HTMLCanvasElement,
  surface: HTMLDivElement | null,
  pose: LoupePose,
  videoBounds: PlaybackVideoBounds,
): void {
  const ctx = canvas.getContext("2d")
  if (!ctx) return
  const video = pickVideo(surface)
  if (!video || video.readyState < 2 || video.videoWidth === 0) {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    return
  }

  const canvasScale = Math.max(0.0001, videoBounds.canvasScale ?? videoBounds.scale)

  // Letterbox-aware picture rect inside the element's object-contain box,
  // converted into canvas pixels so it matches `frame.rect` / `dest` in export.
  const elementWidth = video.clientWidth || videoBounds.width
  const elementHeight = video.clientHeight || videoBounds.height
  const fit = Math.min(elementWidth / video.videoWidth, elementHeight / video.videoHeight)
  const pictureWidth = video.videoWidth * fit
  const pictureHeight = video.videoHeight * fit
  const pictureX = (elementWidth - pictureWidth) / 2
  const pictureY = (elementHeight - pictureHeight) / 2

  const content = {
    x: (videoBounds.left + pictureX) / canvasScale,
    y: (videoBounds.top + pictureY) / canvasScale,
    width: pictureWidth / canvasScale,
    height: pictureHeight / canvasScale,
  }
  const sample = loupeSampleSquare(pose, content)

  const sourceX = ((sample.x - content.x) / Math.max(1e-6, content.width)) * video.videoWidth
  const sourceY = ((sample.y - content.y) / Math.max(1e-6, content.height)) * video.videoHeight
  const sourceWidth = (sample.width / Math.max(1e-6, content.width)) * video.videoWidth
  const sourceHeight = (sample.height / Math.max(1e-6, content.height)) * video.videoHeight

  const lensSize = Math.max(1, pose.rect.width * canvasScale)
  const ratio = Math.min(2, window.devicePixelRatio || 1)
  const backingSize = Math.max(1, Math.round(lensSize * ratio))
  if (canvas.width !== backingSize || canvas.height !== backingSize) {
    canvas.width = backingSize
    canvas.height = backingSize
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, lensSize, lensSize)

  const lensPath = new Path2D()
  if (pose.settings.shape === "circle") {
    lensPath.arc(lensSize / 2, lensSize / 2, lensSize / 2, 0, Math.PI * 2)
  } else {
    lensPath.roundRect(0, 0, lensSize, lensSize, loupeCornerRadius(pose) * canvasScale)
  }

  ctx.save()
  ctx.clip(lensPath)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = "high"
  ctx.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, lensSize, lensSize)

  // Glass rim brightening mirrors the GPU shader's `smoothstep(0.82, 1.0, rim)`
  // along the actual lens perimeter (radial gradient for circles; stepped inner
  // strokes along `lensPath` for rounded-rect so all four edges and corners glow
  // evenly instead of leaving bright triangular corners).
  if (pose.settings.glass) {
    const rimRadius = lensSize / 2
    if (pose.settings.shape === "circle") {
      const rim = ctx.createRadialGradient(
        rimRadius,
        rimRadius,
        rimRadius * 0.82,
        rimRadius,
        rimRadius,
        rimRadius,
      )
      rim.addColorStop(0, "rgba(255,255,255,0)")
      rim.addColorStop(1, "rgba(255,255,255,0.35)")
      ctx.fillStyle = rim
      ctx.fillRect(0, 0, lensSize, lensSize)
    } else {
      const bandWidth = Math.max(1, rimRadius * 0.18)
      const steps = 6
      for (let i = 0; i < steps; i++) {
        const frac = (i + 1) / steps
        // Under the clip, stroke width 2*w paints `w` inward from the perimeter.
        ctx.strokeStyle = `rgba(255,255,255,${(0.35 / steps) * (1 - (frac - 1 / steps) * 0.4)})`
        ctx.lineWidth = bandWidth * frac * 2
        ctx.stroke(lensPath)
      }
    }
  }

  // Ring: an annulus just inside the lens edge. Stroking the edge path at
  // double width under the lens clip leaves exactly `ringWidth` inside.
  const ringCss = pose.settings.ringWidth * canvasScale
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
  canvasWidth: _canvasWidth,
  canvasHeight: _canvasHeight,
}: LoupeOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !pose?.visible) return
    drawLoupe(canvas, surfaceRef.current, pose, videoBounds)
  }, [pose, surfaceRef, videoBounds])

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

  const canvasScale = Math.max(0.0001, videoBounds.canvasScale ?? videoBounds.scale)
  const shadowBlurCss = pose.settings.shadowBlur * canvasScale
  const shadowed = shadowBlurCss > 0.01 && pose.settings.shadowOpacity > 0

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute z-[6]"
      style={{
        left: pose.rect.x * canvasScale,
        top: pose.rect.y * canvasScale,
        width: pose.rect.width * canvasScale,
        height: pose.rect.height * canvasScale,
        opacity: pose.presence,
        // SDF drop shadow outside the lens, presence-scaled like the export.
        filter: shadowed
          ? `drop-shadow(0 0 ${shadowBlurCss}px rgba(0,0,0,${pose.settings.shadowOpacity}))`
          : undefined,
      }}
    />
  )
}
