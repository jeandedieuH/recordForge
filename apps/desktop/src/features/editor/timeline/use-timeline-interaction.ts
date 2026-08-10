import { useCallback, useEffect, useRef } from "react"
import type {
  MediaMetadata,
  TimelineClip,
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
  findClip,
  type BuildCommandResult,
  type CommandRecord,
  type CommandResult,
  type InteractionTransaction,
} from "@recordforge/editor-core"
import { useTimelineStore } from "../../../stores/timeline-store"

// Phase 2: bridge pointer/keyboard editing gestures with the editor-core
// interaction transaction. A transaction holds an immutable base state, applies
// draft commands to a throwaway preview, and produces exactly one committed
// command when the gesture ends.

interface MoveDraft {
  kind: "move"
  clipId: string
  newStartMs: number
}

interface TrimDraft {
  kind: "trim"
  clipId: string
  edge: "start" | "end"
  edgeTimeMs: number
}

type ClipDraft = MoveDraft | TrimDraft

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
  cancel: () => void
}

function buildClipCommand(
  draft: ClipDraft,
  base: TimelineState,
  selection: TimelineSelection | null,
  metadata: MediaMetadata | null,
): CommandResult<BuildCommandResult> {
  if (draft.kind === "move") {
    return buildMoveCommand(draft, base, selection)
  }
  return buildTrimCommand(draft, base, metadata)
}

function buildMoveCommand(
  draft: MoveDraft,
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
  draft: TrimDraft,
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
  const txRef = useRef<InteractionTransaction<ClipDraft> | null>(null)
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
      buildClipCommand(draft, state, selectionRef.current, metadataRef.current),
    )
  }

  function disposeTransaction() {
    if (!txRef.current) return
    txRef.current.cancel()
    txRef.current = null
    clearDraft()
  }

  function updateDraft(draft: ClipDraft) {
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

  return {
    moveClip(clip, track, newStartMs, options) {
      if (track.locked || (clip.kind === "cursor-effect" && clip.locked)) return
      const phase = options?.phase ?? "commit"

      if (phase === "cancel") {
        cancel()
        return
      }

      if (phase === "draft") {
        refreshRefs()
        updateDraft({ kind: "move", clipId: clip.id, newStartMs })
        return
      }

      // Keyboard and other immediate paths create a transient transaction and
      // commit it in one step.
      refreshRefs()
      ensureTransaction()
      const tx = txRef.current
      if (!tx) return
      const base = getBase()
      if (!base) {
        disposeTransaction()
        return
      }
      tx.begin(base, { kind: "move", clipId: clip.id, newStartMs })
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
    },

    trimClip(clip, track, edge, edgeTimeMs, options) {
      if (track.locked || (clip.kind === "cursor-effect" && clip.locked)) return
      const phase = options?.phase ?? "commit"

      if (phase === "cancel") {
        cancel()
        return
      }

      if (phase === "draft") {
        refreshRefs()
        updateDraft({ kind: "trim", clipId: clip.id, edge, edgeTimeMs })
        return
      }

      refreshRefs()
      ensureTransaction()
      const tx = txRef.current
      if (!tx) return
      const base = getBase()
      if (!base) {
        disposeTransaction()
        return
      }
      tx.begin(base, { kind: "trim", clipId: clip.id, edge, edgeTimeMs })
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
    },

    cancel,
  }
}
