import { memo, useEffect, useRef } from "react"
import type { TimelineClip } from "@recordforge/contracts"
import type { WaveformData } from "../media/derivative-resources"
import { cn } from "@recordforge/ui"

export interface TimelineCanvasWaveformProps {
  clip: TimelineClip
  data: WaveformData
  pixelsPerMs: number
  visibleStartMs: number
  visibleEndMs: number
  color?: string
  className?: string
}

export const TimelineCanvasWaveform = memo(function TimelineCanvasWaveform({
  clip,
  data,
  pixelsPerMs,
  visibleStartMs,
  visibleEndMs,
  color,
  className,
}: TimelineCanvasWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const clipEndMs = clip.startMs + clip.durationMs
  const timelineStartMs = Math.max(clip.startMs, visibleStartMs)
  const timelineEndMs = Math.min(clipEndMs, visibleEndMs)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (clip.kind !== "audio" || data.peaks.length === 0 || data.durationMs <= 0) return
    if (timelineEndMs <= timelineStartMs) return

    const rect = canvas.getBoundingClientRect()
    const displayWidth = Math.max(1, rect.width)
    const displayHeight = Math.max(1, rect.height)
    const dpr = window.devicePixelRatio || 1

    canvas.width = Math.round(displayWidth * dpr)
    canvas.height = Math.round(displayHeight * dpr)

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, displayWidth, displayHeight)

    const speed = Math.max(clip.speed, 0.001)
    const sourceStartMs = clip.sourceInMs + (timelineStartMs - clip.startMs) * speed
    const sourceEndMs = Math.min(
      data.durationMs,
      clip.sourceInMs + (timelineEndMs - clip.startMs) * speed,
    )

    const peakStart = Math.max(0, Math.floor((sourceStartMs / data.durationMs) * data.peaks.length))
    const peakEnd = Math.min(
      data.peaks.length,
      Math.max(peakStart + 1, Math.ceil((sourceEndMs / data.durationMs) * data.peaks.length)),
    )

    // Bar width and spacing for crisp anti-aliasing
    const barWidth = 2
    const gap = 1
    const stride = barWidth + gap
    const barCount = Math.max(1, Math.floor(displayWidth / stride))
    const step = Math.max(1, Math.floor((peakEnd - peakStart) / barCount))

    const centerY = displayHeight / 2

    // Create vertical gradient for audio waveform aesthetics
    const gradient = ctx.createLinearGradient(0, 0, 0, displayHeight)
    if (color) {
      gradient.addColorStop(0, color)
      gradient.addColorStop(0.5, color)
      gradient.addColorStop(1, color)
    } else {
      gradient.addColorStop(0, "rgba(52, 211, 153, 0.95)") // Emerald top
      gradient.addColorStop(0.5, "rgba(56, 189, 248, 0.9)") // Cyan center
      gradient.addColorStop(1, "rgba(52, 211, 153, 0.75)") // Emerald bottom
    }

    ctx.fillStyle = gradient

    for (let i = 0; i < barCount; i++) {
      const peakIndex = Math.min(peakEnd - 1, peakStart + i * step)
      const rawPeak = data.peaks[peakIndex] ?? 0

      // Normalize amplitude between 4% and 92% of track height
      const amplitude = Math.max(0.06, Math.min(0.92, Math.abs(rawPeak)))
      const barHeight = Math.max(2, amplitude * displayHeight)
      const x = i * stride
      const y = centerY - barHeight / 2

      // Draw rounded rectangle bar
      if (typeof ctx.roundRect === "function") {
        ctx.beginPath()
        ctx.roundRect(x, y, barWidth, barHeight, 1)
        ctx.fill()
      } else {
        ctx.fillRect(x, y, barWidth, barHeight)
      }
    }
  }, [
    clip.kind,
    clip.sourceInMs,
    clip.sourceOutMs,
    clip.speed,
    clip.startMs,
    clip.durationMs,
    data.durationMs,
    data.peaks,
    pixelsPerMs,
    timelineEndMs,
    timelineStartMs,
    color,
  ])

  if (clip.kind !== "audio" || data.peaks.length === 0 || data.durationMs <= 0) return null
  if (timelineEndMs <= timelineStartMs) return null

  return (
    <canvas
      ref={canvasRef}
      className={cn(
        "pointer-events-none absolute inset-0 size-full overflow-hidden opacity-90",
        className,
      )}
      aria-hidden
    />
  )
})
