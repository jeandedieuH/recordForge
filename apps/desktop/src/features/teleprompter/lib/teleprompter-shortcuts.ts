import type { TeleprompterMode } from "./teleprompter-settings"

export type ShortcutAction =
  | "toggle-play"
  | "speed-up"
  | "speed-down"
  | "size-up"
  | "size-down"
  | "restart"
  | "toggle-mirror"
  | "edit"
  | "escape"
  | "start"

export interface ShortcutEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  repeat: boolean
  defaultPrevented: boolean
}

export interface ShortcutTarget {
  tagName: string
  isContentEditable?: boolean
  role?: string | null
}

const TEXT_ENTRY_TAGS = new Set(["input", "textarea", "select"])
const REPEATABLE_KEYS = new Set(["ArrowUp", "ArrowDown", "+", "=", "-", "_"])

function isTextEntry(target: ShortcutTarget | null): boolean {
  if (!target) return false
  return TEXT_ENTRY_TAGS.has(target.tagName.toLowerCase()) || target.isContentEditable === true
}

/** Maps a keydown to a teleprompter action, or null when the event should keep
 *  its native meaning (typing, OS shortcuts, focused controls). */
export function resolveShortcut(
  event: ShortcutEvent,
  target: ShortcutTarget | null,
  mode: TeleprompterMode,
): ShortcutAction | null {
  if (event.defaultPrevented) return null

  const key = event.key
  const hasModifier = event.ctrlKey || event.metaKey || event.altKey

  // Ctrl/Cmd+Enter = "start prompting" — deliberately allowed from inside the
  // editor textarea, where it reads as a natural submit gesture.
  if (key === "Enter" && (event.ctrlKey || event.metaKey)) {
    return mode === "edit" ? "start" : null
  }

  if (isTextEntry(target)) {
    // Plain keys keep editing semantics; Escape still routes to the prompter so
    // the script can be sent back without leaving the keyboard.
    return key === "Escape" && !hasModifier ? "escape" : null
  }

  // Modified plain keys belong to the OS/browser (Ctrl+R, Alt+arrows, IME
  // Ctrl+Space, Ctrl+scroll-zoom) — never reinterpret them.
  if (hasModifier) return null

  // Held keys may auto-repeat only for the continuous adjustments.
  if (event.repeat && !REPEATABLE_KEYS.has(key)) return null

  const tagName = target?.tagName.toLowerCase()
  const role = target?.role
  const onButton = tagName === "button" || role === "button"
  const onSlider = role === "slider"

  switch (key) {
    case " ":
    case "Spacebar":
      // A focused button clicks itself on Space; Radix sliders ignore Space.
      return onButton ? null : "toggle-play"
    case "ArrowUp":
      return onSlider ? null : "speed-up"
    case "ArrowDown":
      return onSlider ? null : "speed-down"
    case "+":
    case "=":
      return "size-up"
    case "-":
    case "_":
      return "size-down"
    case "r":
    case "R":
      return "restart"
    case "m":
    case "M":
      return "toggle-mirror"
    case "e":
    case "E":
      return mode === "prompt" ? "edit" : null
    case "Escape":
      return "escape"
    default:
      return null
  }
}
