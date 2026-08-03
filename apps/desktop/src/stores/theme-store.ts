import { create } from "zustand"
import {
  getSetting,
  isTauri,
  setSetting,
  setWindowTransparency,
  windowTransparencyActive,
} from "../lib/settings"

type Theme = "dark" | "light" | "system"
type ResolvedTheme = "dark" | "light"

interface ThemeStore {
  theme: Theme
  resolvedTheme: ResolvedTheme
  /** User preference for the Mica transparency effect. */
  micaEnabled: boolean
  /** Whether the effect is actually active (false = opaque fallback). */
  micaActive: boolean
  loaded: boolean

  load: () => Promise<void>
  setTheme: (theme: Theme) => Promise<void>
  setMicaEnabled: (enabled: boolean) => Promise<void>
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"
}

function resolve(theme: Theme): ResolvedTheme {
  return theme === "system" ? systemTheme() : theme
}

/** Push the resolved theme + Mica state onto <html> so tokens re-scope. */
function applyToDocument(resolvedTheme: ResolvedTheme, micaActive: boolean) {
  const root = document.documentElement
  root.dataset.theme = resolvedTheme
  if (micaActive) {
    root.dataset.mica = "true"
  } else {
    delete root.dataset.mica
  }
}

// Dark-first by default per spec-010; the persisted setting is applied in load().
export const useThemeStore = create<ThemeStore>((set, get) => ({
  theme: "dark",
  resolvedTheme: "dark",
  micaEnabled: true,
  micaActive: false,
  loaded: false,

  load: async () => {
    let theme: Theme = "dark"
    let micaEnabled = true
    let micaActive = false

    if (isTauri()) {
      try {
        const storedTheme = await getSetting("theme")
        if (storedTheme === "dark" || storedTheme === "light" || storedTheme === "system") {
          theme = storedTheme
        }
        micaEnabled = (await getSetting("windowTransparency")) !== "false"
        micaActive = await windowTransparencyActive()
      } catch {
        // IPC unavailable (e.g. early startup) — fall back to defaults.
      }
    }

    const resolvedTheme = resolve(theme)
    applyToDocument(resolvedTheme, micaEnabled && micaActive)
    set({ theme, resolvedTheme, micaEnabled, micaActive, loaded: true })
  },

  setTheme: async (theme) => {
    const resolvedTheme = resolve(theme)
    const { micaEnabled, micaActive } = get()
    applyToDocument(resolvedTheme, micaEnabled && micaActive)
    set({ theme, resolvedTheme })
    if (isTauri()) {
      await setSetting("theme", theme)
    }
  },

  setMicaEnabled: async (enabled) => {
    let active = false
    if (isTauri()) {
      active = await setWindowTransparency(enabled)
      if (enabled) {
        await setSetting("windowTransparency", "true")
      } else {
        await setSetting("windowTransparency", "false")
      }
    }
    const { resolvedTheme } = get()
    applyToDocument(resolvedTheme, active)
    set({ micaEnabled: enabled, micaActive: active })
  },
}))

// Follow the OS theme while the user preference is "system".
if (typeof window !== "undefined") {
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    const { theme, micaEnabled, micaActive } = useThemeStore.getState()
    if (theme !== "system") return
    const resolvedTheme = systemTheme()
    applyToDocument(resolvedTheme, micaEnabled && micaActive)
    useThemeStore.setState({ resolvedTheme })
  })
}
