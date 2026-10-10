import { useEffect, useRef } from "react"
import { FONT_SIZE_LIMIT, WPM_LIMIT } from "../lib/teleprompter-settings"
import { resolveShortcut, type ShortcutAction } from "../lib/teleprompter-shortcuts"
import { useTeleprompterStore } from "../teleprompter-store"

interface UseTeleprompterShortcutsOptions {
  /** Replay-aware toggle supplied by the shell (restarts from the top at end). */
  onTogglePlay: () => void
}

function dispatchShortcut(action: ShortcutAction, togglePlay: () => void) {
  const store = useTeleprompterStore.getState()
  switch (action) {
    case "toggle-play":
      togglePlay()
      break
    case "speed-up":
      store.updateSettings({ wpm: store.settings.wpm + WPM_LIMIT.step })
      break
    case "speed-down":
      store.updateSettings({ wpm: store.settings.wpm - WPM_LIMIT.step })
      break
    case "size-up":
      store.updateSettings({ fontSize: store.settings.fontSize + FONT_SIZE_LIMIT.step })
      break
    case "size-down":
      store.updateSettings({ fontSize: store.settings.fontSize - FONT_SIZE_LIMIT.step })
      break
    case "restart":
      store.restart()
      break
    case "toggle-mirror":
      store.updateSettings({ mirror: !store.settings.mirror })
      break
    case "edit":
      store.setMode("edit")
      break
    case "escape":
      // Never closes the window: pause playback, or leave the editor for the
      // prompter when a script is present.
      if (store.playing) {
        store.pause()
      } else if (store.mode === "edit" && store.notes.trim() !== "") {
        store.setMode("prompt")
      }
      break
    case "start":
      store.play()
      break
  }
}

/** One window-level keydown listener resolving keys through the pure mapper. */
export function useTeleprompterShortcuts({ onTogglePlay }: UseTeleprompterShortcutsOptions) {
  const onTogglePlayRef = useRef(onTogglePlay)
  onTogglePlayRef.current = onTogglePlay

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const action = resolveShortcut(
        {
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          repeat: event.repeat,
          defaultPrevented: event.defaultPrevented,
        },
        target
          ? {
              tagName: target.tagName,
              isContentEditable: target instanceof HTMLElement ? target.isContentEditable : false,
              role: target.getAttribute("role"),
            }
          : null,
        useTeleprompterStore.getState().mode,
      )
      if (!action) return
      event.preventDefault()
      dispatchShortcut(action, () => onTogglePlayRef.current())
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])
}
