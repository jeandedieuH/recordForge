import type {
  AudioClip,
  CameraClip,
  LibraryRecording,
  MediaMetadata,
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

export function createTimelineFromRecording(
  recording: LibraryRecording,
  metadata: MediaMetadata,
  name?: string,
): TimelineState {
  const now = new Date().toISOString()
  const duration = metadata.durationMs

  const screenClip: ScreenClip = {
    id: crypto.randomUUID(),
    kind: "screen",
    assetId: recording.id,
    startMs: 0,
    durationMs: duration,
    sourceInMs: 0,
    sourceOutMs: duration,
    speed: 1,
  }

  const tracks: TimelineTrack[] = [
    {
      id: crypto.randomUUID(),
      kind: "screen",
      name: "Screen",
      muted: false,
      locked: false,
      solo: false,
      volume: 1,
      clips: [screenClip],
    },
  ]

  if (metadata.hasAudio) {
    const audioClip: AudioClip = {
      id: crypto.randomUUID(),
      kind: "audio",
      assetId: recording.id,
      startMs: 0,
      durationMs: duration,
      sourceInMs: 0,
      sourceOutMs: duration,
      speed: 1,
      volume: 1,
      fadeInMs: 0,
      fadeOutMs: 0,
    }
    tracks.push({
      id: crypto.randomUUID(),
      kind: "audio",
      name: "Audio",
      muted: false,
      locked: false,
      solo: false,
      volume: 1,
      clips: [audioClip],
    })
  }

  if (
    recording.source.kind === "display" ||
    recording.source.kind === "window" ||
    recording.source.kind === "region"
  ) {
    const cameraClip: CameraClip = {
      id: crypto.randomUUID(),
      kind: "camera",
      assetId: recording.id,
      startMs: 0,
      durationMs: duration,
      sourceInMs: 0,
      sourceOutMs: duration,
      speed: 1,
      transform: {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        opacity: 1,
        shape: "rectangle",
      },
    }
    tracks.push({
      id: crypto.randomUUID(),
      kind: "camera",
      name: "Camera",
      muted: false,
      locked: false,
      solo: false,
      volume: 1,
      clips: [cameraClip],
    })
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
