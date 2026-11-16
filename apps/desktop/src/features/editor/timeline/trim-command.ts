import type { MediaMetadata, TimelineState } from "@recordforge/contracts"
import {
  clipUsesSourceTrimLimits,
  createResizeCursorRangeCommand,
  createTrimClipCommand,
  findClip,
  type BuildCommandResult,
  type CommandResult,
} from "@recordforge/editor-core"

export interface TrimDraft {
  clipId: string
  edge: "start" | "end"
  edgeTimeMs: number
}

/**
 * Build the single committed command for one trim gesture.
 *
 * These rules must match `clampTrimEdge` in `lanes/timeline-gesture-math.ts`,
 * which produces both the HUD copy and the dragged geometry. The user releases
 * the edge exactly where the draft showed it, so a clamp that only exists here
 * turns the gesture into a no-op that snaps the clip back to where it started.
 */
export function buildTrimCommand(
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
    if (!clipUsesSourceTrimLimits(clip)) {
      // Free overlays hold their source-in point and re-derive the source range
      // from the new length, so dragging the leading edge out lengthens the
      // clip instead of shifting or reverting it.
      const nextDurationMs = Math.max(1, clipEndMs - nextStartMs)
      const sourceOutMs = Math.max(
        clip.sourceInMs + 1,
        Math.round(clip.sourceInMs + nextDurationMs * clip.speed),
      )
      const command = createTrimClipCommand(clip.id, clip.sourceInMs, sourceOutMs, {
        startMs: nextStartMs,
      })
      return { ok: true, value: { command, hint: null } }
    }
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
  const requestedSourceOutMs = clip.sourceInMs + Math.round((nextEndMs - clip.startMs) * clip.speed)
  // Only source-backed media is capped by the length of its media. Overlays and
  // b-roll layers extend freely into the freeze-frame tail, which is exactly
  // what the gesture clamp promised the user while they were dragging.
  const sourceOutMs = clipUsesSourceTrimLimits(clip)
    ? Math.min(Math.max(metadata?.durationMs ?? 0, clip.sourceOutMs), requestedSourceOutMs)
    : requestedSourceOutMs
  if (sourceOutMs <= clip.sourceInMs) {
    return {
      ok: false,
      error: { category: "editor", code: "invalid_trim", message: "Trim end must be after start" },
    }
  }
  const command = createTrimClipCommand(clip.id, clip.sourceInMs, sourceOutMs)
  return { ok: true, value: { command, hint: null } }
}
