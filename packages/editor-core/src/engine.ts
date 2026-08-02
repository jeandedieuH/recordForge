import type { TimelineState } from "@recordforge/domain"
import type { TimelineCommand } from "./commands"
import {
  apply,
  canRedo,
  canUndo,
  createHistory,
  getRedoName,
  getUndoName,
  redo,
  type CommandResult,
  type History,
  undo,
} from "./history"

export interface CommandEngine {
  history: History<TimelineState>
}

export function createEngine(state: TimelineState): CommandEngine {
  return { history: createHistory(state) }
}

export function executeCommand(
  engine: CommandEngine,
  command: TimelineCommand,
): CommandResult<CommandEngine> {
  const result = command.execute(engine.history.present)
  if (!result.ok) return result
  return { ok: true, value: { history: apply(engine.history, result.value, command.name) } }
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
