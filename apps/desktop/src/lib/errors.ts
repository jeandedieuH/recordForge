import type { AppError } from "@recordforge/contracts"

/**
 * Extract a human-readable message from a value caught in a `try/catch`.
 *
 * Tauri commands return `Result<T, AppError>`, and on rejection `invoke()`
 * delivers the serialized `AppError` object (`{ category, code, message, ... }`)
 * — NOT a string. Calling `String(err)` on that object renders `[object Object]`
 * and hides the real backend message (e.g. an FFmpeg capture failure). This
 * helper surfaces the actual message regardless of the thrown value's shape:
 *
 * - `AppError`-shaped objects  → `err.message`
 * - standard `Error` instances → `err.message`
 * - strings                    → the string itself (parsed for JSON `AppError`)
 * - anything else              → `String(err)` fallback
 */
export function toErrorMessage(error: unknown): string {
  if (error == null) {
    return "Unknown error"
  }

  // Tauri delivers the rejected AppError as a plain object.
  if (typeof error === "object" && !Array.isArray(error)) {
    const maybe = error as { message?: unknown }
    if (typeof maybe.message === "string" && maybe.message.length > 0) {
      return maybe.message
    }
  }

  // Tauri sometimes stringifies the rejection before handing it to JS.
  if (typeof error === "string") {
    if (error.startsWith("{")) {
      const parsed = safeParseAppError(error)
      if (parsed) return parsed
    }
    return error
  }

  // Standard Error instances and other throwables.
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

// Attempt to parse a JSON string into an AppError message; returns null on
// any shape mismatch so callers fall through to the raw string.
function safeParseAppError(text: string): string | null {
  try {
    const obj = JSON.parse(text) as Partial<AppError>
    if (typeof obj.message === "string" && obj.message.length > 0) {
      return obj.message
    }
  } catch {
    // Not JSON — ignore.
  }
  return null
}
