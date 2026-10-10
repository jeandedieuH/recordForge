import { useCallback, useEffect, useRef, useState } from "react"

const IDLE_HIDE_MS = 2500
/** Elements marked with this attribute keep the chrome pinned while focused. */
const CHROME_SELECTOR = "[data-teleprompter-chrome]"

interface UseChromeVisibilityOptions {
  playing: boolean
  /** Extra pin (e.g. the display-settings popover is open). */
  pinned: boolean
}

/**
 * Auto-hides the titlebar/dock while the script is scrolling: chrome fades out
 * when the pointer leaves the window or the user goes idle, and any activity —
 * or keyboard focus inside the chrome itself — brings it back. Layout space is
 * reserved by the caller (opacity-only fade), so nothing reflows.
 */
export function useChromeVisibility({ playing, pinned }: UseChromeVisibilityOptions): boolean {
  const [pointerInside, setPointerInside] = useState(true)
  const [idleExpired, setIdleExpired] = useState(false)
  const [chromeHasFocus, setChromeHasFocus] = useState(false)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const poke = useCallback(() => {
    setIdleExpired(false)
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    idleTimerRef.current = setTimeout(() => setIdleExpired(true), IDLE_HIDE_MS)
  }, [])

  useEffect(() => {
    const isInChrome = (el: EventTarget | null): boolean =>
      el instanceof Element && el.closest(CHROME_SELECTOR) !== null
    // Only keyboard focus pins the chrome — a mouse click leaves the button
    // focused, which would otherwise defeat auto-hide for pointer users.
    const isKeyboardFocus = (el: EventTarget | null): boolean =>
      isInChrome(el) && el instanceof HTMLElement && el.matches(":focus-visible")

    const onFocusIn = (event: FocusEvent) => {
      if (isKeyboardFocus(event.target)) setChromeHasFocus(true)
      poke()
    }
    const onFocusOut = (event: FocusEvent) => {
      if (isInChrome(event.target) && !isKeyboardFocus(event.relatedTarget)) {
        setChromeHasFocus(false)
      }
    }
    const onPointerIn = () => {
      setPointerInside(true)
      poke()
    }
    const onPointerOut = () => setPointerInside(false)

    window.addEventListener("pointermove", poke)
    window.addEventListener("keydown", poke)
    window.addEventListener("focusin", onFocusIn)
    window.addEventListener("focusout", onFocusOut)
    document.documentElement.addEventListener("mouseenter", onPointerIn)
    document.documentElement.addEventListener("mouseleave", onPointerOut)
    poke()

    return () => {
      window.removeEventListener("pointermove", poke)
      window.removeEventListener("keydown", poke)
      window.removeEventListener("focusin", onFocusIn)
      window.removeEventListener("focusout", onFocusOut)
      document.documentElement.removeEventListener("mouseenter", onPointerIn)
      document.documentElement.removeEventListener("mouseleave", onPointerOut)
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    }
  }, [poke])

  return !playing || pinned || chromeHasFocus || (pointerInside && !idleExpired)
}
