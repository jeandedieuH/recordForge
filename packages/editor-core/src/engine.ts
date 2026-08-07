import type { TimelineState } from "@recordforge/domain"
import type { CommandRecord } from "./command-records"
import { applyCommand, canApplyCommand } from "./commands"
import type { CommandResult } from "./history"
import {
  apply,
  canRedo,
  canUndo,
  createHistory,
  getRedoName,
  getUndoName,
  redo,
  type History,
  undo,
} from "./history"

export interface CommandEngine {
  history: History<TimelineState>
}

export interface ExecuteOptions {
  /** Override the command's coalesce flag for high-frequency gestures. */
  coalesce?: boolean
  /** Override the default coalescing window in milliseconds. */
  coalesceWindowMs?: number
  /** Override the history cap for this command. */
  cap?: number
  /** Explicit timestamp for deterministic tests and replay. */
  timestamp?: number
}

export function createEngine(state: TimelineState): CommandEngine {
  return { history: createHistory(state) }
}

export function canExecute(engine: CommandEngine, command: CommandRecord): CommandResult<void> {
  return canApplyCommand(engine.history.present, command)
}

export function executeCommand(
  engine: CommandEngine,
  command: CommandRecord,
  options?: ExecuteOptions,
): CommandResult<CommandEngine> {
  const can = canApplyCommand(engine.history.present, command)
  if (!can.ok) return can

  const result = applyCommand(engine.history.present, command)
  if (!result.ok) return result

  const coalesce = options?.coalesce ?? command.coalesce
  const coalesceKey = coalesce && command.coalesceKey ? command.coalesceKey : undefined
  const commandToApply: CommandRecord = {
    ...command,
    coalesce,
    coalesceKey,
  }

  return {
    ok: true,
    value: {
      history: apply(engine.history, result.value, commandToApply, {
        timestamp: options?.timestamp,
        coalesceWindowMs: options?.coalesceWindowMs,
        cap: options?.cap,
      }),
    },
  }
}

export function undoCommand(engine: CommandEngine): CommandResult<CommandEngine> {
  if (!canUndo(engine.history)) {
    return {
      ok: false,
      error: {
        category: "editor",
        code: "nothing_to_undo",
        message: "Nothing to undo",
      },
    }
  }
  return { ok: true, value: { history: undo(engine.history) } }
}

export function redoCommand(engine: CommandEngine): CommandResult<CommandEngine> {
  if (!canRedo(engine.history)) {
    return {
      ok: false,
      error: {
        category: "editor",
        code: "nothing_to_redo",
        message: "Nothing to redo",
      },
    }
  }
  return { ok: true, value: { history: redo(engine.history) } }
}

export function getUndoLabel(engine: CommandEngine): string | null {
  return getUndoName(engine.history)
}

export function getRedoLabel(engine: CommandEngine): string | null {
  return getRedoName(engine.history)
}
