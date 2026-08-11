import { useEffect, useState } from "react"

const NARROW_BREAKPOINT = 1024

export function useNarrowViewport(breakpoint = NARROW_BREAKPOINT) {
  const [isNarrow, setIsNarrow] = useState(() => {
    if (typeof window === "undefined") return false
    return window.innerWidth < breakpoint
  })

  useEffect(() => {
    if (typeof window === "undefined") return

    const mediaQuery = window.matchMedia(`(max-width: ${breakpoint - 1}px)`)
    setIsNarrow(mediaQuery.matches)

    const listener = (event: MediaQueryListEvent) => setIsNarrow(event.matches)
    mediaQuery.addEventListener("change", listener)
    return () => mediaQuery.removeEventListener("change", listener)
  }, [breakpoint])

  return isNarrow
}
