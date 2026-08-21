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

function formatZodIssues(issues: Array<{ path?: Array<string | number>; message?: string }>): string {
  const messages = issues.map((issue) => {
    const path = issue.path && issue.path.length > 0 ? issue.path.join(".") : ""
    return path ? `${path}: ${issue.message ?? "Invalid value"}` : (issue.message ?? "Validation error")
  })
  return messages.join("; ")
}

export function toErrorMessage(error: unknown): string {
  if (error == null) {
    return "Unknown error"
  }

  // ZodError instance or object with issues array
  if (
    typeof error === "object" &&
    error !== null &&
    "issues" in error &&
    Array.isArray((error as { issues?: unknown[] }).issues)
  ) {
    const issues = (error as { issues: Array<{ path?: Array<string | number>; message?: string }> }).issues
    if (issues.length > 0) {
      return formatZodIssues(issues)
    }
  }

  // Tauri delivers the rejected AppError as a plain object.
  if (typeof error === "object" && !Array.isArray(error)) {
    const maybe = error as { message?: unknown }
    if (typeof maybe.message === "string" && maybe.message.length > 0) {
      if (maybe.message.startsWith("[{") || maybe.message.startsWith("[ {")) {
        try {
          const parsed = JSON.parse(maybe.message)
          if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.message) {
            return formatZodIssues(parsed)
          }
        } catch {
          // ignore
        }
      }
      return maybe.message
    }
  }

  // Tauri sometimes stringifies the rejection before handing it to JS.
  if (typeof error === "string") {
    if (error.startsWith("{")) {
      const parsed = safeParseAppError(error)
      if (parsed) return parsed
    }
    if (error.startsWith("[{") || error.startsWith("[ {")) {
      try {
        const parsed = JSON.parse(error)
        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.message) {
          return formatZodIssues(parsed)
        }
      } catch {
        // ignore
      }
    }
    return error
  }

  // Standard Error instances and other throwables.
  if (error instanceof Error) {
    if (error.message.startsWith("[{") || error.message.startsWith("[ {")) {
      try {
        const parsed = JSON.parse(error.message)
        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.message) {
          return formatZodIssues(parsed)
        }
      } catch {
        // ignore
      }
    }
    return error.message
  }

  return String(error)
}
