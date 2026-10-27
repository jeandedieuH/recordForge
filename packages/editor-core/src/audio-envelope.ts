import type { AudioClip, AudioVolumeKeyframe } from "@recordforge/contracts"

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

/** Volume envelope fields a surviving audio piece carries after a cut. */
export interface AudioPieceEnvelope {
  fadeInMs: number
  fadeOutMs: number
  volumeKeyframes?: AudioVolumeKeyframe[]
}

function interpolateKeyframeVolume(keyframes: AudioVolumeKeyframe[], timeMs: number): number {
  if (keyframes.length === 0) return 1
  const first = keyframes[0]!
  const last = keyframes[keyframes.length - 1]!
  if (timeMs <= first.timeMs) return first.volume
  if (timeMs >= last.timeMs) return last.volume
  for (let index = 0; index < keyframes.length - 1; index++) {
    const left = keyframes[index]!
    const right = keyframes[index + 1]!
    if (timeMs >= left.timeMs && timeMs <= right.timeMs) {
      const span = right.timeMs - left.timeMs
      const ratio = span > 0 ? (timeMs - left.timeMs) / span : 0
      return left.volume + ratio * (right.volume - left.volume)
    }
  }
  return last.volume
}

/**
 * Split one audio clip's envelope so a surviving piece fades only on the side
 * that is still the clip's real edge.
 *
 * Keyframe times are clip-local source milliseconds (the same clock the
 * preview's `evaluateVolumeEnvelope` uses), so a piece's keyframes are
 * rebased by its source offset and get interpolated edge points — otherwise a
 * cut through a ramp would restart it from the first stored keyframe.
 */
export function partitionAudioEnvelope(
  clip: AudioClip,
  piece: {
    durationMs: number
    sourceInMs: number
    keepFadeIn: boolean
    keepFadeOut: boolean
  },
): AudioPieceEnvelope {
  const durationMs = Math.max(0, piece.durationMs)
  const fadeInMs = piece.keepFadeIn ? Math.min(clip.fadeInMs, durationMs) : 0
  const fadeOutMs = piece.keepFadeOut ? Math.min(clip.fadeOutMs, durationMs) : 0
  const keyframes = clip.volumeKeyframes
  if (!keyframes || keyframes.length === 0) {
    return { fadeInMs, fadeOutMs }
  }

  const sorted = [...keyframes].sort((left, right) => left.timeMs - right.timeMs)
  const speed = clip.speed > 0 ? clip.speed : 1
  const fromMs = Math.max(0, piece.sourceInMs - clip.sourceInMs)
  const coveredMs = Math.max(0, Math.round(durationMs * speed))
  const toMs = fromMs + coveredMs

  const rebased: AudioVolumeKeyframe[] = sorted
    .filter((keyframe) => keyframe.timeMs >= fromMs - 0.5 && keyframe.timeMs <= toMs + 0.5)
    .map((keyframe) => ({
      ...keyframe,
      timeMs: Math.max(0, Math.round(keyframe.timeMs - fromMs)),
    }))

  if (rebased.length === 0 || rebased[0]!.timeMs > 0) {
    rebased.unshift({
      id: `${clip.id}:piece:start`,
      timeMs: 0,
      volume: interpolateKeyframeVolume(sorted, fromMs),
    })
  } else {
    rebased[0] = { ...rebased[0]!, timeMs: 0 }
  }
  const last = rebased[rebased.length - 1]!
  if (last.timeMs < coveredMs) {
    rebased.push({
      id: `${clip.id}:piece:end`,
      timeMs: coveredMs,
      volume: interpolateKeyframeVolume(sorted, toMs),
    })
  } else {
    rebased[rebased.length - 1] = { ...last, timeMs: coveredMs }
  }

  return { fadeInMs, fadeOutMs, volumeKeyframes: rebased }
}
