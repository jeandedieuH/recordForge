import type {
  AppError,
  AudioClip,
  CameraClip,
  ClipTransform,
  CursorEffectClip,
  TimelineClip,
  TimelineState,
  TimelineTrack,
  TrackUpdate,
} from "@recordforge/domain"
import { findClip, findTrack, getTotalDuration, validateNoOverlap } from "@recordforge/domain"
import { clipDurationFromSourceRange, timelineToSource } from "./time-mapping"
import type {
  AddCaptionClipCommand,
  AddCursorRangeCommand,
  AddMarkerCommand,
  AddTrackCommand,
  CommandRecord,
  DeleteClipCommand,
  DeleteClipsCommand,
  DeleteCursorRangeCommand,
  DeleteMarkerCommand,
  DeleteRangeCommand,
  DeleteTrackCommand,
  MoveClipCommand,
  MoveClipsCommand,
  ResizeCursorRangeCommand,
  RippleDeleteClipCommand,
  RippleDeleteClipsCommand,
  RippleDeleteRangeCommand,
  SplitClipCommand,
  SplitCursorRangeCommand,
  TrimClipCommand,
  TrimTimelineEndsCommand,
  UpdateCanvasCommand,
  UpdateClipAudioCommand,
  UpdateCursorRangeCommand,
  UpdateClipTransformCommand,
  UpdateCursorSettingsCommand,
  UpdateMarkerCommand,
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
  // A track is a single ordered lane. Rejecting overlap for every lane keeps
  // drag and keyboard moves safe instead of silently covering existing content.
  if (!validateNoOverlap(sorted, ignoreClipId)) {
    return { ok: false, error: editorError("clip_overlap", "Clips overlap on this track") }
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

function findCursorRange(
  state: TimelineState,
  rangeId: string,
): {
  track: TimelineTrack
  range: CursorEffectClip
} | null {
  for (const track of state.tracks) {
    if (track.kind !== "cursor") continue
    const range = track.clips.find(
      (clip): clip is CursorEffectClip => clip.kind === "cursor-effect" && clip.id === rangeId,
    )
    if (range) return { track, range }
  }
  return null
}

function validateCursorRanges(track: TimelineTrack): CommandResult<TimelineTrack> {
  const ranges = track.clips
    .filter((clip): clip is CursorEffectClip => clip.kind === "cursor-effect")
    .sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id))
  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index]
    if (range.durationMs <= 0) {
      return {
        ok: false,
        error: editorError("invalid_cursor_range", "Cursor range must have a duration"),
      }
    }
    if (index > 0) {
      const previous = ranges[index - 1]
      if (previous.startMs + previous.durationMs > range.startMs) {
        return {
          ok: false,
          error: editorError("cursor_range_overlap", "Cursor ranges cannot overlap"),
        }
      }
    }
  }
  return { ok: true, value: { ...track, clips: ranges } }
}

// --- Command application ---

export function canApplyCommand(state: TimelineState, command: CommandRecord): CommandResult<void> {
  switch (command.kind) {
    case "add-marker":
      return { ok: true, value: undefined }
    case "update-marker": {
      const marker = state.markers.find((candidate) => candidate.id === command.markerId)
      if (!marker) return { ok: false, error: editorError("marker_not_found", "Marker not found") }
      return { ok: true, value: undefined }
    }
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
      if (found.clip.kind === "cursor-effect" && found.clip.locked) {
        return { ok: false, error: editorError("cursor_range_locked", "Cursor range is locked") }
      }
      if (command.kind === "move-clip" && command.newTrackId) {
        const target = findTrack(state, command.newTrackId)
        if (!target)
          return { ok: false, error: editorError("track_not_found", "Target track not found") }
        const targetResult = checkTrackLocked(target)
        if (!targetResult.ok) return targetResult
      }
      return { ok: true, value: undefined }
    }
    case "move-clips": {
      const foundClips = command.clipIds.map((clipId) => findClip(state, clipId))
      if (foundClips.some((found) => !found)) {
        return { ok: false, error: editorError("clip_not_found", "Clip not found") }
      }
      const lockedClip = foundClips.find(
        (found) =>
          found?.track.locked || (found?.clip.kind === "cursor-effect" && found.clip.locked),
      )
      if (lockedClip) {
        return {
          ok: false,
          error: editorError("track_locked", `Track "${lockedClip.track.name}" is locked`),
        }
      }
      if (foundClips.some((found) => (found?.clip.startMs ?? 0) + command.deltaMs < 0)) {
        return { ok: false, error: editorError("invalid_move", "Clip cannot start before zero") }
      }
      return { ok: true, value: undefined }
    }
    case "delete-clips":
    case "ripple-delete-clips": {
      const foundClips = command.clipIds.map((clipId) => findClip(state, clipId))
      if (foundClips.some((found) => !found)) {
        return { ok: false, error: editorError("clip_not_found", "Clip not found") }
      }
      const lockedClip = foundClips.find(
        (found) =>
          found?.track.locked || (found?.clip.kind === "cursor-effect" && found.clip.locked),
      )
      if (lockedClip) {
        return {
          ok: false,
          error: editorError("track_locked", `Track "${lockedClip.track.name}" is locked`),
        }
      }
      return { ok: true, value: undefined }
    }
    case "delete-range":
    case "ripple-delete-range": {
      if (command.startMs >= command.endMs) {
        return {
          ok: false,
          error: editorError("invalid_range", "Range end must be greater than range start"),
        }
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
    case "add-cursor-range": {
      const track = command.trackId
        ? findTrack(state, command.trackId)
        : state.tracks.find((t) => t.kind === "cursor")
      if (track) {
        if (track.kind !== "cursor") {
          return {
            ok: false,
            error: editorError("invalid_track", "Cursor ranges require a cursor track"),
          }
        }
        if (track.locked) {
          return {
            ok: false,
            error: editorError("track_locked", `Track "${track.name}" is locked`),
          }
        }
      }
      if (command.startMs >= command.endMs) {
        return {
          ok: false,
          error: editorError("invalid_cursor_range", "Cursor range end must be greater than start"),
        }
      }
      return { ok: true, value: undefined }
    }
    case "split-cursor-range":
    case "resize-cursor-range":
    case "update-cursor-range":
    case "delete-cursor-range": {
      const found = findCursorRange(state, command.rangeId)
      if (!found)
        return { ok: false, error: editorError("cursor_range_not_found", "Cursor range not found") }
      if (found.track.locked || (found.range.locked && command.kind !== "update-cursor-range")) {
        return { ok: false, error: editorError("cursor_range_locked", "Cursor range is locked") }
      }
      if (command.kind === "update-cursor-range" && found.range.locked) {
        const onlyUnlock =
          command.locked === false &&
          command.enabled === undefined &&
          command.presetId === undefined &&
          command.scale === undefined &&
          command.smoothing === undefined &&
          command.settings === undefined
        if (!onlyUnlock)
          return { ok: false, error: editorError("cursor_range_locked", "Cursor range is locked") }
      }
      if (command.kind === "resize-cursor-range") {
        const nextStart = command.startMs ?? found.range.startMs
        const nextEnd = command.endMs ?? found.range.startMs + found.range.durationMs
        if (nextStart >= nextEnd) {
          return {
            ok: false,
            error: editorError(
              "invalid_cursor_range",
              "Cursor range end must be greater than start",
            ),
          }
        }
      }
      if (command.kind === "split-cursor-range") {
        const end = found.range.startMs + found.range.durationMs
        if (command.splitTimeMs <= found.range.startMs || command.splitTimeMs >= end) {
          return {
            ok: false,
            error: editorError("invalid_cursor_split", "Split point is outside cursor range"),
          }
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
    case "update-marker":
      return applyUpdateMarker(state, command)
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
    case "move-clips":
      return applyMoveClips(state, command)
    case "delete-clip":
      return applyDeleteClip(state, command)
    case "delete-clips":
      return applyDeleteClips(state, command)
    case "ripple-delete-clip":
      return applyRippleDeleteClip(state, command)
    case "delete-range":
      return applyDeleteRange(state, command)
    case "ripple-delete-range":
      return applyRippleDeleteRange(state, command)
    case "ripple-delete-clips":
      return applyRippleDeleteClips(state, command)
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
    case "add-cursor-range":
      return applyAddCursorRange(state, command)
    case "split-cursor-range":
      return applySplitCursorRange(state, command)
    case "resize-cursor-range":
      return applyResizeCursorRange(state, command)
    case "update-cursor-range":
      return applyUpdateCursorRange(state, command)
    case "delete-cursor-range":
      return applyDeleteCursorRange(state, command)
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
    id: command.markerId ?? `marker:${command.timeMs}:${command.label}`,
    timeMs: command.timeMs,
    label: command.label,
    color: command.color,
  }
  return {
    ok: true,
    value: {
      ...state,
      markers: [...state.markers, marker].sort(
        (a, b) => a.timeMs - b.timeMs || a.id.localeCompare(b.id),
      ),
      updatedAt: now(),
    },
  }
}

function applyUpdateMarker(
  state: TimelineState,
  command: UpdateMarkerCommand,
): CommandResult<TimelineState> {
  const marker = state.markers.find((candidate) => candidate.id === command.markerId)
  if (!marker) {
    return { ok: false, error: editorError("marker_not_found", "Marker not found") }
  }
  const nextMarker = {
    ...marker,
    ...(command.timeMs === undefined ? {} : { timeMs: command.timeMs }),
    ...(command.label === undefined ? {} : { label: command.label }),
    ...(command.color === undefined ? {} : { color: command.color }),
  }
  return {
    ok: true,
    value: {
      ...state,
      markers: state.markers
        .map((candidate) => (candidate.id === command.markerId ? nextMarker : candidate))
        .sort((a, b) => a.timeMs - b.timeMs || a.id.localeCompare(b.id)),
      updatedAt: now(),
    },
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
    id: command.trackId ?? `track:${command.trackKind}:${command.trackName ?? "track"}`,
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
  if (clip.kind === "cursor-effect") {
    const nextStart = command.startMs ?? clip.startMs
    const nextEnd =
      command.sourceOutMs > command.sourceInMs
        ? nextStart +
          Math.round((command.sourceOutMs - command.sourceInMs) / Math.max(clip.speed, 0.001))
        : nextStart + clip.durationMs
    return applyResizeCursorRange(state, {
      kind: "resize-cursor-range",
      name: "Resize cursor range",
      rangeId: clip.id,
      startMs: nextStart,
      endMs: nextEnd,
    })
  }

  const nextClip: TimelineClip = {
    ...clip,
    ...(command.startMs === undefined ? {} : { startMs: command.startMs }),
    sourceInMs: command.sourceInMs,
    sourceOutMs: command.sourceOutMs,
    durationMs: Math.round(
      clipDurationFromSourceRange(command.sourceInMs, command.sourceOutMs, clip.speed),
    ),
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
  if (clip.kind === "cursor-effect") {
    return applySplitCursorRange(state, {
      kind: "split-cursor-range",
      name: "Split cursor range",
      rangeId: clip.id,
      splitTimeMs: command.splitTimeMs,
      leftRangeId: command.leftClipId,
      rightRangeId: command.rightClipId,
    })
  }

  const clipEndMs = clip.startMs + clip.durationMs
  if (command.splitTimeMs <= clip.startMs + 1 || command.splitTimeMs >= clipEndMs - 1) {
    return { ok: false, error: editorError("invalid_split", "Split time is outside the clip") }
  }

  const mappedSplitSource = timelineToSource(clip, command.splitTimeMs)
  if (mappedSplitSource === null) {
    return {
      ok: false,
      error: editorError("invalid_split", "Split point is outside the source range"),
    }
  }
  const splitSource = Math.round(mappedSplitSource)
  if (splitSource <= clip.sourceInMs || splitSource >= clip.sourceOutMs) {
    return {
      ok: false,
      error: editorError("invalid_split", "Split point is outside the source range"),
    }
  }

  const leftDuration = Math.round((splitSource - clip.sourceInMs) / clip.speed)
  const rightDuration = Math.round((clip.sourceOutMs - splitSource) / clip.speed)
  const leftClipId = command.leftClipId ?? `${clip.id}:split:${command.splitTimeMs}:left`
  const rightClipId = command.rightClipId ?? `${clip.id}:split:${command.splitTimeMs}:right`

  const left: TimelineClip = {
    ...clip,
    id: leftClipId,
    durationMs: leftDuration,
    sourceOutMs: splitSource,
  }

  const right: TimelineClip = {
    ...clip,
    id: rightClipId,
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
  const targetAcceptsClip =
    (targetTrack.kind === "captions" && clip.kind === "caption") ||
    (targetTrack.kind === "cursor" && clip.kind === "cursor-effect") ||
    targetTrack.kind === clip.kind
  if (!targetAcceptsClip) {
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

function applyMoveClips(
  state: TimelineState,
  command: MoveClipsCommand,
): CommandResult<TimelineState> {
  const clipIds = new Set(command.clipIds)
  let next = state
  for (const track of state.tracks) {
    const clips = track.clips.map((clip) =>
      clipIds.has(clip.id) ? { ...clip, startMs: clip.startMs + command.deltaMs } : clip,
    )
    const trackResult = sortAndValidateTrack(
      updateTrackInState(next, track.id, { ...track, clips }),
      track.id,
    )
    if (!trackResult.ok) return trackResult
    next = updateTrackInState(next, track.id, trackResult.value)
  }
  return { ok: true, value: { ...next, updatedAt: now() } }
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

function clipSegmentsAfterRange(
  clip: TimelineClip,
  deleteStartMs: number,
  deleteEndMs: number,
  ripple: boolean,
): TimelineClip[] {
  if (clip.kind === "cursor-effect" && clip.locked) return [clip]
  const clipEndMs = clip.startMs + clip.durationMs
  if (clipEndMs <= deleteStartMs) return [clip]
  if (clip.startMs >= deleteEndMs) {
    return ripple ? [{ ...clip, startMs: clip.startMs - (deleteEndMs - deleteStartMs) }] : [clip]
  }

  const segments: TimelineClip[] = []
  const hasLeft = clip.startMs < deleteStartMs
  const hasRight = clipEndMs > deleteEndMs
  const leftEndMs = Math.min(deleteStartMs, clipEndMs)
  const rightStartMs = Math.max(deleteEndMs, clip.startMs)

  if (hasLeft && leftEndMs > clip.startMs) {
    const leftDurationMs = leftEndMs - clip.startMs
    segments.push({
      ...clip,
      durationMs: Math.round(leftDurationMs),
      sourceOutMs: clip.sourceInMs + Math.round(leftDurationMs * clip.speed),
    })
  }

  if (hasRight && clipEndMs > rightStartMs) {
    const rightDurationMs = clipEndMs - rightStartMs
    const nextStartMs = ripple ? deleteStartMs : rightStartMs
    segments.push({
      ...clip,
      id: hasLeft ? `${clip.id}:range:${deleteStartMs}:${deleteEndMs}:right` : clip.id,
      startMs: nextStartMs,
      durationMs: Math.round(rightDurationMs),
      sourceInMs: clip.sourceInMs + Math.round((rightStartMs - clip.startMs) * clip.speed),
    })
  }

  return segments
}

function deleteRangeFromTrack(
  track: TimelineTrack,
  deleteStartMs: number,
  deleteEndMs: number,
  ripple: boolean,
): TimelineTrack {
  if (track.locked) return track
  const clips = track.clips.flatMap((clip) =>
    clipSegmentsAfterRange(clip, deleteStartMs, deleteEndMs, ripple),
  )
  return {
    ...track,
    clips: clips.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id)),
  }
}

function deleteMarkersInRange(
  markers: TimelineState["markers"],
  deleteStartMs: number,
  deleteEndMs: number,
): TimelineState["markers"] {
  return markers.filter((marker) => marker.timeMs < deleteStartMs || marker.timeMs >= deleteEndMs)
}

function shiftMarkersAfterRipple(
  markers: TimelineState["markers"],
  deleteStartMs: number,
  deleteEndMs: number,
): TimelineState["markers"] {
  const deletedDuration = deleteEndMs - deleteStartMs
  return markers
    .filter((marker) => marker.timeMs < deleteStartMs || marker.timeMs >= deleteEndMs)
    .map((marker) =>
      marker.timeMs >= deleteEndMs
        ? { ...marker, timeMs: marker.timeMs - deletedDuration }
        : marker,
    )
}

function applyDeleteRangeInternal(
  state: TimelineState,
  deleteStartMs: number,
  deleteEndMs: number,
  ripple: boolean,
): TimelineState {
  const tracks = state.tracks.map((track) =>
    deleteRangeFromTrack(track, deleteStartMs, deleteEndMs, ripple),
  )
  const markers = ripple
    ? shiftMarkersAfterRipple(state.markers, deleteStartMs, deleteEndMs)
    : deleteMarkersInRange(state.markers, deleteStartMs, deleteEndMs)
  return { ...state, tracks, markers, updatedAt: now() }
}

function applyDeleteClips(
  state: TimelineState,
  command: DeleteClipsCommand,
): CommandResult<TimelineState> {
  const clipIds = new Set(command.clipIds)
  const tracks = state.tracks.map((track) => ({
    ...track,
    clips: track.clips.filter((clip) => !clipIds.has(clip.id)),
  }))
  return { ok: true, value: { ...state, tracks, updatedAt: now() } }
}

function applyDeleteRange(
  state: TimelineState,
  command: DeleteRangeCommand,
): CommandResult<TimelineState> {
  return {
    ok: true,
    value: applyDeleteRangeInternal(state, command.startMs, command.endMs, false),
  }
}

function applyRippleDeleteRange(
  state: TimelineState,
  command: RippleDeleteRangeCommand,
): CommandResult<TimelineState> {
  return {
    ok: true,
    value: applyDeleteRangeInternal(state, command.startMs, command.endMs, true),
  }
}

function applyRippleDeleteClips(
  state: TimelineState,
  command: RippleDeleteClipsCommand,
): CommandResult<TimelineState> {
  const ranges = command.clipIds
    .map((clipId) => findClip(state, clipId)?.clip)
    .filter((clip): clip is TimelineClip => clip !== undefined)
    .map((clip) => ({ startMs: clip.startMs, endMs: clip.startMs + clip.durationMs }))
    .sort((a, b) => b.startMs - a.startMs || b.endMs - a.endMs)

  let next = state
  let previousRange: { startMs: number; endMs: number } | undefined
  for (const range of ranges) {
    if (previousRange?.startMs === range.startMs && previousRange.endMs === range.endMs) continue
    next = applyDeleteRangeInternal(next, range.startMs, range.endMs, true)
    previousRange = range
  }
  return { ok: true, value: next }
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

  return {
    ok: true,
    value: applyDeleteRangeInternal(state, clip.startMs, clip.startMs + clip.durationMs, true),
  }
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
    id: command.clipId ?? `caption:${command.trackId}:${command.startMs}:${command.text}`,
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
  const trackResult = sortAndValidateTrack(
    updateTrackInState(state, command.trackId, newTrack),
    command.trackId,
  )
  if (!trackResult.ok) return trackResult
  return { ok: true, value: updateTrackInState(state, command.trackId, trackResult.value) }
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

function applyAddCursorRange(
  state: TimelineState,
  command: AddCursorRangeCommand,
): CommandResult<TimelineState> {
  const existingTrack = command.trackId
    ? findTrack(state, command.trackId)
    : state.tracks.find((track) => track.kind === "cursor")
  const track: TimelineTrack = existingTrack ?? {
    id: command.trackId ?? "track:cursor",
    kind: "cursor",
    name: "Cursor",
    muted: false,
    locked: false,
    solo: false,
    volume: 1,
    clips: [],
  }
  const settings = command.settings ?? {}
  const range: CursorEffectClip = {
    id: command.rangeId ?? `cursor-effect:${command.startMs}:${command.endMs}`,
    kind: "cursor-effect",
    assetId: command.assetId,
    startMs: command.startMs,
    durationMs: command.endMs - command.startMs,
    sourceInMs: 0,
    sourceOutMs: 0,
    speed: 1,
    presetId: command.presetId ?? settings.preset ?? "modern-neon",
    scale: command.scale ?? settings.scale ?? 1,
    smoothing: command.smoothing ?? (settings.smoothMovement === false ? "off" : "smooth"),
    settings,
    enabled: settings.enabled ?? true,
    locked: false,
  }
  const nextTrack = { ...track, clips: [...track.clips, range] }
  const valid = validateCursorRanges(nextTrack)
  if (!valid.ok) return valid
  const tracks = existingTrack
    ? state.tracks.map((candidate) => (candidate.id === track.id ? valid.value : candidate))
    : [...state.tracks, valid.value]
  return { ok: true, value: { ...state, tracks, updatedAt: now() } }
}

function applySplitCursorRange(
  state: TimelineState,
  command: SplitCursorRangeCommand,
): CommandResult<TimelineState> {
  const found = findCursorRange(state, command.rangeId)
  if (!found)
    return { ok: false, error: editorError("cursor_range_not_found", "Cursor range not found") }
  const splitOffset = command.splitTimeMs - found.range.startMs
  const left: CursorEffectClip = {
    ...found.range,
    id: command.leftRangeId ?? `${found.range.id}:left:${command.splitTimeMs}`,
    durationMs: splitOffset,
  }
  const right: CursorEffectClip = {
    ...found.range,
    id: command.rightRangeId ?? `${found.range.id}:right:${command.splitTimeMs}`,
    startMs: command.splitTimeMs,
    durationMs: found.range.durationMs - splitOffset,
  }
  const nextTrack = {
    ...found.track,
    clips: found.track.clips.filter((clip) => clip.id !== command.rangeId).concat(left, right),
  }
  const valid = validateCursorRanges(nextTrack)
  if (!valid.ok) return valid
  return { ok: true, value: updateTrackInState(state, found.track.id, valid.value) }
}

function applyResizeCursorRange(
  state: TimelineState,
  command: ResizeCursorRangeCommand,
): CommandResult<TimelineState> {
  const found = findCursorRange(state, command.rangeId)
  if (!found)
    return { ok: false, error: editorError("cursor_range_not_found", "Cursor range not found") }
  const startMs = command.startMs ?? found.range.startMs
  const endMs = command.endMs ?? found.range.startMs + found.range.durationMs
  const range = { ...found.range, startMs, durationMs: endMs - startMs }
  const nextTrack = {
    ...found.track,
    clips: found.track.clips.map((clip) => (clip.id === range.id ? range : clip)),
  }
  const valid = validateCursorRanges(nextTrack)
  if (!valid.ok) return valid
  return { ok: true, value: updateTrackInState(state, found.track.id, valid.value) }
}

function applyUpdateCursorRange(
  state: TimelineState,
  command: UpdateCursorRangeCommand,
): CommandResult<TimelineState> {
  const found = findCursorRange(state, command.rangeId)
  if (!found)
    return { ok: false, error: editorError("cursor_range_not_found", "Cursor range not found") }
  const nextSettings = { ...found.range.settings, ...(command.settings ?? {}) }
  const range: CursorEffectClip = {
    ...found.range,
    ...(command.enabled === undefined ? {} : { enabled: command.enabled }),
    ...(command.locked === undefined ? {} : { locked: command.locked }),
    ...(command.presetId === undefined ? {} : { presetId: command.presetId }),
    ...(command.scale === undefined ? {} : { scale: command.scale }),
    ...(command.smoothing === undefined ? {} : { smoothing: command.smoothing }),
    settings: nextSettings,
  }
  const nextTrack = {
    ...found.track,
    clips: found.track.clips.map((clip) => (clip.id === range.id ? range : clip)),
  }
  return { ok: true, value: updateTrackInState(state, found.track.id, nextTrack) }
}

function applyDeleteCursorRange(
  state: TimelineState,
  command: DeleteCursorRangeCommand,
): CommandResult<TimelineState> {
  const found = findCursorRange(state, command.rangeId)
  if (!found)
    return { ok: false, error: editorError("cursor_range_not_found", "Cursor range not found") }
  const nextTrack = {
    ...found.track,
    clips: found.track.clips.filter((clip) => clip.id !== command.rangeId),
  }
  return { ok: true, value: updateTrackInState(state, found.track.id, nextTrack) }
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
        if (clip.kind === "cursor-effect" && clip.locked) return clip
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
    markerId: crypto.randomUUID(),
    timeMs,
    label,
    color,
  }
}

export function createUpdateMarkerCommand(
  markerId: string,
  update: Pick<UpdateMarkerCommand, "timeMs" | "label" | "color">,
): CommandRecord {
  return {
    kind: "update-marker",
    name: "Update marker",
    markerId,
    ...update,
    coalesce: update.timeMs !== undefined,
    coalesceKey: update.timeMs !== undefined ? `marker:${markerId}` : undefined,
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
    trackId: crypto.randomUUID(),
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
  options: { startMs?: number; coalesceKey?: string } = {},
): CommandRecord {
  return {
    kind: "trim-clip",
    name: "Trim clip",
    clipId,
    ...(options.startMs === undefined ? {} : { startMs: options.startMs }),
    sourceInMs,
    sourceOutMs,
    coalesce: true,
    coalesceKey: options.coalesceKey ?? `trim:${clipId}`,
  }
}

export function createSplitClipCommand(clipId: string, splitTimeMs: number): CommandRecord {
  return {
    kind: "split-clip",
    name: "Split clip",
    clipId,
    splitTimeMs,
    leftClipId: crypto.randomUUID(),
    rightClipId: crypto.randomUUID(),
  }
}

export function createMoveClipCommand(
  clipId: string,
  newStartMs: number,
  newTrackId?: string,
  options: { coalesceKey?: string } = {},
): CommandRecord {
  return {
    kind: "move-clip",
    name: "Move clip",
    clipId,
    newStartMs,
    newTrackId,
    coalesce: true,
    coalesceKey: options.coalesceKey ?? `move:${clipId}`,
  }
}

export function createMoveClipsCommand(
  clipIds: string[],
  deltaMs: number,
  options: { coalesceKey?: string } = {},
): CommandRecord {
  return {
    kind: "move-clips",
    name: "Move clips",
    clipIds: [...new Set(clipIds)],
    deltaMs,
    coalesce: true,
    coalesceKey: options.coalesceKey ?? `move-clips:${[...new Set(clipIds)].sort().join(",")}`,
  }
}

export function createDeleteClipCommand(clipId: string): CommandRecord {
  return {
    kind: "delete-clip",
    name: "Delete clip",
    clipId,
  }
}

export function createDeleteClipsCommand(clipIds: string[]): CommandRecord {
  return {
    kind: "delete-clips",
    name: "Delete clips",
    clipIds: [...new Set(clipIds)],
  }
}

export function createRippleDeleteClipCommand(clipId: string): CommandRecord {
  return {
    kind: "ripple-delete-clip",
    name: "Ripple delete",
    clipId,
  }
}

export function createDeleteRangeCommand(startMs: number, endMs: number): CommandRecord {
  return {
    kind: "delete-range",
    name: "Delete range",
    startMs,
    endMs,
  }
}

export function createRippleDeleteRangeCommand(startMs: number, endMs: number): CommandRecord {
  return {
    kind: "ripple-delete-range",
    name: "Ripple delete range",
    startMs,
    endMs,
  }
}

export function createRippleDeleteClipsCommand(clipIds: string[]): CommandRecord {
  return {
    kind: "ripple-delete-clips",
    name: "Ripple delete clips",
    clipIds: [...new Set(clipIds)],
  }
}

export function createAddCursorRangeCommand(
  assetId: string,
  startMs: number,
  endMs: number,
  options: {
    trackId?: string
    rangeId?: string
    presetId?: import("@recordforge/contracts").CursorIconPreset
    scale?: number
    smoothing?: import("@recordforge/contracts").CursorSmoothing
    settings?: import("@recordforge/contracts").CursorEffectSettings
  } = {},
): CommandRecord {
  return {
    kind: "add-cursor-range",
    name: "Add cursor range",
    assetId,
    startMs,
    endMs,
    trackId: options.trackId,
    rangeId: options.rangeId ?? crypto.randomUUID(),
    presetId: options.presetId,
    scale: options.scale,
    smoothing: options.smoothing,
    settings: options.settings,
  }
}

export function createSplitCursorRangeCommand(rangeId: string, splitTimeMs: number): CommandRecord {
  return {
    kind: "split-cursor-range",
    name: "Split cursor range",
    rangeId,
    splitTimeMs,
    leftRangeId: crypto.randomUUID(),
    rightRangeId: crypto.randomUUID(),
  }
}

export function createResizeCursorRangeCommand(
  rangeId: string,
  update: { startMs?: number; endMs?: number },
  options: { coalesceKey?: string } = {},
): CommandRecord {
  return {
    kind: "resize-cursor-range",
    name: "Resize cursor range",
    rangeId,
    startMs: update.startMs,
    endMs: update.endMs,
    coalesce: true,
    coalesceKey: options.coalesceKey ?? `cursor-resize:${rangeId}`,
  }
}

export function createUpdateCursorRangeCommand(
  rangeId: string,
  update: {
    enabled?: boolean
    locked?: boolean
    presetId?: import("@recordforge/contracts").CursorIconPreset
    scale?: number
    smoothing?: import("@recordforge/contracts").CursorSmoothing
    settings?: import("@recordforge/contracts").CursorEffectSettings
  },
): CommandRecord {
  return {
    kind: "update-cursor-range",
    name: "Update cursor range",
    rangeId,
    ...update,
    coalesce: true,
    coalesceKey: `cursor-settings:${rangeId}`,
  }
}

export function createDeleteCursorRangeCommand(rangeId: string): CommandRecord {
  return {
    kind: "delete-cursor-range",
    name: "Delete cursor range",
    rangeId,
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
    clipId: crypto.randomUUID(),
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
