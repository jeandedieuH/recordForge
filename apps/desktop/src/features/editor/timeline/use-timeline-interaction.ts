import { useCallback, useEffect, useRef } from "react"
import type {
  CaptionClip,
  ClipTransform,
  MaskRect,
  MediaMetadata,
  TimelineSelection,
  TimelineState,
  TimelineTrack,
} from "@recordforge/contracts"
import type { AppError } from "@recordforge/domain"
import {
  createInteractionTransaction,
  createMoveClipCommand,
  createMoveClipsCommand,
  createResizeCursorRangeCommand,
  createTrimClipCommand,
  createUpdateCaptionClipCommand,
  createUpdateClipTransformCommand,
  createUpdateMaskClipCommand,
  createUpdateZoomSegmentCommand,
  findClip,
  getManualZoomSegments,
  type BuildCommandResult,
  type CommandRecord,
  type CommandResult,
  type InteractionTransaction,
  type TimelineClip,
} from "@recordforge/editor-core"
import { useTimelineStore } from "../../../stores/timeline-store"

// Phase 2: bridge pointer/keyboard editing gestures with the editor-core
// interaction transaction. A transaction holds an immutable base state, applies
// draft commands to a throwaway preview, and produces exactly one committed
// command when the gesture ends.

type InteractionDraft =
  | { kind: "move"; clipId: string; newStartMs: number }
  | { kind: "trim"; clipId: string; edge: "start" | "end"; edgeTimeMs: number }
  | { kind: "camera"; clipId: string; transform: ClipTransform }
  | { kind: "mask"; clipId: string; rect: MaskRect }
  | {
      kind: "mask-update"
      clipId: string
      update: Parameters<typeof createUpdateMaskClipCommand>[1]
    }
  | { kind: "crop"; clipId: string; crop: NonNullable<ClipTransform["crop"]> }
  | {
      kind: "caption"
      clipId: string
      update: Partial<Pick<CaptionClip, "text" | "style" | "placement" | "safeAreaMargin">>
    }
  | {
      kind: "zoom"
      segmentId: string
      update: Parameters<typeof createUpdateZoomSegmentCommand>[1]
    }

export interface TimelineInteraction {
  moveClip: (
    clip: TimelineClip,
    track: TimelineTrack,
    newStartMs: number,
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
  trimClip: (
    clip: TimelineClip,
    track: TimelineTrack,
    edge: "start" | "end",
    edgeTimeMs: number,
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
  updateClipTransform: (
    clipId: string,
    transform: ClipTransform,
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
  updateMaskRect: (
    clipId: string,
    rect: MaskRect,
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
  updateMask: (
    clipId: string,
    update: Parameters<typeof createUpdateMaskClipCommand>[1],
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
  updateClipCrop: (
    clipId: string,
    crop: NonNullable<ClipTransform["crop"]>,
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
  updateCaption: (
    clipId: string,
    update: Partial<Pick<CaptionClip, "text" | "style" | "placement" | "safeAreaMargin">>,
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
  updateZoomTarget: (
    segmentId: string,
    update: Parameters<typeof createUpdateZoomSegmentCommand>[1],
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
  cancel: () => void
}

function buildCommand(
  draft: InteractionDraft,
  base: TimelineState,
  selection: TimelineSelection | null,
  metadata: MediaMetadata | null,
): CommandResult<BuildCommandResult> {
  switch (draft.kind) {
    case "move":
      return buildMoveCommand(draft, base, selection)
    case "trim":
      return buildTrimCommand(draft, base, metadata)
    case "camera":
      return buildCameraCommand(draft, base)
    case "mask":
      return buildMaskCommand(draft, base)
    case "mask-update":
      return buildMaskUpdateCommand(draft, base)
    case "crop":
      return buildCropCommand(draft, base)
    case "caption":
      return buildCaptionCommand(draft, base)
    case "zoom":
      return buildZoomCommand(draft, base)
  }
}

function buildMoveCommand(
  draft: Extract<InteractionDraft, { kind: "move" }>,
  base: TimelineState,
  selection: TimelineSelection | null,
): CommandResult<BuildCommandResult> {
  const found = findClip(base, draft.clipId)
  if (!found) {
    return {
      ok: false,
      error: { category: "editor", code: "clip_not_found", message: "Clip not found" },
    }
  }
  const { clip, track } = found
  if (track.locked || (clip.kind === "cursor-effect" && clip.locked)) {
    return {
      ok: false,
      error: { category: "editor", code: "track_locked", message: "Track is locked" },
    }
  }

  if (
    selection?.kind === "clip" &&
    selection.clipIds.length > 1 &&
    selection.clipIds.includes(clip.id)
  ) {
    return {
      ok: true,
      value: {
        command: createMoveClipsCommand(
          selection.clipIds,
          Math.round(draft.newStartMs - clip.startMs),
        ),
        hint: null,
      },
    }
  }

  return {
    ok: true,
    value: {
      command: createMoveClipCommand(clip.id, Math.max(0, Math.round(draft.newStartMs))),
      hint: null,
    },
  }
}

function buildTrimCommand(
  draft: Extract<InteractionDraft, { kind: "trim" }>,
  base: TimelineState,
  metadata: MediaMetadata | null,
): CommandResult<BuildCommandResult> {
  const found = findClip(base, draft.clipId)
  if (!found) {
    return {
      ok: false,
      error: { category: "editor", code: "clip_not_found", message: "Clip not found" },
    }
  }
  const { clip, track } = found
  if (track.locked || (clip.kind === "cursor-effect" && clip.locked)) {
    return {
      ok: false,
      error: { category: "editor", code: "track_locked", message: "Track is locked" },
    }
  }

  const clipEndMs = clip.startMs + clip.durationMs
  const nextEdgeMs = Math.round(draft.edgeTimeMs)

  if (clip.kind === "cursor-effect") {
    const command = createResizeCursorRangeCommand(
      clip.id,
      draft.edge === "start"
        ? { startMs: Math.max(0, Math.min(clipEndMs - 1, nextEdgeMs)) }
        : { endMs: Math.max(clip.startMs + 1, nextEdgeMs) },
    )
    return { ok: true, value: { command, hint: null } }
  }

  if (draft.edge === "start") {
    const nextStartMs = Math.max(0, Math.min(clipEndMs - 1, nextEdgeMs))
    const sourceInMs = Math.max(
      0,
      clip.sourceInMs + Math.round((nextStartMs - clip.startMs) * clip.speed),
    )
    if (sourceInMs >= clip.sourceOutMs) {
      return {
        ok: false,
        error: {
          category: "editor",
          code: "invalid_trim",
          message: "Trim start must be before end",
        },
      }
    }
    const command = createTrimClipCommand(clip.id, sourceInMs, clip.sourceOutMs, {
      startMs: nextStartMs,
    })
    return { ok: true, value: { command, hint: null } }
  }

  const nextEndMs = Math.max(clip.startMs + 1, nextEdgeMs)
  const sourceDurationMs = Math.max(metadata?.durationMs ?? 0, clip.sourceOutMs)
  const sourceOutMs = Math.min(
    sourceDurationMs,
    clip.sourceInMs + Math.round((nextEndMs - clip.startMs) * clip.speed),
  )
  if (sourceOutMs <= clip.sourceInMs) {
    return {
      ok: false,
      error: { category: "editor", code: "invalid_trim", message: "Trim end must be after start" },
    }
  }
  const command = createTrimClipCommand(clip.id, clip.sourceInMs, sourceOutMs)
  return { ok: true, value: { command, hint: null } }
}

function buildCameraCommand(
  draft: Extract<InteractionDraft, { kind: "camera" }>,
  base: TimelineState,
): CommandResult<BuildCommandResult> {
  const found = findClip(base, draft.clipId)
  if (!found) {
    return {
      ok: false,
      error: { category: "editor", code: "clip_not_found", message: "Clip not found" },
    }
  }
  const { clip, track } = found
  if (track.locked || (clip.kind === "cursor-effect" && clip.locked)) {
    return {
      ok: false,
      error: { category: "editor", code: "track_locked", message: "Track is locked" },
    }
  }
  if (clip.kind !== "camera") {
    return {
      ok: false,
      error: { category: "editor", code: "invalid_clip", message: "Clip is not a camera clip" },
    }
  }
  return {
    ok: true,
    value: { command: createUpdateClipTransformCommand(clip.id, draft.transform), hint: null },
  }
}

function buildMaskCommand(
  draft: Extract<InteractionDraft, { kind: "mask" }>,
  base: TimelineState,
): CommandResult<BuildCommandResult> {
  const found = findClip(base, draft.clipId)
  if (!found) {
    return {
      ok: false,
      error: { category: "editor", code: "clip_not_found", message: "Clip not found" },
    }
  }
  const { clip, track } = found
  if (track.locked || (clip.kind === "cursor-effect" && clip.locked)) {
    return {
      ok: false,
      error: { category: "editor", code: "track_locked", message: "Track is locked" },
    }
  }
  if (clip.kind !== "mask") {
    return {
      ok: false,
      error: { category: "editor", code: "invalid_clip", message: "Clip is not a mask clip" },
    }
  }
  return {
    ok: true,
    value: { command: createUpdateMaskClipCommand(clip.id, { rect: draft.rect }), hint: null },
  }
}

function buildMaskUpdateCommand(
  draft: Extract<InteractionDraft, { kind: "mask-update" }>,
  base: TimelineState,
): CommandResult<BuildCommandResult> {
  const found = findClip(base, draft.clipId)
  if (!found) {
    return {
      ok: false,
      error: { category: "editor", code: "clip_not_found", message: "Clip not found" },
    }
  }
  const { clip, track } = found
  if (track.locked || (clip.kind === "cursor-effect" && clip.locked)) {
    return {
      ok: false,
      error: { category: "editor", code: "track_locked", message: "Track is locked" },
    }
  }
  if (clip.kind !== "mask") {
    return {
      ok: false,
      error: { category: "editor", code: "invalid_clip", message: "Clip is not a mask clip" },
    }
  }
  return {
    ok: true,
    value: { command: createUpdateMaskClipCommand(clip.id, draft.update), hint: null },
  }
}

function buildCropCommand(
  draft: Extract<InteractionDraft, { kind: "crop" }>,
  base: TimelineState,
): CommandResult<BuildCommandResult> {
  const found = findClip(base, draft.clipId)
  if (!found) {
    return {
      ok: false,
      error: { category: "editor", code: "clip_not_found", message: "Clip not found" },
    }
  }
  const { clip, track } = found
  if (track.locked || (clip.kind === "cursor-effect" && clip.locked)) {
    return {
      ok: false,
      error: { category: "editor", code: "track_locked", message: "Track is locked" },
    }
  }
  if (clip.kind !== "camera") {
    return {
      ok: false,
      error: {
        category: "editor",
        code: "invalid_clip",
        message: "Crop only applies to camera clips",
      },
    }
  }
  const transform: ClipTransform = { ...clip.transform, crop: draft.crop }
  return {
    ok: true,
    value: { command: createUpdateClipTransformCommand(clip.id, transform), hint: null },
  }
}

function buildCaptionCommand(
  draft: Extract<InteractionDraft, { kind: "caption" }>,
  base: TimelineState,
): CommandResult<BuildCommandResult> {
  const found = findClip(base, draft.clipId)
  if (!found) {
    return {
      ok: false,
      error: { category: "editor", code: "clip_not_found", message: "Clip not found" },
    }
  }
  const { clip, track } = found
  if (track.locked || (clip.kind === "cursor-effect" && clip.locked)) {
    return {
      ok: false,
      error: { category: "editor", code: "track_locked", message: "Track is locked" },
    }
  }
  if (clip.kind !== "caption") {
    return {
      ok: false,
      error: { category: "editor", code: "invalid_clip", message: "Clip is not a caption clip" },
    }
  }
  return {
    ok: true,
    value: { command: createUpdateCaptionClipCommand(clip.id, draft.update), hint: null },
  }
}

function buildZoomCommand(
  draft: Extract<InteractionDraft, { kind: "zoom" }>,
  base: TimelineState,
): CommandResult<BuildCommandResult> {
  const segment = getManualZoomSegments(base).find((s) => s.id === draft.segmentId)
  if (!segment) {
    return {
      ok: false,
      error: {
        category: "editor",
        code: "zoom_segment_not_found",
        message: "Zoom segment not found",
      },
    }
  }
  if (segment.locked) {
    return {
      ok: false,
      error: { category: "editor", code: "zoom_segment_locked", message: "Zoom segment is locked" },
    }
  }
  return {
    ok: true,
    value: { command: createUpdateZoomSegmentCommand(draft.segmentId, draft.update), hint: null },
  }
}

function setDraft(preview: { state: TimelineState | null; error: AppError | null }) {
  if (preview.state) {
    useTimelineStore.getState().setDraftTimeline(preview.state, preview.error)
  } else {
    useTimelineStore.getState().setDraftTimeline(null, preview.error)
  }
}

function clearDraft() {
  useTimelineStore.getState().clearDraft()
}

function executeCommand(command: CommandRecord): boolean {
  return useTimelineStore.getState().execute(command)
}

function setError(message: string) {
  useTimelineStore.getState().setError(message)
}

export function useTimelineInteraction(): TimelineInteraction {
  const txRef = useRef<InteractionTransaction<InteractionDraft> | null>(null)
  const selectionRef = useRef<TimelineSelection | null>(null)
  const metadataRef = useRef<MediaMetadata | null>(null)

  // Refresh the captured metadata and selection before each gesture so the
  // command builder works with the latest view state.
  const refreshRefs = useCallback(() => {
    const state = useTimelineStore.getState()
    selectionRef.current = state.view.selection
    metadataRef.current = state.metadata
  }, [])

  function getBase(): TimelineState | null {
    return useTimelineStore.getState().engine?.history.present ?? null
  }

  function ensureTransaction() {
    if (txRef.current) return
    const base = getBase()
    if (!base) return
    txRef.current = createInteractionTransaction((draft, state) =>
      buildCommand(draft, state, selectionRef.current, metadataRef.current),
    )
  }

  function disposeTransaction() {
    if (!txRef.current) return
    txRef.current.cancel()
    txRef.current = null
    clearDraft()
  }

  function updateDraft(draft: InteractionDraft) {
    ensureTransaction()
    const tx = txRef.current
    if (!tx) return
    if (tx.phase === "idle") {
      const base = getBase()
      if (!base) return
      tx.begin(base, draft)
    } else {
      tx.update(draft)
    }
    setDraft(tx.preview)
  }

  function cancel() {
    disposeTransaction()
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      if (
        event.target instanceof HTMLElement &&
        ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)
      ) {
        return
      }
      cancel()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  function handleDraftOrCommit(draft: InteractionDraft, phase: "draft" | "commit" | "cancel") {
    if (phase === "cancel") {
      cancel()
      return
    }
    if (phase === "draft") {
      refreshRefs()
      updateDraft(draft)
      return
    }
    // Immediate commit path: refresh builder refs, create a transient
    // transaction, and commit it in one step.
    refreshRefs()
    ensureTransaction()
    const tx = txRef.current
    if (!tx) return
    const base = getBase()
    if (!base) {
      disposeTransaction()
      return
    }
    tx.begin(base, draft)
    const currentBase = getBase()
    if (currentBase) tx.rebase(currentBase)
    const result = tx.commit()
    if (result.ok) {
      executeCommand(result.value.command)
    } else if (!result.ok) {
      setError(result.error.message)
    }
    txRef.current = null
    clearDraft()
  }

  return {
    moveClip(clip, track, newStartMs, options) {
      if (track.locked || (clip.kind === "cursor-effect" && clip.locked)) return
      handleDraftOrCommit({ kind: "move", clipId: clip.id, newStartMs }, options?.phase ?? "commit")
    },

    trimClip(clip, track, edge, edgeTimeMs, options) {
      if (track.locked || (clip.kind === "cursor-effect" && clip.locked)) return
      handleDraftOrCommit(
        { kind: "trim", clipId: clip.id, edge, edgeTimeMs },
        options?.phase ?? "commit",
      )
    },

    updateClipTransform(clipId, transform, options) {
      handleDraftOrCommit({ kind: "camera", clipId, transform }, options?.phase ?? "commit")
    },

    updateMaskRect(clipId, rect, options) {
      handleDraftOrCommit({ kind: "mask", clipId, rect }, options?.phase ?? "commit")
    },

    updateMask(clipId, update, options) {
      handleDraftOrCommit({ kind: "mask-update", clipId, update }, options?.phase ?? "commit")
    },

    updateClipCrop(clipId, crop, options) {
      handleDraftOrCommit({ kind: "crop", clipId, crop }, options?.phase ?? "commit")
    },

    updateCaption(clipId, update, options) {
      handleDraftOrCommit({ kind: "caption", clipId, update }, options?.phase ?? "commit")
    },

    updateZoomTarget(segmentId, update, options) {
      handleDraftOrCommit({ kind: "zoom", segmentId, update }, options?.phase ?? "commit")
    },

    cancel,
  }
}
