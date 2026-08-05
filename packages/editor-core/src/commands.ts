import type {
  AppError,
  AudioClip,
  CameraClip,
  ClipTransform,
  TimelineClip,
  TimelineState,
  TimelineTrack,
  TimelineTrackKind,
  TrackUpdate,
} from "@recordforge/domain"
import {
  findClip,
  findTrack,
  getTrackClips,
  getTotalDuration,
  validateNoOverlap,
} from "@recordforge/domain"
import type { CommandResult } from "./history"

function editorError(code: string, message: string): AppError {
  return { category: "editor", code, message }
}

function now(): string {
  return new Date().toISOString()
}

function updateTrackInState(
  state: TimelineState,
  trackId: string,
  next: TimelineTrack,
): TimelineState {
  return {
    ...state,
    tracks: state.tracks.map((t) => (t.id === trackId ? next : t)),
    updatedAt: now(),
  }
}

function replaceClipInState(
  state: TimelineState,
  trackId: string,
  clipId: string,
  next: TimelineClip,
): TimelineState {
  const track = findTrack(state, trackId)
  if (!track) return state
  return updateTrackInState(state, trackId, {
    ...track,
    clips: track.clips.map((c) => (c.id === clipId ? next : c)),
  })
}

export interface TimelineCommand {
  name: string
  execute(state: TimelineState): CommandResult<TimelineState>
}

function validateClipBoundaries(clip: TimelineClip): CommandResult<TimelineClip> {
  if (clip.sourceInMs >= clip.sourceOutMs) {
    return {
      ok: false,
      error: editorError("invalid_clip", "Clip source in must be less than source out"),
    }
  }
  const expectedDuration = Math.max(0, (clip.sourceOutMs - clip.sourceInMs) / clip.speed)
  if (Math.abs(clip.durationMs - expectedDuration) > 1) {
    return {
      ok: false,
      error: editorError("invalid_clip", "Clip duration must match source range and speed"),
    }
  }
  return { ok: true, value: clip }
}

function sortAndValidateTrack(state: TimelineState, trackId: string): CommandResult<TimelineTrack> {
  const track = findTrack(state, trackId)
  if (!track) {
    return { ok: false, error: editorError("track_not_found", "Track not found") }
  }
  const sorted = [...track.clips].sort((a, b) => a.startMs - b.startMs)
  if (track.kind === "screen" || track.kind === "camera") {
    if (!validateNoOverlap(sorted)) {
      return { ok: false, error: editorError("clip_overlap", "Clips overlap on this track") }
    }
  }
  return { ok: true, value: { ...track, clips: sorted } }
}

export function createAddMarkerCommand(
  timeMs: number,
  label: string,
  color = "#f59e0b",
): TimelineCommand {
  return {
    name: "Add marker",
    execute(state) {
      const marker = {
        id: crypto.randomUUID(),
        timeMs,
        label,
        color,
      }
      return {
        ok: true,
        value: { ...state, markers: [...state.markers, marker], updatedAt: now() },
      }
    },
  }
}

export function createDeleteMarkerCommand(markerId: string): TimelineCommand {
  return {
    name: "Delete marker",
    execute(state) {
      return {
        ok: true,
        value: {
          ...state,
          markers: state.markers.filter((m) => m.id !== markerId),
          updatedAt: now(),
        },
      }
    },
  }
}

export function createAddTrackCommand(kind: TimelineTrackKind, name?: string): TimelineCommand {
  return {
    name: "Add track",
    execute(state) {
      const track: TimelineTrack = {
        id: crypto.randomUUID(),
        kind,
        name: name ?? `${kind} track`,
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [],
      }
      return { ok: true, value: { ...state, tracks: [...state.tracks, track], updatedAt: now() } }
    },
  }
}

export function createDeleteTrackCommand(trackId: string): TimelineCommand {
  return {
    name: "Delete track",
    execute(state) {
      return {
        ok: true,
        value: { ...state, tracks: state.tracks.filter((t) => t.id !== trackId), updatedAt: now() },
      }
    },
  }
}

export function createTrimClipCommand(
  clipId: string,
  sourceInMs: number,
  sourceOutMs: number,
): TimelineCommand {
  return {
    name: "Trim clip",
    execute(state) {
      const found = findClip(state, clipId)
      if (!found) {
        return { ok: false, error: editorError("clip_not_found", "Clip not found") }
      }
      const { track, clip } = found
      const nextClip: TimelineClip = {
        ...clip,
        sourceInMs,
        sourceOutMs,
        durationMs: (sourceOutMs - sourceInMs) / clip.speed,
      }
      const valid = validateClipBoundaries(nextClip)
      if (!valid.ok) return valid

      const trackResult = sortAndValidateTrack(
        replaceClipInState(state, track.id, clipId, valid.value),
        track.id,
      )
      if (!trackResult.ok) return trackResult

      return {
        ok: true,
        value: updateTrackInState(
          replaceClipInState(state, track.id, clipId, valid.value),
          track.id,
          trackResult.value,
        ),
      }
    },
  }
}

export function createSplitClipCommand(clipId: string, splitTimeMs: number): TimelineCommand {
  return {
    name: "Split clip",
    execute(state) {
      const found = findClip(state, clipId)
      if (!found) {
        return { ok: false, error: editorError("clip_not_found", "Clip not found") }
      }
      const { track, clip } = found
      if (splitTimeMs <= clip.startMs + 1 || splitTimeMs >= clip.startMs + clip.durationMs - 1) {
        return { ok: false, error: editorError("invalid_split", "Split time is outside the clip") }
      }
      const splitSource = clip.sourceInMs + (splitTimeMs - clip.startMs) * clip.speed
      if (splitSource <= clip.sourceInMs || splitSource >= clip.sourceOutMs) {
        return {
          ok: false,
          error: editorError("invalid_split", "Split point is outside the source range"),
        }
      }

      const leftDuration = (splitSource - clip.sourceInMs) / clip.speed
      const rightDuration = (clip.sourceOutMs - splitSource) / clip.speed

      const left: TimelineClip = {
        ...clip,
        id: crypto.randomUUID(),
        durationMs: leftDuration,
        sourceOutMs: splitSource,
      }

      const right: TimelineClip = {
        ...clip,
        id: crypto.randomUUID(),
        startMs: splitTimeMs,
        durationMs: rightDuration,
        sourceInMs: splitSource,
      }

      const newClips = track.clips.filter((c) => c.id !== clipId).concat(left, right)
      const newTrack: TimelineTrack = { ...track, clips: newClips }
      const trackResult = sortAndValidateTrack(
        updateTrackInState(state, track.id, newTrack),
        track.id,
      )
      if (!trackResult.ok) return trackResult

      return { ok: true, value: updateTrackInState(state, track.id, trackResult.value) }
    },
  }
}

export function createMoveClipCommand(
  clipId: string,
  newStartMs: number,
  newTrackId?: string,
): TimelineCommand {
  return {
    name: "Move clip",
    execute(state) {
      const found = findClip(state, clipId)
      if (!found) {
        return { ok: false, error: editorError("clip_not_found", "Clip not found") }
      }
      const { track, clip, clipIndex } = found

      if (newStartMs < 0) {
        return { ok: false, error: editorError("invalid_move", "Clip cannot start before zero") }
      }

      const targetTrackId = newTrackId ?? track.id
      const targetTrack = findTrack(state, targetTrackId)
      if (!targetTrack) {
        return { ok: false, error: editorError("track_not_found", "Target track not found") }
      }
      if (targetTrack.kind !== clip.kind) {
        return {
          ok: false,
          error: editorError("invalid_move", "Clip kind does not match target track"),
        }
      }

      if (targetTrackId === track.id) {
        const newClips = [...track.clips]
        newClips[clipIndex] = { ...clip, startMs: newStartMs }
        const trackResult = sortAndValidateTrack(
          updateTrackInState(state, track.id, { ...track, clips: newClips }),
          track.id,
        )
        if (!trackResult.ok) return trackResult
        return { ok: true, value: updateTrackInState(state, track.id, trackResult.value) }
      }

      const sourceClips = track.clips.filter((c) => c.id !== clipId)
      const targetClips = [...targetTrack.clips, { ...clip, startMs: newStartMs }]
      const sourceResult = sortAndValidateTrack(
        updateTrackInState(state, track.id, { ...track, clips: sourceClips }),
        track.id,
      )
      if (!sourceResult.ok) return sourceResult

      const withSource = updateTrackInState(state, track.id, sourceResult.value)
      const targetResult = sortAndValidateTrack(
        updateTrackInState(withSource, targetTrack.id, { ...targetTrack, clips: targetClips }),
        targetTrack.id,
      )
      if (!targetResult.ok) return targetResult

      return { ok: true, value: updateTrackInState(withSource, targetTrack.id, targetResult.value) }
    },
  }
}

export function createDeleteClipCommand(clipId: string): TimelineCommand {
  return {
    name: "Delete clip",
    execute(state) {
      const found = findClip(state, clipId)
      if (!found) {
        return { ok: false, error: editorError("clip_not_found", "Clip not found") }
      }
      const { track } = found
      const newTrack: TimelineTrack = {
        ...track,
        clips: track.clips.filter((c) => c.id !== clipId),
      }
      return { ok: true, value: updateTrackInState(state, track.id, newTrack) }
    },
  }
}

function rippleDeleteFromTrack(
  track: TimelineTrack,
  deleteStartMs: number,
  deleteEndMs: number,
): TimelineTrack {
  const deletedDuration = deleteEndMs - deleteStartMs
  const clips: TimelineClip[] = []

  for (const clip of track.clips) {
    const clipEndMs = clip.startMs + clip.durationMs
    if (clipEndMs <= deleteStartMs) {
      clips.push(clip)
      continue
    }
    if (clip.startMs >= deleteEndMs) {
      clips.push({ ...clip, startMs: clip.startMs - deletedDuration })
      continue
    }

    // Rebuild the portions on either side of the removed range so every
    // aligned audio/video track loses the same source-time window.
    if (clip.startMs < deleteStartMs) {
      const leftDuration = deleteStartMs - clip.startMs
      clips.push({
        ...clip,
        durationMs: leftDuration,
        sourceOutMs: clip.sourceInMs + leftDuration * clip.speed,
      })
    }

    if (clipEndMs > deleteEndMs) {
      const rightDuration = clipEndMs - deleteEndMs
      clips.push({
        ...clip,
        id: clip.startMs < deleteStartMs ? crypto.randomUUID() : clip.id,
        startMs: deleteStartMs,
        durationMs: rightDuration,
        sourceInMs: clip.sourceInMs + (deleteEndMs - clip.startMs) * clip.speed,
      })
    }
  }

  return { ...track, clips }
}

export function createRippleDeleteClipCommand(clipId: string): TimelineCommand {
  return {
    name: "Ripple delete clip",
    execute(state) {
      const found = findClip(state, clipId)
      if (!found) {
        return { ok: false, error: editorError("clip_not_found", "Clip not found") }
      }
      const deleteStartMs = found.clip.startMs
      const deleteEndMs = found.clip.startMs + found.clip.durationMs
      const tracks = state.tracks.map((track) =>
        rippleDeleteFromTrack(track, deleteStartMs, deleteEndMs),
      )
      return { ok: true, value: { ...state, tracks, updatedAt: now() } }
    },
  }
}

export function createUpdateTrackCommand(trackId: string, update: TrackUpdate): TimelineCommand {
  return {
    name: "Update track",
    execute(state) {
      const track = findTrack(state, trackId)
      if (!track) {
        return { ok: false, error: editorError("track_not_found", "Track not found") }
      }
      const next: TimelineTrack = {
        ...track,
        ...update,
        clips: track.clips,
      }
      return { ok: true, value: updateTrackInState(state, trackId, next) }
    },
  }
}

export function createUpdateClipAudioCommand(
  clipId: string,
  update: Partial<Pick<AudioClip, "volume" | "fadeInMs" | "fadeOutMs">>,
): TimelineCommand {
  return {
    name: "Update audio clip",
    execute(state) {
      const found = findClip(state, clipId)
      if (!found) {
        return { ok: false, error: editorError("clip_not_found", "Clip not found") }
      }
      if (found.clip.kind !== "audio") {
        return {
          ok: false,
          error: editorError("invalid_clip", "Only audio clips support audio settings"),
        }
      }
      const next: AudioClip = { ...found.clip, ...update }
      if (next.volume < 0 || next.volume > 2) {
        return {
          ok: false,
          error: editorError("invalid_volume", "Audio volume must be between 0 and 2"),
        }
      }
      if (next.fadeInMs < 0 || next.fadeOutMs < 0) {
        return { ok: false, error: editorError("invalid_fade", "Audio fades cannot be negative") }
      }
      return { ok: true, value: replaceClipInState(state, found.track.id, clipId, next) }
    },
  }
}

export function createUpdateClipTransformCommand(
  clipId: string,
  transform: ClipTransform,
): TimelineCommand {
  return {
    name: "Update PiP transform",
    execute(state) {
      const found = findClip(state, clipId)
      if (!found) {
        return { ok: false, error: editorError("clip_not_found", "Clip not found") }
      }
      const { track, clip } = found
      if (clip.kind !== "camera") {
        return {
          ok: false,
          error: editorError("invalid_clip", "Only camera clips support transforms"),
        }
      }
      const next: CameraClip = { ...clip, transform }
      return { ok: true, value: replaceClipInState(state, track.id, clipId, next) }
    },
  }
}

export function createAddCaptionClipCommand(
  trackId: string,
  text: string,
  startMs: number,
  durationMs: number,
): TimelineCommand {
  return {
    name: "Add caption",
    execute(state) {
      const track = findTrack(state, trackId)
      if (!track) {
        return { ok: false, error: editorError("track_not_found", "Track not found") }
      }
      if (track.kind !== "captions") {
        return {
          ok: false,
          error: editorError("invalid_track", "Captions can only be added to a captions track"),
        }
      }
      const clip: TimelineClip = {
        id: crypto.randomUUID(),
        kind: "caption",
        assetId: track.id,
        startMs,
        durationMs,
        sourceInMs: startMs,
        sourceOutMs: startMs + durationMs,
        speed: 1,
        text,
        style: "default",
      }
      const newTrack: TimelineTrack = { ...track, clips: [...track.clips, clip] }
      return { ok: true, value: updateTrackInState(state, trackId, newTrack) }
    },
  }
}

export function createUpdateCanvasCommand(
  canvas: Partial<{
    width: number
    height: number
    fps: number
    background: string
    padding: number
    borderRadius: number
    shadow: boolean
  }>,
): TimelineCommand {
  return {
    name: "Update canvas",
    execute(state) {
      return {
        ok: true,
        value: { ...state, canvas: { ...state.canvas, ...canvas }, updatedAt: now() },
      }
    },
  }
}

export function createUpdateCursorSettingsCommand(
  cursorSettings: Partial<import("@recordforge/domain").CursorSettings>,
): TimelineCommand {
  return {
    name: "Update cursor settings",
    execute(state) {
      const currentCanvas = state.canvas
      const currentCursor = currentCanvas.cursorSettings ?? {}
      return {
        ok: true,
        value: {
          ...state,
          canvas: {
            ...currentCanvas,
            cursorSettings: {
              ...currentCursor,
              ...cursorSettings,
            } as import("@recordforge/domain").CursorSettings,
          },
          updatedAt: now(),
        },
      }
    },
  }
}

export function createTrimTimelineEndsCommand(startMs: number, endMs: number): TimelineCommand {
  return {
    name: "Trim timeline",
    execute(state) {
      if (startMs >= endMs) {
        return {
          ok: false,
          error: editorError("invalid_trim", "Trim end must be greater than start"),
        }
      }
      const tracks = state.tracks.map((track) => {
        const clips = track.clips
          .map((clip) => {
            const clipEnd = clip.startMs + clip.durationMs
            if (clipEnd <= startMs || clip.startMs >= endMs) {
              return null
            }
            const newStart = Math.max(clip.startMs, startMs)
            const newEnd = Math.min(clipEnd, endMs)
            const sourceOffset = (newStart - clip.startMs) * clip.speed
            const sourceEndOffset = (clipEnd - newEnd) * clip.speed
            return {
              ...clip,
              startMs: newStart - startMs,
              durationMs: newEnd - newStart,
              sourceInMs: clip.sourceInMs + sourceOffset,
              sourceOutMs: clip.sourceOutMs - sourceEndOffset,
            } as TimelineClip
          })
          .filter((c): c is TimelineClip => c !== null)
        return { ...track, clips }
      })
      const markers = state.markers
        .filter((m) => m.timeMs >= startMs && m.timeMs <= endMs)
        .map((m) => ({ ...m, timeMs: m.timeMs - startMs }))
      return {
        ok: true,
        value: { ...state, tracks, markers, updatedAt: now() },
      }
    },
  }
}

export function getEngineDuration(state: TimelineState): number {
  return getTotalDuration(state)
}

export function getTrackClipsById(state: TimelineState, trackId: string): TimelineClip[] {
  return getTrackClips(state, trackId)
}
