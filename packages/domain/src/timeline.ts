import { defaultCursorSettings } from "@recordforge/contracts"
import type {
  AudioClip,
  CameraClip,
  LibraryRecording,
  MediaMetadata,
  MediaStream,
  ScreenClip,
  TimelineClip,
  TimelineMarker,
  TimelineState,
  TimelineTrack,
  TimelineTrackKind,
} from "@recordforge/contracts"

// Pure helpers for reading and validating a timeline.
// No React or DOM dependencies here.

export interface TrackAndClip {
  track: TimelineTrack
  trackIndex: number
  clip: TimelineClip
  clipIndex: number
}

export function getTotalDuration(state: TimelineState): number {
  let duration = 0
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      duration = Math.max(duration, clip.startMs + clip.durationMs)
    }
  }
  for (const marker of state.markers) {
    duration = Math.max(duration, marker.timeMs)
  }
  return duration
}

export function findTrack(state: TimelineState, trackId: string): TimelineTrack | undefined {
  return state.tracks.find((t) => t.id === trackId)
}

export function findClip(state: TimelineState, clipId: string): TrackAndClip | undefined {
  for (let trackIndex = 0; trackIndex < state.tracks.length; trackIndex++) {
    const track = state.tracks[trackIndex]
    for (let clipIndex = 0; clipIndex < track.clips.length; clipIndex++) {
      const clip = track.clips[clipIndex]
      if (clip.id === clipId) {
        return { track, trackIndex, clip, clipIndex }
      }
    }
  }
  return undefined
}

export function getTrackClips(state: TimelineState, trackId: string): TimelineClip[] {
  return findTrack(state, trackId)?.clips ?? []
}

export function findMarker(state: TimelineState, markerId: string): TimelineMarker | undefined {
  return state.markers.find((m) => m.id === markerId)
}

export function clipsOverlap(a: TimelineClip, b: TimelineClip): boolean {
  return a.startMs < b.startMs + b.durationMs && b.startMs < a.startMs + a.durationMs
}

export function sortClips(clips: TimelineClip[]): TimelineClip[] {
  return [...clips].sort((a, b) => a.startMs - b.startMs)
}

export function validateNoOverlap(clips: TimelineClip[], ignoreClipId?: string): boolean {
  const sorted = sortClips(clips.filter((c) => c.id !== ignoreClipId))
  for (let i = 1; i < sorted.length; i++) {
    if (clipsOverlap(sorted[i - 1], sorted[i])) {
      return false
    }
  }
  return true
}

export function sourceTimeFromClipTime(clip: TimelineClip, clipTimeMs: number): number {
  return clip.sourceInMs + clipTimeMs * clip.speed
}

export function clipTimeFromSourceTime(clip: TimelineClip, sourceTimeMs: number): number {
  return (sourceTimeMs - clip.sourceInMs) / clip.speed
}

function makeTrack(kind: TimelineTrackKind, name: string, clips: TimelineClip[]): TimelineTrack {
  return {
    id: crypto.randomUUID(),
    kind,
    name,
    muted: false,
    locked: false,
    solo: false,
    volume: 1,
    clips,
  }
}

function audioStreamName(stream: MediaStream | undefined, index: number): string {
  const title = stream?.title?.trim()
  if (title && title !== "SoundHandler") return title
  if (index === 0) return "Microphone"
  if (index === 1) return "System Audio"
  return `Audio ${index + 1}`
}

function createAudioClip(
  recordingId: string,
  stream: MediaStream | undefined,
  duration: number,
): AudioClip | null {
  const startMs = Math.min(stream?.startMs ?? 0, duration)
  const availableDuration = stream?.durationMs ?? Math.max(0, duration - startMs)
  const clipDuration = Math.min(Math.max(0, availableDuration), Math.max(0, duration - startMs))
  if (clipDuration <= 0) return null

  return {
    id: crypto.randomUUID(),
    kind: "audio",
    assetId: recordingId,
    streamIndex: stream?.index,
    startMs,
    durationMs: clipDuration,
    sourceInMs: 0,
    sourceOutMs: availableDuration,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
  }
}

export function createTimelineFromRecording(
  recording: LibraryRecording,
  metadata: MediaMetadata,
  name?: string,
): TimelineState {
  const now = new Date().toISOString()
  const duration = Math.max(metadata.durationMs, recording.durationMs)
  const videoStreams = metadata.streams.filter((stream) => stream.kind === "video")
  const primaryVideo = videoStreams[0]
  const screenClip: ScreenClip = {
    id: crypto.randomUUID(),
    kind: "screen",
    assetId: recording.id,
    streamIndex: primaryVideo?.index,
    startMs: 0,
    durationMs: duration,
    sourceInMs: 0,
    sourceOutMs: duration,
    speed: 1,
  }

  const tracks: TimelineTrack[] = [makeTrack("screen", "Screen", [screenClip])]
  const audioStreams = metadata.streams.filter((stream) => stream.kind === "audio")
  const audioSources: Array<MediaStream | undefined> = audioStreams.length
    ? audioStreams
    : metadata.hasAudio
      ? [undefined]
      : []

  // Each multiplexed capture stream gets its own aligned track and clip.
  audioSources.forEach((stream, index) => {
    const clip = createAudioClip(recording.id, stream, duration)
    if (clip) tracks.push(makeTrack("audio", audioStreamName(stream, index), [clip]))
  })

  // Keep a camera track only when the source actually contains a second video stream.
  const secondaryVideo = videoStreams[1]
  if (secondaryVideo) {
    const width = metadata.width ?? recording.width
    const height = metadata.height ?? recording.height
    const cameraWidth = Math.round(width * 0.25)
    const cameraHeight = Math.round((cameraWidth * height) / Math.max(1, width))
    const cameraClip: CameraClip = {
      id: crypto.randomUUID(),
      kind: "camera",
      assetId: recording.id,
      streamIndex: secondaryVideo.index,
      startMs: 0,
      durationMs: duration,
      sourceInMs: 0,
      sourceOutMs: duration,
      speed: 1,
      transform: {
        x: width - cameraWidth - 24,
        y: height - cameraHeight - 24,
        width: cameraWidth,
        height: cameraHeight,
        opacity: 1,
        shape: "rounded",
      },
    }
    tracks.splice(1, 0, makeTrack("camera", "Camera", [cameraClip]))
  }

  const markers: TimelineMarker[] = recording.markers.map((m) => ({
    id: m.id,
    timeMs: m.timestampMs,
    label: m.label,
    color: "#f59e0b",
  }))

  return {
    version: 1,
    id: crypto.randomUUID(),
    name: name ?? recording.name,
    recordingId: recording.id,
    canvas: {
      width: metadata.width ?? recording.width,
      height: metadata.height ?? recording.height,
      fps: metadata.fps ? Math.round(metadata.fps) : recording.fps,
      background: "#000000",
      padding: 0,
      borderRadius: 0,
      shadow: false,
      cursorSettings: defaultCursorSettings,
    },
    tracks,
    markers,
    createdAt: now,
    updatedAt: now,
  }
}

export function trackKindDisplayName(kind: TimelineTrackKind): string {
  const names: Record<TimelineTrackKind, string> = {
    screen: "Screen",
    camera: "Camera",
    audio: "Audio",
    captions: "Captions",
    effects: "Effects",
  }
  return names[kind]
}

export function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  const millis = Math.floor((ms % 1000) / 10)
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${millis.toString().padStart(2, "0")}`
}
