import type { AppError } from "@recordforge/domain"
import type { CommandRecord } from "./command-records"

export interface Result<T> {
  ok: true
  value: T
}

export interface Failure<E = AppError> {
  ok: false
  error: E
}

export type CommandResult<T, E = AppError> = Result<T> | Failure<E>

export interface Transaction<T> {
  name: string
  state: T
  command: CommandRecord
  timestamp: number
}

export interface History<T> {
  past: Transaction<T>[]
  present: T
  future: Transaction<T>[]
}

export interface ApplyOptions {
  timestamp?: number
  coalesceWindowMs?: number
  cap?: number
}

const DEFAULT_COALESCE_WINDOW_MS = 250
const DEFAULT_HISTORY_CAP = 250

export function createHistory<T>(initial: T): History<T> {
  return { past: [], present: initial, future: [] }
}

function canCoalesce(
  last: Transaction<unknown> | undefined,
  command: CommandRecord,
  timestamp: number,
  windowMs: number,
): boolean {
  if (!last) return false
  if (!command.coalesce || !last.command.coalesce) return false
  if (!command.coalesceKey || !last.command.coalesceKey) return false
  if (command.coalesceKey !== last.command.coalesceKey) return false
  return timestamp - last.timestamp <= windowMs
}

export function apply<T>(
  history: History<T>,
  next: T,
  command: CommandRecord,
  options?: ApplyOptions,
): History<T> {
  const timestamp = options?.timestamp ?? Date.now()
  const windowMs = options?.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS
  const cap = options?.cap ?? DEFAULT_HISTORY_CAP
  const lastPast = history.past[history.past.length - 1]

  let past: Transaction<T>[]
  let previousState: T

  if (canCoalesce(lastPast, command, timestamp, windowMs)) {
    // Replace the last history entry so the whole high-frequency gesture
    // undoes as one unit. The transaction state is the state before the
    // gesture started; the final applied state becomes the new present.
    previousState = lastPast.state
    past = history.past.slice(0, -1)
  } else {
    previousState = history.present
    past = history.past
  }

  const transaction: Transaction<T> = {
    name: command.name,
    state: previousState,
    command,
    timestamp,
  }

  const withNewPast = { ...history, past: [...past, transaction], present: next, future: [] }

  if (withNewPast.past.length > cap) {
    const dropCount = withNewPast.past.length - cap
    return { ...withNewPast, past: withNewPast.past.slice(dropCount) }
  }

  return withNewPast
}

export function undo<T>(history: History<T>): History<T> {
  if (history.past.length === 0) return history
  const previous = history.past[history.past.length - 1]
  return {
    past: history.past.slice(0, -1),
    present: previous.state,
    future: [
      {
        name: previous.name,
        state: history.present,
        command: previous.command,
        timestamp: previous.timestamp,
      },
      ...history.future,
    ],
  }
}

export function redo<T>(history: History<T>): History<T> {
  if (history.future.length === 0) return history
  const next = history.future[0]
  return {
    past: [
      ...history.past,
      { name: next.name, state: history.present, command: next.command, timestamp: next.timestamp },
    ],
    present: next.state,
    future: history.future.slice(1),
  }
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0
}

export function getUndoName<T>(history: History<T>): string | null {
  return history.past[history.past.length - 1]?.name ?? null
}

export function getRedoName<T>(history: History<T>): string | null {
  return history.future[0]?.name ?? null
}
