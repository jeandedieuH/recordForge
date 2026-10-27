import { useMemo, useRef } from "react"
import type {
  AudioClip,
  MediaAudioTrackOutput,
  TimelineClip,
  TimelineTrack,
} from "@recordforge/contracts"
import {
  buildPreviewSegments,
  evaluateVolumeEnvelope,
  type PreviewSegment,
} from "@recordforge/editor-core"
import { toAssetUrl } from "../../../lib/assets"
import { useDualMediaSlots } from "./playback/use-dual-media-slots"
import { usePlayheadMs } from "./use-playback-state"

interface PreviewAudioTrackGroup {
  /** Timeline track id. */
  id: string
  clips: AudioClip[]
  /** clip id → playable URL. */
  sourceByClip: Map<string, string>
  volume: number
  muted: boolean
}

interface AudioTrackPreviewProps {
  tracks: TimelineTrack[]
  outputs: MediaAudioTrackOutput[]
  isPlaying: boolean
  playbackRate: number
  frameMs: number
  assetPaths?: Record<string, string>
  workDir?: string | null
  isVideoSeeking?: boolean
}

function fadeMultiplier(clip: AudioClip, playheadMs: number): number {
  const clipTimeMs = (playheadMs - clip.startMs) * clip.speed
  const envelopeVolume = evaluateVolumeEnvelope(clip, clipTimeMs)
  return clip.volume > 0 ? envelopeVolume / clip.volume : 0
}

function clipAt(clips: AudioClip[], playheadMs: number): AudioClip | null {
  return (
    clips.find(
      (clip) => playheadMs >= clip.startMs && playheadMs < clip.startMs + clip.durationMs,
    ) ?? null
  )
}

function buildPreviewTracks(
  tracks: TimelineTrack[],
  outputs: MediaAudioTrackOutput[],
  assetPaths: Record<string, string>,
  workDir?: string | null,
): PreviewAudioTrackGroup[] {
  const outputsByStream = new Map(outputs.map((output) => [output.streamIndex, output]))
  const hasSoloTrack = tracks.some((track) => track.kind === "audio" && track.solo)

  return tracks.flatMap((track) => {
    if (track.kind !== "audio") return []
    const isExcludedBySolo = hasSoloTrack && !track.solo
    const clips: AudioClip[] = []
    const sourceByClip = new Map<string, string>()
    for (const clip of track.clips) {
      if (clip.kind !== "audio") continue
      const output = outputsByStream.get(clip.streamIndex ?? -1)
      const sourcePath = output?.audioPath ?? assetPaths[clip.assetId]
      if (!sourcePath) continue
      const source = toAssetUrl(sourcePath, workDir)
      if (!source) continue
      clips.push(clip)
      sourceByClip.set(clip.id, source)
    }
    if (clips.length === 0) return []
    return [
      {
        id: track.id,
        clips,
        sourceByClip,
        volume: Math.max(0, Math.min(1, track.volume)),
        muted: track.muted || isExcludedBySolo,
      },
    ]
  })
}

interface AudioTrackPreviewTrackProps extends Omit<
  AudioTrackPreviewProps,
  "tracks" | "outputs" | "assetPaths" | "workDir"
> {
  group: PreviewAudioTrackGroup
}

/**
 * One audio track on a pair of media elements. The standby is pre-seeked to
 * the next segment so a cut swaps elements instead of seeking a cold one.
 */
function AudioTrackPreviewTrack({
  group,
  isPlaying,
  playbackRate,
  frameMs,
  isVideoSeeking = false,
}: AudioTrackPreviewTrackProps) {
  const playheadMs = usePlayheadMs()
  const slot0 = useRef<HTMLAudioElement>(null)
  const slot1 = useRef<HTMLAudioElement>(null)
  const slots = useMemo(
    () =>
      [slot0, slot1] as [
        React.RefObject<HTMLAudioElement | null>,
        React.RefObject<HTMLAudioElement | null>,
      ],
    [],
  )
  const segments = useMemo(
    () =>
      buildPreviewSegments(
        group.clips as TimelineClip[],
        (clip) => group.sourceByClip.get(clip.id) ?? "",
      ),
    [group.clips, group.sourceByClip],
  )

  const { activeSlot } = useDualMediaSlots({
    segments,
    playheadMs,
    // A user scrub pauses the screen element; cut swaps no longer seek, so the
    // audio only needs to stop for real seeks.
    isPlaying: isPlaying && !isVideoSeeking,
    playbackRate,
    frameMs,
    kind: "audio",
    enabled: !group.muted && group.volume > 0,
    slots,
    sourceUrlOf: (sourceKey) => sourceKey || null,
    onSync: (_slot, segment: PreviewSegment | null, element, isActive) => {
      if (!isActive || !segment) {
        element.muted = true
        element.volume = 0
        return
      }
      const clip = clipAt(group.clips, playheadMs)
      element.muted = group.muted
      element.volume = clip ? Math.min(1, group.volume * fadeMultiplier(clip, playheadMs)) : 0
    },
  })

  return (
    <>
      <audio
        ref={slot0}
        preload="auto"
        aria-hidden
        style={{ display: activeSlot === 0 ? undefined : "none" }}
      />
      <audio
        ref={slot1}
        preload="auto"
        aria-hidden
        style={{ display: activeSlot === 1 ? undefined : "none" }}
      />
    </>
  )
}

export function AudioTrackPreview({
  tracks,
  outputs,
  isPlaying,
  playbackRate,
  frameMs,
  assetPaths = {},
  workDir,
  isVideoSeeking = false,
}: AudioTrackPreviewProps) {
  const previewTracks = useMemo(
    () => buildPreviewTracks(tracks, outputs, assetPaths, workDir),
    [assetPaths, outputs, tracks, workDir],
  )

  return (
    <div className="hidden" aria-hidden>
      {previewTracks.map((group) => (
        <AudioTrackPreviewTrack
          key={group.id}
          group={group}
          isPlaying={isPlaying}
          playbackRate={playbackRate}
          frameMs={frameMs}
          isVideoSeeking={isVideoSeeking}
        />
      ))}
    </div>
  )
}
