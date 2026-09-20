import { memo, useLayoutEffect, useMemo, useRef } from "react"
import type { TimelineClip } from "@recordforge/contracts"
import type { WaveformData } from "../media/derivative-resources"
import { fitCanvas, resolveThemeColor, rgba } from "./clip-canvas"
import {
  clipSourceTimeMs,
  displayAmplitude,
  sampleWaveformEnvelope,
  visibleClipWindow,
  waveformNormalization,
  waveformWindowMs,
} from "./derivative-render"

interface TimelineWaveformProps {
  clip: TimelineClip
  data: WaveformData
  pixelsPerMs: number
  visibleStartMs: number
  visibleEndMs: number
  height: number
  // Track accent token ("--color-track-mic", "--color-track-system", ...)
  colorVar?: string
}

/**
 * Canvas waveform renderer drawing a mirrored min/max silhouette. The canvas
 * only covers the visible slice of the clip, so its pixel size stays bounded
 * by the viewport at any zoom. Each CSS column aggregates the whole peak
 * window it covers (transients survive zoom-out) and interpolates between
 * peaks when zoomed past the stored resolution.
 */
export const TimelineWaveform = memo(function TimelineWaveform({
  clip,
  data,
  pixelsPerMs,
  visibleStartMs,
  visibleEndMs,
  height,
  colorVar = "--color-track-mic",
}: TimelineWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const normalization = useMemo(() => waveformNormalization(data), [data])
  // Memoized so the draw effect can depend on the window object itself;
  // visibleClipWindow returns a fresh { startMs, endMs } each render.
  const clipWindow = useMemo(
    () => visibleClipWindow(clip, visibleStartMs, visibleEndMs),
    [clip, visibleStartMs, visibleEndMs],
  )

  // Draw before paint: resizing the canvas clears it, so a post-paint effect
  // would flash blank during zoom gestures.
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !clipWindow || data.peaks.length === 0) return

    const cssW = (clipWindow.endMs - clipWindow.startMs) * pixelsPerMs
    const ctx = fitCanvas(canvas, cssW, height)
    if (!ctx) return

    // Theme-token colors resolved at draw time; plain white is the
    // last-resort failsafe if the token cascade is somehow empty.
    const accent =
      resolveThemeColor(canvas, colorVar) ??
      resolveThemeColor(canvas, "--color-track-mic") ??
      resolveThemeColor(canvas, "--color-foreground") ??
      ([255, 255, 255] as [number, number, number])
    const gradient = ctx.createLinearGradient(0, 0, 0, height)
    // Brighter at the extremes, dimmer at the axis — reads as energy.
    gradient.addColorStop(0, rgba(accent, 0.95))
    gradient.addColorStop(0.5, rgba(accent, 0.55))
    gradient.addColorStop(1, rgba(accent, 0.95))
    ctx.fillStyle = gradient

    const centerY = height / 2
    const halfH = height * 0.5 * 0.94
    const windowMs = waveformWindowMs(data)
    const count = data.peaks.length

    // One rect per CSS column, accumulated into a single path fill.
    ctx.beginPath()
    for (let x = 0; x < cssW; x++) {
      const t0 = clipWindow.startMs + x / pixelsPerMs
      const t1 = clipWindow.startMs + (x + 1) / pixelsPerMs
      const fromIndex = clipSourceTimeMs(clip, t0) / windowMs
      const toIndex = clipSourceTimeMs(clip, t1) / windowMs
      if (fromIndex >= count || toIndex < 0) continue

      const envelope = sampleWaveformEnvelope(data, fromIndex, toIndex)
      const top = displayAmplitude(envelope.top, normalization)
      const bottom = displayAmplitude(envelope.bottom, normalization)
      const y0 = centerY - top * halfH
      const y1 = centerY + bottom * halfH
      // A hairline floor keeps silence visible instead of disappearing.
      const barHeight = Math.max(1.25, y1 - y0)
      ctx.rect(x, y0, 1, barHeight)
    }
    ctx.fill()

    // Center axis hairline in the track accent.
    ctx.fillStyle = rgba(accent, 0.35)
    ctx.fillRect(0, centerY - 0.5, cssW, 1)
  }, [
    clip,
    clipWindow,
    colorVar,
    data,
    height,
    normalization,
    pixelsPerMs,
  ])

  if (!clipWindow) return null

  const widthPx = (clipWindow.endMs - clipWindow.startMs) * pixelsPerMs
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute top-0"
      style={{
        left: (clipWindow.startMs - clip.startMs) * pixelsPerMs,
        width: widthPx,
        height,
      }}
    />
  )
})
