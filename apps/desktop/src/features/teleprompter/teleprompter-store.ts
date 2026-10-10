import { create } from "zustand"
import {
  DEFAULT_TELEPROMPTER_SETTINGS,
  sanitizeSettings,
  type TeleprompterMode,
  type TeleprompterSettings,
} from "./lib/teleprompter-settings"

export const TELEPROMPTER_NOTES_KEY = "recordforge.teleprompter.notes"
export const TELEPROMPTER_SETTINGS_KEY = "recordforge.teleprompter.settings"

// Notes persist as the legacy RAW string (not JSON) so existing installs keep
// their script; settings persist as the legacy JSON blob, sanitized on load.
function loadNotes(): string {
  try {
    return localStorage.getItem(TELEPROMPTER_NOTES_KEY) ?? ""
  } catch {
    return ""
  }
}

function loadSettings(): TeleprompterSettings {
  try {
    const raw = localStorage.getItem(TELEPROMPTER_SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_TELEPROMPTER_SETTINGS }
    return sanitizeSettings(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_TELEPROMPTER_SETTINGS }
  }
}

// Writes are synchronous (not debounced) so a script is never lost when the
// window closes mid-typing. Storage may be unavailable — fail silently.
function persistNotes(notes: string) {
  try {
    localStorage.setItem(TELEPROMPTER_NOTES_KEY, notes)
  } catch {
    // Ignore quota/unavailable storage.
  }
}

function persistSettings(settings: TeleprompterSettings) {
  try {
    localStorage.setItem(TELEPROMPTER_SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // Ignore quota/unavailable storage.
  }
}

interface TeleprompterState {
  notes: string
  settings: TeleprompterSettings
  mode: TeleprompterMode
  playing: boolean
  /** Bumped by restart(); the scroll engine watches it to snap back to top. */
  restartToken: number

  setNotes: (notes: string) => void
  updateSettings: (patch: Partial<TeleprompterSettings>) => void
  setMode: (mode: TeleprompterMode) => void
  play: () => void
  pause: () => void
  togglePlay: () => void
  restart: () => void
}

const initialNotes = loadNotes()

export const useTeleprompterStore = create<TeleprompterState>((set, get) => ({
  notes: initialNotes,
  settings: loadSettings(),
  // A saved script opens straight into the prompter; a fresh window opens the editor.
  mode: initialNotes.trim() !== "" ? "prompt" : "edit",
  playing: false,
  restartToken: 0,

  setNotes: (notes) => {
    persistNotes(notes)
    set({ notes })
  },

  updateSettings: (patch) => {
    const settings = sanitizeSettings({ ...get().settings, ...patch })
    persistSettings(settings)
    set({ settings })
  },

  setMode: (mode) => {
    if (mode === "prompt" && get().notes.trim() === "") return
    set(mode === "edit" ? { mode, playing: false } : { mode })
  },

  play: () => {
    if (get().notes.trim() === "") return
    // Starting prompting from the editor always begins at the top — after a
    // finished take + edits, re-entering at the old position would instantly
    // hit the end. The Edit/Prompt toggle itself preserves position.
    set((state) =>
      state.mode === "edit"
        ? { mode: "prompt", playing: true, restartToken: state.restartToken + 1 }
        : { playing: true },
    )
  },

  pause: () => set({ playing: false }),

  togglePlay: () => {
    if (get().playing) {
      get().pause()
    } else {
      get().play()
    }
  },

  restart: () => set((state) => ({ playing: false, restartToken: state.restartToken + 1 })),
}))
