import type { AppError, TimelineState } from "@recordforge/domain"
import type { CommandRecord } from "./command-records"
import { applyCommand } from "./commands"
import type { CommandResult } from "./history"

// Interaction transaction controller.
//
// Every pointer/keyboard editing gesture uses draft → validate → commit/cancel
// semantics. A transaction holds an immutable snapshot of the project at the
// start of the gesture, applies the draft command to a throwaway preview state,
// and only produces one committed command when the user finishes the gesture.
//
// This guarantees:
// - Pointer movement never mutates the project history.
// - One completed user gesture produces exactly one undo entry.
// - Cancel, pointer-capture loss, Escape, and focus loss restore the exact
//   pre-gesture state.
// - The final command is validated against the latest base state before commit.

export type InteractionPhase = "idle" | "drafting" | "committed" | "cancelled"

export interface InteractionPreview {
  /** Project state the UI should render while the gesture is active. */
  state: TimelineState | null
  /** Command that would be committed if the gesture finishes now. */
  command: CommandRecord | null
  /** Whether the current draft is valid and can be committed. */
  valid: boolean
  /** Error for invalid drafts, or null when the draft is acceptable. */
  error: AppError | null
  /** Optional visual hint about the snap target or collision result. */
  hint: string | null
}

export interface BuildCommandResult {
  /** The command the gesture will commit if valid. */
  command: CommandRecord
  /** Optional visual label describing the snap/collision target. */
  hint: string | null
}

export type BuildDraftCommand<TDraft> = (
  draft: TDraft,
  base: TimelineState,
) => CommandResult<BuildCommandResult>

export interface InteractionTransaction<TDraft> {
  /** Current phase of the gesture lifecycle. */
  readonly phase: InteractionPhase
  /** Immutable base state captured when the gesture started. */
  readonly base: TimelineState | null
  /** Current draft values, or null when no gesture is active. */
  readonly draft: TDraft | null
  /** Latest preview derived from the draft. */
  readonly preview: InteractionPreview

  /** Capture the base state and set the initial draft. */
  begin(base: TimelineState, initialDraft: TDraft): void

  /** Update the draft and return a fresh preview. */
  update(draft: TDraft): InteractionPreview

  /** Validate the final draft against the latest base and produce the commit command. */
  preflight(): CommandResult<BuildCommandResult>

  /** Mark the gesture as committed. Returns the preflight result if it was valid. */
  commit(): CommandResult<BuildCommandResult>

  /** Replace the base state with a newer compatible state before commit. */
  rebase(base: TimelineState): void

  /** Discard the gesture and restore the base state. */
  cancel(): void
}

function interactionError(code: string, message: string): AppError {
  return { category: "editor", code, message }
}

function createEmptyPreview(): InteractionPreview {
  return { state: null, command: null, valid: false, error: null, hint: null }
}

function buildPreview<TDraft>(
  base: TimelineState | null,
  draft: TDraft | null,
  buildCommand: BuildDraftCommand<TDraft>,
): InteractionPreview {
  if (!base || !draft) {
    return createEmptyPreview()
  }

  const commandResult = buildCommand(draft, base)
  if (!commandResult.ok) {
    return {
      state: null,
      command: null,
      valid: false,
      error: commandResult.error,
      hint: null,
    }
  }

  const stateResult = applyCommand(base, commandResult.value.command)
  if (!stateResult.ok) {
    return {
      state: null,
      command: commandResult.value.command,
      valid: false,
      error: stateResult.error,
      hint: null,
    }
  }

  return {
    state: stateResult.value,
    command: commandResult.value.command,
    valid: true,
    error: null,
    hint: commandResult.value.hint,
  }
}

export function createInteractionTransaction<TDraft>(
  buildCommand: BuildDraftCommand<TDraft>,
): InteractionTransaction<TDraft> {
  let phase: InteractionPhase = "idle"
  let baseState: TimelineState | null = null
  let draftValue: TDraft | null = null
  let cachedPreview: InteractionPreview = createEmptyPreview()

  return {
    get phase() {
      return phase
    },

    get base() {
      return baseState
    },

    get draft() {
      return draftValue
    },

    get preview() {
      return cachedPreview
    },

    begin(base, initialDraft) {
      baseState = base
      draftValue = initialDraft
      phase = "drafting"
      cachedPreview = buildPreview(base, initialDraft, buildCommand)
    },

    update(draft) {
      if (phase !== "drafting" || !baseState) {
        return {
          ...createEmptyPreview(),
          error: interactionError("no_active_interaction", "No active interaction to update"),
        }
      }
      draftValue = draft
      cachedPreview = buildPreview(baseState, draft, buildCommand)
      return cachedPreview
    },

    rebase(base) {
      if (phase !== "drafting") return
      baseState = base
      cachedPreview = buildPreview(baseState, draftValue, buildCommand)
    },

    preflight() {
      if (phase !== "drafting" || !baseState || !draftValue) {
        return {
          ok: false,
          error: interactionError("no_active_interaction", "No active interaction to commit"),
        } as CommandResult<BuildCommandResult>
      }

      cachedPreview = buildPreview(baseState, draftValue, buildCommand)
      if (!cachedPreview.valid || !cachedPreview.command) {
        return {
          ok: false,
          error: cachedPreview.error ?? interactionError("invalid_draft", "Draft is invalid"),
        }
      }

      return {
        ok: true,
        value: { command: cachedPreview.command, hint: cachedPreview.hint },
      }
    },

    commit() {
      const result = this.preflight()
      if (!result.ok) return result
      phase = "committed"
      return result
    },

    cancel() {
      phase = "cancelled"
      baseState = null
      draftValue = null
      cachedPreview = createEmptyPreview()
    },
  }
}
