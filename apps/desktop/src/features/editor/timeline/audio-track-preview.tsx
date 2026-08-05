import { useEffect, useMemo, useRef } from "react"
import { convertFileSrc } from "@tauri-apps/api/core"
import type { AudioClip, MediaAudioTrackOutput, TimelineTrack } from "@recordforge/contracts"
import { isTauri } from "../../../lib/settings"

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
}

function toAssetUrl(path: string): string {
  return isTauri() ? convertFileSrc(path) : path
}

function buildPreviewTracks(
  tracks: TimelineTrack[],
  outputs: MediaAudioTrackOutput[],
): PreviewAudioTrack[] {
  const outputsByStream = new Map(outputs.map((output) => [output.streamIndex, output]))
  const hasSoloTrack = tracks.some((track) => track.kind === "audio" && track.solo)

  return tracks.flatMap((track) => {
    if (track.kind !== "audio") return []
    const isExcludedBySolo = hasSoloTrack && !track.solo

    return track.clips.flatMap((clip) => {
      if (clip.kind !== "audio") return []
      const output = outputsByStream.get(clip.streamIndex ?? -1)
      if (!output?.audioPath) return []

      return [
        {
          id: clip.id,
          clip,
          source: toAssetUrl(output.audioPath),
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
}: AudioTrackPreviewProps) {
  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({})
  const previewTracks = useMemo(() => buildPreviewTracks(tracks, outputs), [outputs, tracks])

  useEffect(() => {
    for (const previewTrack of previewTracks) {
      const element = audioRefs.current[previewTrack.id]
      if (!element) continue
      element.volume = previewTrack.volume
      element.playbackRate = Math.max(0.25, Math.min(4, previewTrack.clip.speed))
      element.muted = previewTrack.muted || previewTrack.volume === 0
    }
  }, [previewTracks])

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
