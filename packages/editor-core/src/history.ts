import type { AppError } from "@recordforge/domain"

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
}

export interface History<T> {
  past: Transaction<T>[]
  present: T
  future: Transaction<T>[]
}

export function createHistory<T>(initial: T): History<T> {
  return { past: [], present: initial, future: [] }
}

export function apply<T>(history: History<T>, next: T, name: string): History<T> {
  return {
    past: [...history.past, { name, state: history.present }],
    present: next,
    future: [],
  }
}

export function undo<T>(history: History<T>): History<T> {
  if (history.past.length === 0) return history
  const previous = history.past[history.past.length - 1]
  return {
    past: history.past.slice(0, -1),
    present: previous.state,
    future: [{ name: previous.name, state: history.present }, ...history.future],
  }
}

export function redo<T>(history: History<T>): History<T> {
  if (history.future.length === 0) return history
  const next = history.future[0]
  return {
    past: [...history.past, { name: next.name, state: history.present }],
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
