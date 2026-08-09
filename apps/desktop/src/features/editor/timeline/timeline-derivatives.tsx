import type { CSSProperties } from "react"
import type { TimelineClip } from "@recordforge/contracts"
import type { ThumbnailManifest, WaveformData } from "../media/derivative-resources"
import { cn } from "@recordforge/ui"

interface ThumbnailStripProps {
  clip: TimelineClip
  manifest: ThumbnailManifest
  spriteUrl: string
  pixelsPerMs: number
  visibleStartMs: number
  visibleEndMs: number
  onSpriteError: () => void
}

function spriteStyle(manifest: ThumbnailManifest, index: number, spriteUrl: string): CSSProperties {
  const column = index % manifest.columns
  const row = Math.floor(index / manifest.columns)
  return {
    backgroundImage: `url(${spriteUrl})`,
    backgroundPosition: `${manifest.columns <= 1 ? 0 : (column / (manifest.columns - 1)) * 100}% ${manifest.rows <= 1 ? 0 : (row / (manifest.rows - 1)) * 100}%`,
    backgroundSize: `${manifest.columns * 100}% ${manifest.rows * 100}%`,
  }
}

export function ThumbnailStrip({
  clip,
  manifest,
  spriteUrl,
  pixelsPerMs,
  visibleStartMs,
  visibleEndMs,
  onSpriteError,
}: ThumbnailStripProps) {
  if (clip.kind !== "screen" && clip.kind !== "camera") return null
  if (manifest.count === 0 || manifest.intervalMs <= 0 || !spriteUrl) return null

  const clipEndMs = clip.startMs + clip.durationMs
  const timelineStartMs = Math.max(clip.startMs, visibleStartMs)
  const timelineEndMs = Math.min(clipEndMs, visibleEndMs)
  if (timelineEndMs <= timelineStartMs) return null

  const sourceStartMs = clip.sourceInMs + (timelineStartMs - clip.startMs) * clip.speed
  const sourceEndMs = clip.sourceInMs + (timelineEndMs - clip.startMs) * clip.speed
  const firstIndex = Math.max(0, Math.floor(sourceStartMs / manifest.intervalMs) - 1)
  const lastIndex = Math.min(manifest.count - 1, Math.ceil(sourceEndMs / manifest.intervalMs) + 1)

  return (
    <span className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {Array.from({ length: Math.max(0, lastIndex - firstIndex + 1) }, (_, offset) => {
        const index = firstIndex + offset
        const frameSourceMs = index * manifest.intervalMs
        if (frameSourceMs < clip.sourceInMs || frameSourceMs > clip.sourceOutMs) return null
        const frameTimelineMs =
          clip.startMs + (frameSourceMs - clip.sourceInMs) / Math.max(clip.speed, 0.001)
        const frameWidth = (manifest.intervalMs / Math.max(clip.speed, 0.001)) * pixelsPerMs

        return (
          <span
            key={index}
            className="absolute inset-y-0 rounded-sm bg-surface-dim bg-cover bg-center opacity-80 first:rounded-l-md last:rounded-r-md"
            style={{
              left: `${(frameTimelineMs - clip.startMs) * pixelsPerMs}px`,
              width: `${Math.max(frameWidth, 1)}px`,
              ...spriteStyle(manifest, index, spriteUrl),
            }}
            onError={onSpriteError}
          />
        )
      })}
    </span>
  )
}

interface WaveformStripProps {
  clip: TimelineClip
  data: WaveformData
  pixelsPerMs: number
  visibleStartMs: number
  visibleEndMs: number
}

export function WaveformStrip({
  clip,
  data,
  pixelsPerMs,
  visibleStartMs,
  visibleEndMs,
}: WaveformStripProps) {
  if (clip.kind !== "audio" || data.peaks.length === 0 || data.durationMs <= 0) return null

  const clipEndMs = clip.startMs + clip.durationMs
  const timelineStartMs = Math.max(clip.startMs, visibleStartMs)
  const timelineEndMs = Math.min(clipEndMs, visibleEndMs)
  if (timelineEndMs <= timelineStartMs) return null

  const sourceStartMs = clip.sourceInMs + (timelineStartMs - clip.startMs) * clip.speed
  const sourceEndMs = Math.min(
    data.durationMs,
    clip.sourceInMs + (timelineEndMs - clip.startMs) * clip.speed,
  )
  const visibleWidth = Math.max(1, (timelineEndMs - timelineStartMs) * pixelsPerMs)
  const barCount = Math.min(320, Math.max(24, Math.ceil(visibleWidth / 3)))
  const peakStart = Math.max(0, Math.floor((sourceStartMs / data.durationMs) * data.peaks.length))
  const peakEnd = Math.min(
    data.peaks.length,
    Math.max(peakStart + 1, Math.ceil((sourceEndMs / data.durationMs) * data.peaks.length)),
  )
  const step = Math.max(1, Math.ceil((peakEnd - peakStart) / barCount))
  const bars = []

  for (let index = peakStart; index < peakEnd; index += step) {
    const peak = data.peaks[index] ?? 0
    const barSourceMs = (index / data.peaks.length) * data.durationMs
    const barTimelineMs =
      clip.startMs + (barSourceMs - clip.sourceInMs) / Math.max(clip.speed, 0.001)
    const barWidth =
      ((Math.min(step, peakEnd - index) / data.peaks.length) * data.durationMs * pixelsPerMs) /
      Math.max(clip.speed, 0.001)
    bars.push(
      <span
        key={index}
        className="absolute bottom-1 top-1 min-w-px rounded-full bg-current opacity-75"
        style={{
          left: `${(barTimelineMs - clip.startMs) * pixelsPerMs}px`,
          width: `${Math.max(1, barWidth)}px`,
          height: `${Math.max(8, Math.min(100, Math.round(peak * 100)))}%`,
        }}
      />,
    )
  }

  return (
    <span
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden text-track-mic",
        clip.kind === "audio" && "mix-blend-screen",
      )}
      aria-hidden
    >
      {bars}
    </span>
  )
}
