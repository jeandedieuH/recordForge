import { memo, useLayoutEffect, useRef } from "react"
import { fitCanvas, resolveThemeColor, rgba } from "../../timeline/clip-canvas"
import type { SmartCutReviewRange } from "../../../../stores/smart-cut-store"

interface SilenceOverviewStripProps {
  /** Timeline-time loudness envelope (from `timelineEnvelope`). */
  envelope: { bucketMs: number; amplitudes: number[] }
  /** Detected ranges in timeline ms; excluded ones render dimmed. */
  ranges: SmartCutReviewRange[]
  excludedIds: string[]
  /** Full timeline span in ms so band positions match the real timeline. */
  durationMs: number
  /** Clicking the strip seeks the playhead to that timeline position. */
  onSeek?: (ms: number) => void
  height?: number
}

/**
 * Compact "what you'd hear" overview: the capture-audio envelope across the
 * whole timeline with every detected dead-air range shaded red. Cut bands sit
 * in timeline space, so the strip always matches what apply will remove.
 */
export const SilenceOverviewStrip = memo(function SilenceOverviewStrip({
  envelope,
  ranges,
  excludedIds,
  durationMs,
  onSeek,
  height = 40,
}: SilenceOverviewStripProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const box = boxRef.current
    if (!canvas || !box || envelope.amplitudes.length === 0) return
    const cssW = box.clientWidth
    if (cssW <= 0) return
    const ctx = fitCanvas(canvas, cssW, height)
    if (!ctx) return

    const accent =
      resolveThemeColor(canvas, "--color-track-mic") ??
      resolveThemeColor(canvas, "--color-foreground") ??
      ([255, 255, 255] as [number, number, number])

    // Mirror the timeline renderer: sqrt amplitude + a hairline floor so
    // quiet-but-audible regions stay visible next to true silence.
    const centerY = height / 2
    const halfH = height * 0.47
    const columns = envelope.amplitudes.length
    const colW = cssW / columns
    ctx.fillStyle = rgba(accent, 0.7)
    ctx.beginPath()
    for (let i = 0; i < columns; i++) {
      const amplitude = Math.min(1, envelope.amplitudes[i] ?? 0)
      const barHeight = Math.max(1.25, Math.sqrt(amplitude) * halfH * 2)
      ctx.rect(i * colW, centerY - barHeight / 2, Math.max(1, colW - 0.5), barHeight)
    }
    ctx.fill()
    ctx.fillStyle = rgba(accent, 0.3)
    ctx.fillRect(0, centerY - 0.5, cssW, 1)
  }, [envelope, height])

  function handleSeek(event: React.MouseEvent<HTMLDivElement>) {
    if (!onSeek || durationMs <= 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    onSeek(Math.round(fraction * durationMs))
  }

  const excluded = new Set(excludedIds)
  const px = (ms: number) => `${(ms / Math.max(1, durationMs)) * 100}%`

  return (
    <div
      ref={boxRef}
      role={onSeek ? "button" : undefined}
      tabIndex={onSeek ? 0 : undefined}
      aria-label="Audio overview — click to move the playhead"
      onClick={handleSeek}
      onKeyDown={(event) => {
        if (onSeek && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault()
          onSeek(0)
        }
      }}
      className="relative h-10 w-full cursor-pointer overflow-hidden rounded-md border border-border/80 bg-surface-dim/70"
    >
      <canvas ref={canvasRef} aria-hidden className="absolute inset-0 h-full w-full" />
      {ranges.map((range) => (
        <div
          key={range.id}
          aria-hidden
          className={
            excluded.has(range.id)
              ? "absolute inset-y-0 border-x border-dashed border-recording/25 bg-recording/5"
              : "absolute inset-y-0 border-x border-recording/40 bg-recording/15"
          }
          style={{ left: px(range.startMs), width: px(range.endMs - range.startMs) }}
        />
      ))}
    </div>
  )
})
