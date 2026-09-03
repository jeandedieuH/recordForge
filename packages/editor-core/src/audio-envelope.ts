import type { AudioClip } from "@recordforge/contracts"

/**
 * Evaluates the volume gain multiplier for an AudioClip at a given time inside the clip.
 * @param clip The AudioClip with volume, fadeInMs, fadeOutMs, and optional volumeKeyframes
 * @param clipTimeMs Time in milliseconds relative to clip start (0 <= clipTimeMs <= clip.durationMs)
 * @returns Gain multiplier between 0 and 2
 */
export function evaluateVolumeEnvelope(clip: AudioClip, clipTimeMs: number): number {
  if (clipTimeMs < 0 || clipTimeMs > clip.durationMs) {
    return 0
  }

  // Keyframed volume envelope
  if (clip.volumeKeyframes && clip.volumeKeyframes.length > 0) {
    const keyframes = [...clip.volumeKeyframes].sort((a, b) => a.timeMs - b.timeMs)
    const firstKf = keyframes[0]
    const lastKf = keyframes[keyframes.length - 1]

    // Before first keyframe
    if (firstKf && clipTimeMs <= firstKf.timeMs) {
      if (clip.fadeInMs > 0 && clipTimeMs < clip.fadeInMs) {
        const fadeRatio = Math.max(0, Math.min(1, clipTimeMs / clip.fadeInMs))
        return fadeRatio * firstKf.volume
      }
      return firstKf.volume
    }

    // After last keyframe
    if (lastKf && clipTimeMs >= lastKf.timeMs) {
      const fadeOutStart = Math.max(0, clip.durationMs - clip.fadeOutMs)
      if (clip.fadeOutMs > 0 && clipTimeMs > fadeOutStart) {
        const fadeRatio = Math.max(0, Math.min(1, (clip.durationMs - clipTimeMs) / clip.fadeOutMs))
        return fadeRatio * lastKf.volume
      }
      return lastKf.volume
    }

    // Between keyframes: piecewise linear interpolation
    for (let i = 0; i < keyframes.length - 1; i++) {
      const kfA = keyframes[i]
      const kfB = keyframes[i + 1]
      if (!kfA || !kfB) continue
      if (clipTimeMs >= kfA.timeMs && clipTimeMs <= kfB.timeMs) {
        const span = kfB.timeMs - kfA.timeMs
        const ratio = span > 0 ? (clipTimeMs - kfA.timeMs) / span : 0
        const interpolated = kfA.volume + ratio * (kfB.volume - kfA.volume)
        return Math.max(0, Math.min(2, interpolated))
      }
    }
  }

  // Standard volume envelope with fade-in and fade-out
  const fadeIn = Math.min(clip.fadeInMs, clip.durationMs)
  const fadeOut = Math.min(clip.fadeOutMs, clip.durationMs)
  const fadeInGain = fadeIn > 0 ? Math.min(1, Math.max(0, clipTimeMs / fadeIn)) : 1
  const fadeOutStart = Math.max(0, clip.durationMs - fadeOut)
  const fadeOutGain =
    fadeOut > 0 && clipTimeMs > fadeOutStart
      ? Math.min(1, Math.max(0, (clip.durationMs - clipTimeMs) / fadeOut))
      : 1

  return Math.max(0, Math.min(2, clip.volume * Math.min(fadeInGain, fadeOutGain)))
}
