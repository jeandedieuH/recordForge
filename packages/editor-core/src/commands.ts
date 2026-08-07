import type {
  AppError,
  AudioClip,
  CameraClip,
  ClipTransform,
  TimelineClip,
  TimelineState,
  TimelineTrack,
  TrackUpdate,
} from "@recordforge/domain"
import { findClip, findTrack, getTotalDuration, validateNoOverlap } from "@recordforge/domain"
import { clipDurationFromSourceRange, timelineToSource } from "./time-mapping"
import type {
  AddCaptionClipCommand,
  AddMarkerCommand,
  AddTrackCommand,
  CommandRecord,
  DeleteClipCommand,
  DeleteMarkerCommand,
  DeleteTrackCommand,
  MoveClipCommand,
  RippleDeleteClipCommand,
  SplitClipCommand,
  TrimClipCommand,
  TrimTimelineEndsCommand,
  UpdateCanvasCommand,
  UpdateClipAudioCommand,
  UpdateClipTransformCommand,
  UpdateCursorSettingsCommand,
  UpdateTrackCommand,
} from "./command-records"
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

function validateClipBoundaries(clip: TimelineClip): CommandResult<TimelineClip> {
  if (clip.sourceInMs >= clip.sourceOutMs) {
    return {
      ok: false,
      error: editorError("invalid_clip", "Clip source in must be less than source out"),
    }
  }
  const expectedDuration = clipDurationFromSourceRange(
    clip.sourceInMs,
    clip.sourceOutMs,
    clip.speed,
  )
  if (Math.abs(clip.durationMs - expectedDuration) > 1) {
    return {
      ok: false,
      error: editorError("invalid_clip", "Clip duration must match source range and speed"),
    }
  }
  return { ok: true, value: clip }
}

function sortAndValidateTrack(
  state: TimelineState,
  trackId: string,
  ignoreClipId?: string,
): CommandResult<TimelineTrack> {
  const track = findTrack(state, trackId)
  if (!track) {
    return { ok: false, error: editorError("track_not_found", "Track not found") }
  }
  const sorted = [...track.clips].sort((a, b) => a.startMs - b.startMs)
  if (track.kind === "screen" || track.kind === "camera") {
    if (!validateNoOverlap(sorted, ignoreClipId)) {
      return { ok: false, error: editorError("clip_overlap", "Clips overlap on this track") }
    }
  }
  return { ok: true, value: { ...track, clips: sorted } }
}

function isOnlyLockChange(update: TrackUpdate, track: TimelineTrack): boolean {
  // Allow unlocking a locked track; all other edits on a locked track are blocked.
  return track.locked && update.locked === false && Object.keys(update).length === 1
}

function checkTrackLocked(track: TimelineTrack, update?: TrackUpdate): CommandResult<void> {
  if (!track.locked) return { ok: true, value: undefined }
  if (update && isOnlyLockChange(update, track)) return { ok: true, value: undefined }
  return { ok: false, error: editorError("track_locked", `Track "${track.name}" is locked`) }
}

// --- Command application ---

export function canApplyCommand(state: TimelineState, command: CommandRecord): CommandResult<void> {
  switch (command.kind) {
    case "add-marker":
      return { ok: true, value: undefined }
    case "delete-marker": {
      const marker = state.markers.find((m) => m.id === command.markerId)
      if (!marker) return { ok: false, error: editorError("marker_not_found", "Marker not found") }
      return { ok: true, value: undefined }
    }
    case "add-track":
      return { ok: true, value: undefined }
    case "delete-track": {
      const track = findTrack(state, command.trackId)
      if (!track) return { ok: false, error: editorError("track_not_found", "Track not found") }
      if (track.locked) {
        return { ok: false, error: editorError("track_locked", `Track "${track.name}" is locked`) }
      }
      return { ok: true, value: undefined }
    }
    case "trim-clip":
    case "split-clip":
    case "delete-clip":
    case "ripple-delete-clip":
    case "update-clip-audio":
    case "update-clip-transform":
    case "move-clip": {
      const found = findClip(state, command.clipId)
      if (!found) return { ok: false, error: editorError("clip_not_found", "Clip not found") }
      const trackResult = checkTrackLocked(found.track)
      if (!trackResult.ok) return trackResult
      if (command.kind === "move-clip" && command.newTrackId) {
        const target = findTrack(state, command.newTrackId)
        if (!target)
          return { ok: false, error: editorError("track_not_found", "Target track not found") }
        const targetResult = checkTrackLocked(target)
        if (!targetResult.ok) return targetResult
      }
      return { ok: true, value: undefined }
    }
    case "update-track": {
      const track = findTrack(state, command.trackId)
      if (!track) return { ok: false, error: editorError("track_not_found", "Track not found") }
      const lockedResult = checkTrackLocked(track, command.update)
      if (!lockedResult.ok) return lockedResult
      return { ok: true, value: undefined }
    }
    case "add-caption-clip": {
      const track = findTrack(state, command.trackId)
      if (!track) return { ok: false, error: editorError("track_not_found", "Track not found") }
      if (track.locked) {
        return { ok: false, error: editorError("track_locked", `Track "${track.name}" is locked`) }
      }
      if (track.kind !== "captions") {
        return {
          ok: false,
          error: editorError("invalid_track", "Captions can only be added to a captions track"),
        }
      }
      return { ok: true, value: undefined }
    }
    case "update-canvas":
      return { ok: true, value: undefined }
    case "update-cursor-settings":
      return { ok: true, value: undefined }
    case "trim-timeline-ends": {
      if (command.startMs >= command.endMs) {
        return {
          ok: false,
          error: editorError("invalid_trim", "Trim end must be greater than start"),
        }
      }
      return { ok: true, value: undefined }
    }
    default:
      return { ok: false, error: editorError("unknown_command", "Unknown command kind") }
  }
}

export function applyCommand(
  state: TimelineState,
  command: CommandRecord,
): CommandResult<TimelineState> {
  const can = canApplyCommand(state, command)
  if (!can.ok) return can

  switch (command.kind) {
    case "add-marker":
      return applyAddMarker(state, command)
    case "delete-marker":
      return applyDeleteMarker(state, command)
    case "add-track":
      return applyAddTrack(state, command)
    case "delete-track":
      return applyDeleteTrack(state, command)
    case "trim-clip":
      return applyTrimClip(state, command)
    case "split-clip":
      return applySplitClip(state, command)
    case "move-clip":
      return applyMoveClip(state, command)
    case "delete-clip":
      return applyDeleteClip(state, command)
    case "ripple-delete-clip":
      return applyRippleDeleteClip(state, command)
    case "update-track":
      return applyUpdateTrack(state, command)
    case "update-clip-audio":
      return applyUpdateClipAudio(state, command)
    case "update-clip-transform":
      return applyUpdateClipTransform(state, command)
    case "add-caption-clip":
      return applyAddCaptionClip(state, command)
    case "update-canvas":
      return applyUpdateCanvas(state, command)
    case "update-cursor-settings":
      return applyUpdateCursorSettings(state, command)
    case "trim-timeline-ends":
      return applyTrimTimelineEnds(state, command)
    default:
      return { ok: false, error: editorError("unknown_command", "Unknown command kind") }
  }
}

function applyAddMarker(
  state: TimelineState,
  command: AddMarkerCommand,
): CommandResult<TimelineState> {
  const marker = {
    id: crypto.randomUUID(),
    timeMs: command.timeMs,
    label: command.label,
    color: command.color,
  }
  return {
    ok: true,
    value: { ...state, markers: [...state.markers, marker], updatedAt: now() },
  }
}

function applyDeleteMarker(
  state: TimelineState,
  command: DeleteMarkerCommand,
): CommandResult<TimelineState> {
  return {
    ok: true,
    value: {
      ...state,
      markers: state.markers.filter((m) => m.id !== command.markerId),
      updatedAt: now(),
    },
  }
}

function applyAddTrack(
  state: TimelineState,
  command: AddTrackCommand,
): CommandResult<TimelineState> {
  const track: TimelineTrack = {
    id: crypto.randomUUID(),
    kind: command.trackKind,
    name: command.trackName ?? `${command.trackKind} track`,
    muted: false,
    locked: false,
    solo: false,
    volume: 1,
    clips: [],
  }
  return { ok: true, value: { ...state, tracks: [...state.tracks, track], updatedAt: now() } }
}

function applyDeleteTrack(
  state: TimelineState,
  command: DeleteTrackCommand,
): CommandResult<TimelineState> {
  const track = findTrack(state, command.trackId)
  if (!track) {
    return { ok: false, error: editorError("track_not_found", "Track not found") }
  }
  if (track.locked) {
    return { ok: false, error: editorError("track_locked", `Track "${track.name}" is locked`) }
  }
  return {
    ok: true,
    value: {
      ...state,
      tracks: state.tracks.filter((t) => t.id !== command.trackId),
      updatedAt: now(),
    },
  }
}

function applyTrimClip(
  state: TimelineState,
  command: TrimClipCommand,
): CommandResult<TimelineState> {
  const found = findClip(state, command.clipId)
  if (!found) {
    return { ok: false, error: editorError("clip_not_found", "Clip not found") }
  }
  const { track, clip } = found
  if (track.locked) {
    return { ok: false, error: editorError("track_locked", `Track "${track.name}" is locked`) }
  }

  const nextClip: TimelineClip = {
    ...clip,
    sourceInMs: command.sourceInMs,
    sourceOutMs: command.sourceOutMs,
    durationMs: clipDurationFromSourceRange(command.sourceInMs, command.sourceOutMs, clip.speed),
  }
  const valid = validateClipBoundaries(nextClip)
  if (!valid.ok) return valid

  const withClip = replaceClipInState(state, track.id, command.clipId, valid.value)
  const trackResult = sortAndValidateTrack(withClip, track.id)
  if (!trackResult.ok) return trackResult

  return { ok: true, value: updateTrackInState(withClip, track.id, trackResult.value) }
}

function applySplitClip(
  state: TimelineState,
  command: SplitClipCommand,
): CommandResult<TimelineState> {
  const found = findClip(state, command.clipId)
  if (!found) {
    return { ok: false, error: editorError("clip_not_found", "Clip not found") }
  }
  const { track, clip } = found
  if (track.locked) {
    return { ok: false, error: editorError("track_locked", `Track "${track.name}" is locked`) }
  }

  const clipEndMs = clip.startMs + clip.durationMs
  if (command.splitTimeMs <= clip.startMs + 1 || command.splitTimeMs >= clipEndMs - 1) {
    return { ok: false, error: editorError("invalid_split", "Split time is outside the clip") }
  }

  const splitSource = timelineToSource(clip, command.splitTimeMs)
  if (splitSource === null) {
    return {
      ok: false,
      error: editorError("invalid_split", "Split point is outside the source range"),
    }
  }
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
    startMs: command.splitTimeMs,
    durationMs: rightDuration,
    sourceInMs: splitSource,
  }

  const newClips = track.clips.filter((c) => c.id !== command.clipId).concat(left, right)
  const newTrack: TimelineTrack = { ...track, clips: newClips }
  const trackResult = sortAndValidateTrack(updateTrackInState(state, track.id, newTrack), track.id)
  if (!trackResult.ok) return trackResult

  return { ok: true, value: updateTrackInState(state, track.id, trackResult.value) }
}

function applyMoveClip(
  state: TimelineState,
  command: MoveClipCommand,
): CommandResult<TimelineState> {
  const found = findClip(state, command.clipId)
  if (!found) {
    return { ok: false, error: editorError("clip_not_found", "Clip not found") }
  }
  const { track, clip, clipIndex } = found

  if (track.locked) {
    return { ok: false, error: editorError("track_locked", `Track "${track.name}" is locked`) }
  }
  if (command.newStartMs < 0) {
    return { ok: false, error: editorError("invalid_move", "Clip cannot start before zero") }
  }

  const targetTrackId = command.newTrackId ?? track.id
  const targetTrack = findTrack(state, targetTrackId)
  if (!targetTrack) {
    return { ok: false, error: editorError("track_not_found", "Target track not found") }
  }
  if (targetTrack.locked) {
    return {
      ok: false,
      error: editorError("track_locked", `Track "${targetTrack.name}" is locked`),
    }
  }
  if (targetTrack.kind !== clip.kind) {
    return {
      ok: false,
      error: editorError("invalid_move", "Clip kind does not match target track"),
    }
  }

  if (targetTrackId === track.id) {
    const newClips = [...track.clips]
    newClips[clipIndex] = { ...clip, startMs: command.newStartMs }
    const trackResult = sortAndValidateTrack(
      updateTrackInState(state, track.id, { ...track, clips: newClips }),
      track.id,
    )
    if (!trackResult.ok) return trackResult
    return { ok: true, value: updateTrackInState(state, track.id, trackResult.value) }
  }

  const sourceClips = track.clips.filter((c) => c.id !== command.clipId)
  const targetClips = [...targetTrack.clips, { ...clip, startMs: command.newStartMs }]
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
}

function applyDeleteClip(
  state: TimelineState,
  command: DeleteClipCommand,
): CommandResult<TimelineState> {
  const found = findClip(state, command.clipId)
  if (!found) {
    return { ok: false, error: editorError("clip_not_found", "Clip not found") }
  }
  const { track } = found
  if (track.locked) {
    return { ok: false, error: editorError("track_locked", `Track "${track.name}" is locked`) }
  }
  const newTrack: TimelineTrack = {
    ...track,
    clips: track.clips.filter((c) => c.id !== command.clipId),
  }
  return { ok: true, value: updateTrackInState(state, track.id, newTrack) }
}

function rippleDeleteFromTrack(
  track: TimelineTrack,
  deleteStartMs: number,
  deleteEndMs: number,
): TimelineTrack {
  if (track.locked) return track

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

function shiftMarkersAfterRipple(
  markers: TimelineState["markers"],
  deleteStartMs: number,
  deleteEndMs: number,
): TimelineState["markers"] {
  const deletedDuration = deleteEndMs - deleteStartMs
  return markers
    .filter((m) => m.timeMs < deleteStartMs || m.timeMs > deleteEndMs)
    .map((m) => (m.timeMs > deleteEndMs ? { ...m, timeMs: m.timeMs - deletedDuration } : m))
}

function applyRippleDeleteClip(
  state: TimelineState,
  command: RippleDeleteClipCommand,
): CommandResult<TimelineState> {
  const found = findClip(state, command.clipId)
  if (!found) {
    return { ok: false, error: editorError("clip_not_found", "Clip not found") }
  }
  const { track, clip } = found
  if (track.locked) {
    return { ok: false, error: editorError("track_locked", `Track "${track.name}" is locked`) }
  }

  const deleteStartMs = clip.startMs
  const deleteEndMs = clip.startMs + clip.durationMs
  const tracks = state.tracks.map((t) => rippleDeleteFromTrack(t, deleteStartMs, deleteEndMs))
  const markers = shiftMarkersAfterRipple(state.markers, deleteStartMs, deleteEndMs)

  return { ok: true, value: { ...state, tracks, markers, updatedAt: now() } }
}

function applyUpdateTrack(
  state: TimelineState,
  command: UpdateTrackCommand,
): CommandResult<TimelineState> {
  const track = findTrack(state, command.trackId)
  if (!track) {
    return { ok: false, error: editorError("track_not_found", "Track not found") }
  }
  if (track.locked && !isOnlyLockChange(command.update, track)) {
    return { ok: false, error: editorError("track_locked", `Track "${track.name}" is locked`) }
  }
  const next: TimelineTrack = {
    ...track,
    ...command.update,
    clips: track.clips,
  }
  return { ok: true, value: updateTrackInState(state, command.trackId, next) }
}

function applyUpdateClipAudio(
  state: TimelineState,
  command: UpdateClipAudioCommand,
): CommandResult<TimelineState> {
  const found = findClip(state, command.clipId)
  if (!found) {
    return { ok: false, error: editorError("clip_not_found", "Clip not found") }
  }
  const { track, clip } = found
  if (track.locked) {
    return { ok: false, error: editorError("track_locked", `Track "${track.name}" is locked`) }
  }
  if (clip.kind !== "audio") {
    return {
      ok: false,
      error: editorError("invalid_clip", "Only audio clips support audio settings"),
    }
  }

  const update: Partial<Pick<AudioClip, "volume" | "fadeInMs" | "fadeOutMs">> = {}
  if (command.volume !== undefined) update.volume = command.volume
  if (command.fadeInMs !== undefined) update.fadeInMs = command.fadeInMs
  if (command.fadeOutMs !== undefined) update.fadeOutMs = command.fadeOutMs

  const next: AudioClip = { ...clip, ...update }
  if (next.volume < 0 || next.volume > 2) {
    return {
      ok: false,
      error: editorError("invalid_volume", "Audio volume must be between 0 and 2"),
    }
  }
  if (next.fadeInMs < 0 || next.fadeOutMs < 0) {
    return { ok: false, error: editorError("invalid_fade", "Audio fades cannot be negative") }
  }
  return { ok: true, value: replaceClipInState(state, track.id, command.clipId, next) }
}

function applyUpdateClipTransform(
  state: TimelineState,
  command: UpdateClipTransformCommand,
): CommandResult<TimelineState> {
  const found = findClip(state, command.clipId)
  if (!found) {
    return { ok: false, error: editorError("clip_not_found", "Clip not found") }
  }
  const { track, clip } = found
  if (track.locked) {
    return { ok: false, error: editorError("track_locked", `Track "${track.name}" is locked`) }
  }
  if (clip.kind !== "camera") {
    return {
      ok: false,
      error: editorError("invalid_clip", "Only camera clips support transforms"),
    }
  }
  const next: CameraClip = { ...clip, transform: command.transform as ClipTransform }
  return { ok: true, value: replaceClipInState(state, track.id, command.clipId, next) }
}

function applyAddCaptionClip(
  state: TimelineState,
  command: AddCaptionClipCommand,
): CommandResult<TimelineState> {
  const track = findTrack(state, command.trackId)
  if (!track) {
    return { ok: false, error: editorError("track_not_found", "Track not found") }
  }
  if (track.locked) {
    return { ok: false, error: editorError("track_locked", `Track "${track.name}" is locked`) }
  }
  if (track.kind !== "captions") {
    return {
      ok: false,
      error: editorError("invalid_track", "Captions can only be added to a captions track"),
    }
  }
  const newClip: TimelineClip = {
    id: crypto.randomUUID(),
    kind: "caption",
    assetId: track.id,
    startMs: command.startMs,
    durationMs: command.durationMs,
    sourceInMs: command.startMs,
    sourceOutMs: command.startMs + command.durationMs,
    speed: 1,
    text: command.text,
    style: "default",
  }
  const newTrack: TimelineTrack = { ...track, clips: [...track.clips, newClip] }
  return { ok: true, value: updateTrackInState(state, command.trackId, newTrack) }
}

function applyUpdateCanvas(
  state: TimelineState,
  command: UpdateCanvasCommand,
): CommandResult<TimelineState> {
  return {
    ok: true,
    value: { ...state, canvas: { ...state.canvas, ...command.canvas }, updatedAt: now() },
  }
}

function applyUpdateCursorSettings(
  state: TimelineState,
  command: UpdateCursorSettingsCommand,
): CommandResult<TimelineState> {
  const currentCanvas = state.canvas
  const currentCursor = currentCanvas.cursorSettings ?? {}
  return {
    ok: true,
    value: {
      ...state,
      canvas: {
        ...currentCanvas,
        cursorSettings: { ...currentCursor, ...command.cursorSettings },
      },
      updatedAt: now(),
    },
  }
}

function applyTrimTimelineEnds(
  state: TimelineState,
  command: TrimTimelineEndsCommand,
): CommandResult<TimelineState> {
  if (command.startMs >= command.endMs) {
    return { ok: false, error: editorError("invalid_trim", "Trim end must be greater than start") }
  }

  const tracks = state.tracks.map((track) => {
    if (track.locked) return track
    const clips = track.clips
      .map((clip) => {
        const clipEnd = clip.startMs + clip.durationMs
        if (clipEnd <= command.startMs || clip.startMs >= command.endMs) {
          return null
        }
        const newStart = Math.max(clip.startMs, command.startMs)
        const newEnd = Math.min(clipEnd, command.endMs)
        const sourceOffset = (newStart - clip.startMs) * clip.speed
        const sourceEndOffset = (clipEnd - newEnd) * clip.speed
        return {
          ...clip,
          startMs: newStart - command.startMs,
          durationMs: newEnd - newStart,
          sourceInMs: clip.sourceInMs + sourceOffset,
          sourceOutMs: clip.sourceOutMs - sourceEndOffset,
        } as TimelineClip
      })
      .filter((c): c is TimelineClip => c !== null)
    return { ...track, clips }
  })

  const markers = state.markers
    .filter((m) => m.timeMs >= command.startMs && m.timeMs <= command.endMs)
    .map((m) => ({ ...m, timeMs: m.timeMs - command.startMs }))

  return {
    ok: true,
    value: { ...state, tracks, markers, updatedAt: now() },
  }
}

// --- Command factories ---

export function createAddMarkerCommand(
  timeMs: number,
  label: string,
  color = "#f59e0b",
): CommandRecord {
  return {
    kind: "add-marker",
    name: "Add marker",
    timeMs,
    label,
    color,
  }
}

export function createDeleteMarkerCommand(markerId: string): CommandRecord {
  return {
    kind: "delete-marker",
    name: "Delete marker",
    markerId,
  }
}

export function createAddTrackCommand(
  kind: import("@recordforge/contracts").TimelineTrackKind,
  trackName?: string,
): CommandRecord {
  return {
    kind: "add-track",
    name: "Add track",
    trackKind: kind,
    trackName: trackName ?? `${kind} track`,
  }
}

export function createDeleteTrackCommand(trackId: string): CommandRecord {
  return {
    kind: "delete-track",
    name: "Delete track",
    trackId,
  }
}

export function createTrimClipCommand(
  clipId: string,
  sourceInMs: number,
  sourceOutMs: number,
): CommandRecord {
  return {
    kind: "trim-clip",
    name: "Trim clip",
    clipId,
    sourceInMs,
    sourceOutMs,
    coalesce: true,
    coalesceKey: `trim:${clipId}`,
  }
}

export function createSplitClipCommand(clipId: string, splitTimeMs: number): CommandRecord {
  return {
    kind: "split-clip",
    name: "Split clip",
    clipId,
    splitTimeMs,
  }
}

export function createMoveClipCommand(
  clipId: string,
  newStartMs: number,
  newTrackId?: string,
): CommandRecord {
  return {
    kind: "move-clip",
    name: "Move clip",
    clipId,
    newStartMs,
    newTrackId,
    coalesce: true,
    coalesceKey: `move:${clipId}`,
  }
}

export function createDeleteClipCommand(clipId: string): CommandRecord {
  return {
    kind: "delete-clip",
    name: "Delete clip",
    clipId,
  }
}

export function createRippleDeleteClipCommand(clipId: string): CommandRecord {
  return {
    kind: "ripple-delete-clip",
    name: "Ripple delete",
    clipId,
  }
}

export function createUpdateTrackCommand(trackId: string, update: TrackUpdate): CommandRecord {
  const coalesce =
    update.volume !== undefined &&
    update.muted === undefined &&
    update.locked === undefined &&
    update.solo === undefined &&
    update.name === undefined

  return {
    kind: "update-track",
    name: "Update track",
    trackId,
    update,
    coalesce,
    coalesceKey: coalesce ? `track:${trackId}` : undefined,
  }
}

export function createUpdateClipAudioCommand(
  clipId: string,
  command: Partial<Pick<AudioClip, "volume" | "fadeInMs" | "fadeOutMs">>,
): CommandRecord {
  return {
    kind: "update-clip-audio",
    name: "Update audio clip",
    clipId,
    volume: command.volume,
    fadeInMs: command.fadeInMs,
    fadeOutMs: command.fadeOutMs,
    coalesce: true,
    coalesceKey: `audio:${clipId}`,
  }
}

export function createUpdateClipTransformCommand(
  clipId: string,
  transform: ClipTransform,
): CommandRecord {
  return {
    kind: "update-clip-transform",
    name: "Update PiP transform",
    clipId,
    transform,
    coalesce: true,
    coalesceKey: `transform:${clipId}`,
  }
}

export function createAddCaptionClipCommand(
  trackId: string,
  text: string,
  startMs: number,
  durationMs: number,
): CommandRecord {
  return {
    kind: "add-caption-clip",
    name: "Add caption",
    trackId,
    text,
    startMs,
    durationMs,
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
): CommandRecord {
  return {
    kind: "update-canvas",
    name: "Update canvas",
    canvas,
  }
}

export function createUpdateCursorSettingsCommand(
  cursorSettings: Partial<import("@recordforge/contracts").CursorSettings>,
): CommandRecord {
  return {
    kind: "update-cursor-settings",
    name: "Update cursor settings",
    cursorSettings,
    coalesce: true,
    coalesceKey: "cursor",
  }
}

export function createTrimTimelineEndsCommand(startMs: number, endMs: number): CommandRecord {
  return {
    kind: "trim-timeline-ends",
    name: "Trim timeline",
    startMs,
    endMs,
  }
}

export function getEngineDuration(state: TimelineState): number {
  return getTotalDuration(state)
}
