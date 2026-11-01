import { memo } from "react"
import type { AudioClip } from "@recordforge/contracts"

export interface AudioFadeHintProps {
  clip: AudioClip
  pixelsPerMs: number
  height: number
}

/**
 * Passive stand-in for the interactive envelope: when the envelope is hidden
 * (clip not hovered/selected), fade-ins/outs still read via a darkened
 * triangle above each ramp. Renders nothing on clips without fades.
 */
export const AudioFadeHint = memo(function AudioFadeHint({
  clip,
  pixelsPerMs,
  height,
}: AudioFadeHintProps) {
  const width = Math.max(1, clip.durationMs * pixelsPerMs)
  const fadeInX = Math.min(width, clip.fadeInMs * pixelsPerMs)
  const fadeOutX = Math.max(0, (clip.durationMs - clip.fadeOutMs) * pixelsPerMs)
  if (clip.fadeInMs <= 0 && clip.fadeOutMs <= 0) return null

  // Roughly matches the envelope geometry: vol 0 near the bottom, sustained
  // level ~28% from the top.
  const floorY = height - 4
  const sustainedY = Math.max(3, height * 0.28)

  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 size-full"
      style={{ width, height }}
    >
      {clip.fadeInMs > 0 ? (
        <polygon
          points={`0,${sustainedY} ${fadeInX},${sustainedY} 0,${floorY}`}
          className="fill-background/45"
        />
      ) : null}
      {clip.fadeOutMs > 0 ? (
        <polygon
          points={`${fadeOutX},${sustainedY} ${width},${sustainedY} ${width},${floorY}`}
          className="fill-background/45"
        />
      ) : null}
    </svg>
  )
})
