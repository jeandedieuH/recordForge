import { useEffect, useMemo, useRef } from "react"
import type { AudioClip, MediaAudioTrackOutput, TimelineTrack } from "@recordforge/contracts"
import { toAssetUrl } from "../../../lib/assets"

interface PreviewAudioTrack {
  id: string
  clip: AudioClip
  source: string
  volume: number
  muted: boolean
}

interface AudioTrackPreviewProps {
  tracks: TimelineTrack[]
  outputs: MediaAudioTrackOutput[]
  playheadMs: number
  isPlaying: boolean
  playbackRate: number
  assetPaths?: Record<string, string>
  workDir?: string | null
}

function fadeMultiplier(clip: AudioClip, playheadMs: number): number {
  const clipTimeMs = (playheadMs - clip.startMs) * clip.speed
  const fadeIn = Math.min(clip.fadeInMs, clip.durationMs)
  const fadeOut = Math.min(clip.fadeOutMs, clip.durationMs)
  const fadeInGain = fadeIn > 0 ? Math.min(1, Math.max(0, clipTimeMs / fadeIn)) : 1
  const fadeOutStart = Math.max(0, clip.durationMs - fadeOut)
  const fadeOutGain =
    fadeOut > 0 && clipTimeMs > fadeOutStart
      ? Math.min(1, Math.max(0, (clip.durationMs - clipTimeMs) / fadeOut))
      : 1
  return Math.min(fadeInGain, fadeOutGain)
}

function buildPreviewTracks(
  tracks: TimelineTrack[],
  outputs: MediaAudioTrackOutput[],
  assetPaths: Record<string, string>,
  workDir?: string | null,
): PreviewAudioTrack[] {
  const outputsByStream = new Map(outputs.map((output) => [output.streamIndex, output]))
  const hasSoloTrack = tracks.some((track) => track.kind === "audio" && track.solo)

  return tracks.flatMap((track) => {
    if (track.kind !== "audio") return []
    const isExcludedBySolo = hasSoloTrack && !track.solo

    return track.clips.flatMap((clip) => {
      if (clip.kind !== "audio") return []
      const output = outputsByStream.get(clip.streamIndex ?? -1)
      const sourcePath = output?.audioPath ?? assetPaths[clip.assetId]
      if (!sourcePath) return []

      const source = toAssetUrl(sourcePath, workDir)
      if (!source) return []

      return [
        {
          id: clip.id,
          clip,
          source,
          volume: Math.max(0, Math.min(1, track.volume * clip.volume)),
          muted: track.muted || isExcludedBySolo,
        },
      ]
    })
  })
}

export function AudioTrackPreview({
  tracks,
  outputs,
  playheadMs,
  isPlaying,
  playbackRate,
  assetPaths = {},
  workDir,
}: AudioTrackPreviewProps) {
  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({})
  const previewTracks = useMemo(
    () => buildPreviewTracks(tracks, outputs, assetPaths, workDir),
    [assetPaths, outputs, tracks, workDir],
  )

  useEffect(() => {
    for (const previewTrack of previewTracks) {
      const element = audioRefs.current[previewTrack.id]
      if (!element) continue
      element.volume = Math.min(
        1,
        previewTrack.volume * fadeMultiplier(previewTrack.clip, playheadMs),
      )
      element.playbackRate = Math.max(0.25, Math.min(4, previewTrack.clip.speed * playbackRate))
      element.muted = previewTrack.muted || previewTrack.volume === 0
    }
  }, [playbackRate, playheadMs, previewTracks])

  useEffect(() => {
    for (const previewTrack of previewTracks) {
      const element = audioRefs.current[previewTrack.id]
      if (!element) continue
      const clipTimeMs = Math.max(
        0,
        (playheadMs - previewTrack.clip.startMs) * previewTrack.clip.speed +
          previewTrack.clip.sourceInMs,
      )
      if (Math.abs(element.currentTime * 1000 - clipTimeMs) > 80) {
        element.currentTime = clipTimeMs / 1000
      }
    }
  }, [playheadMs, previewTracks])

  useEffect(() => {
    for (const previewTrack of previewTracks) {
      const element = audioRefs.current[previewTrack.id]
      if (!element) continue
      const isInsideClip =
        playheadMs >= previewTrack.clip.startMs &&
        playheadMs < previewTrack.clip.startMs + previewTrack.clip.durationMs
      if (isPlaying && isInsideClip && !previewTrack.muted && previewTrack.volume > 0) {
        void element.play().catch(() => undefined)
      } else {
        element.pause()
      }
    }
  }, [isPlaying, playheadMs, previewTracks])

  return (
    <div className="hidden" aria-hidden>
      {previewTracks.map((previewTrack) => (
        <audio
          key={previewTrack.id}
          ref={(element) => {
            audioRefs.current[previewTrack.id] = element
          }}
          src={previewTrack.source}
          preload="auto"
        />
      ))}
    </div>
  )
}
