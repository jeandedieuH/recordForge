import { describe, expect, it } from "vitest"
import { defaultCursorSettings, type AppError, type TimelineState } from "@recordforge/domain"
import {
  applyCommand,
  createInteractionTransaction,
  createMoveClipCommand,
  createTrimClipCommand,
} from "./index"
import type { BuildCommandResult, BuildDraftCommand } from "./interaction-transaction"

function makeState(): TimelineState {
  return {
    version: 1,
    id: "project-1",
    name: "Interaction test",
    recordingId: "rec-1",
    canvas: {
      width: 1920,
      height: 1080,
      fps: 30,
      background: "#000000",
      padding: 0,
      borderRadius: 0,
      shadow: false,
      cursorSettings: defaultCursorSettings,
    },
    tracks: [
      {
        id: "track-1",
        kind: "screen",
        name: "Screen",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "clip-1",
            kind: "screen",
            assetId: "rec-1",
            startMs: 0,
            durationMs: 10_000,
            sourceInMs: 0,
            sourceOutMs: 10_000,
            speed: 1,
          },
          {
            id: "clip-2",
            kind: "screen",
            assetId: "rec-1",
            startMs: 15_000,
            durationMs: 5_000,
            sourceInMs: 10_000,
            sourceOutMs: 15_000,
            speed: 1,
          },
        ],
      },
    ],
    markers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

interface MoveDraft {
  clipId: string
  newStartMs: number
}

function buildMoveCommand(
  draft: MoveDraft,
  base: TimelineState,
): { ok: true; value: BuildCommandResult } | { ok: false; error: AppError } {
  const clip = base.tracks.flatMap((t) => t.clips).find((c) => c.id === draft.clipId)
  if (!clip) {
    return {
      ok: false,
      error: { category: "editor", code: "clip_not_found", message: "Clip not found" },
    }
  }
  return {
    ok: true,
    value: {
      command: createMoveClipCommand(draft.clipId, Math.max(0, Math.round(draft.newStartMs))),
      hint: null,
    },
  }
}

interface TrimDraft {
  clipId: string
  sourceInMs: number
  sourceOutMs: number
}

function buildTrimCommand(
  draft: TrimDraft,
  base: TimelineState,
): { ok: true; value: BuildCommandResult } | { ok: false; error: AppError } {
  const clip = base.tracks.flatMap((t) => t.clips).find((c) => c.id === draft.clipId)
  if (!clip) {
    return {
      ok: false,
      error: { category: "editor", code: "clip_not_found", message: "Clip not found" },
    }
  }
  return {
    ok: true,
    value: {
      command: createTrimClipCommand(
        draft.clipId,
        Math.round(draft.sourceInMs),
        Math.round(draft.sourceOutMs),
      ),
      hint: null,
    },
  }
}

describe("interaction transaction", () => {
  it("captures the base state and begins in the drafting phase", () => {
    const base = makeState()
    const tx = createInteractionTransaction(buildMoveCommand)
    tx.begin(base, { clipId: "clip-1", newStartMs: 5_000 })

    expect(tx.phase).toBe("drafting")
    expect(tx.base).toBe(base)
    expect(tx.draft).toEqual({ clipId: "clip-1", newStartMs: 5_000 })
    expect(tx.preview.valid).toBe(true)
    expect(tx.preview.state).not.toBeNull()
    expect(tx.preview.command).not.toBeNull()
  })

  it("updates the preview without mutating the base state", () => {
    const base = makeState()
    const tx = createInteractionTransaction(buildMoveCommand)
    tx.begin(base, { clipId: "clip-1", newStartMs: 0 })

    const initialPreview = tx.preview
    tx.update({ clipId: "clip-1", newStartMs: 3_000 })

    expect(tx.preview.state).not.toBeNull()
    expect(tx.draft?.newStartMs).toBe(3_000)
    expect(tx.preview.command).not.toEqual(initialPreview.command)

    // Base state is never mutated by an update.
    expect(base.tracks[0].clips[0].startMs).toBe(0)
    expect(initialPreview.state).not.toBe(tx.preview.state)
  })

  it("commits a single command and records it in history", () => {
    const base = makeState()
    const tx = createInteractionTransaction(buildMoveCommand)
    tx.begin(base, { clipId: "clip-1", newStartMs: 0 })
    tx.update({ clipId: "clip-1", newStartMs: 3_000 })

    const result = tx.commit()
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(tx.phase).toBe("committed")
    expect(result.value.command.kind).toBe("move-clip")

    const applied = applyCommand(base, result.value.command)
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    expect(applied.value.tracks[0].clips[0].startMs).toBe(3_000)
  })

  it("cancels and discards the draft", () => {
    const base = makeState()
    const tx = createInteractionTransaction(buildMoveCommand)
    tx.begin(base, { clipId: "clip-1", newStartMs: 0 })
    tx.update({ clipId: "clip-1", newStartMs: 3_000 })
    tx.cancel()

    expect(tx.phase).toBe("cancelled")
    expect(tx.base).toBeNull()
    expect(tx.draft).toBeNull()
    expect(tx.preview.state).toBeNull()
    expect(base.tracks[0].clips[0].startMs).toBe(0)
  })

  it("reports an invalid draft without mutating state", () => {
    const base = makeState()
    const tx = createInteractionTransaction(buildTrimCommand)
    tx.begin(base, { clipId: "clip-1", sourceInMs: 8_000, sourceOutMs: 2_000 })

    expect(tx.preview.valid).toBe(false)
    expect(tx.preview.error).not.toBeNull()
    expect(base.tracks[0].clips[0].sourceInMs).toBe(0)

    const commit = tx.commit()
    expect(commit.ok).toBe(false)
  })

  it("rejects a commit when the command would overlap another clip", () => {
    const base = makeState()
    const tx = createInteractionTransaction(buildMoveCommand)
    tx.begin(base, { clipId: "clip-2", newStartMs: 1_000 })

    expect(tx.preview.valid).toBe(false)
    expect(tx.preview.error?.code).toBe("clip_overlap")

    const commit = tx.commit()
    expect(commit.ok).toBe(false)
  })

  it("rejects operations on locked tracks", () => {
    const base = makeState()
    base.tracks[0].locked = true
    const tx = createInteractionTransaction(buildMoveCommand)
    tx.begin(base, { clipId: "clip-1", newStartMs: 1_000 })

    expect(tx.preview.valid).toBe(false)
    expect(tx.preview.error?.code).toBe("track_locked")

    const commit = tx.commit()
    expect(commit.ok).toBe(false)
  })

  it("rebases against the latest state before commit", () => {
    const base = makeState()
    const tx = createInteractionTransaction(buildMoveCommand)
    tx.begin(base, { clipId: "clip-1", newStartMs: 3_000 })

    // Simulate an external change while the gesture is active by editing the
    // base state directly (a new commit from another source).
    const edited: TimelineState = {
      ...base,
      tracks: base.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) =>
          clip.id === "clip-1" ? { ...clip, startMs: 1_000 } : clip,
        ),
      })),
    }

    tx.rebase(edited)
    const result = tx.commit()
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const applied = applyCommand(edited, result.value.command)
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    expect(applied.value.tracks[0].clips[0].startMs).toBe(3_000)
  })

  it("accepts a builder that returns custom hints", () => {
    const withHint: BuildDraftCommand<MoveDraft> = (draft, base) => {
      const clip = base.tracks.flatMap((t) => t.clips).find((c) => c.id === draft.clipId)
      if (!clip) {
        return {
          ok: false,
          error: { category: "editor", code: "clip_not_found", message: "Clip not found" },
        }
      }
      return {
        ok: true,
        value: {
          command: createMoveClipCommand(draft.clipId, Math.max(0, Math.round(draft.newStartMs))),
          hint: "snapped to playhead",
        },
      }
    }

    const base = makeState()
    const tx = createInteractionTransaction(withHint)
    tx.begin(base, { clipId: "clip-1", newStartMs: 2_000 })

    const result = tx.commit()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.hint).toBe("snapped to playhead")
  })
})
