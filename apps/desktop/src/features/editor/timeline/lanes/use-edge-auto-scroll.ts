import { useEffect, useMemo, useRef, type RefObject } from "react"
import { edgeScrollDelta } from "./timeline-gesture-math"

export interface EdgeAutoScroll {
  // Registers the latest pointer position + a callback re-applied each frame
  // the view actually scrolled (timeline time under a stationary pointer
  // changes as content scrolls, so the gesture must re-evaluate).
  track: (clientX: number, onFrame: () => void) => void
  stop: () => void
}

/**
 * Drives horizontal auto-scroll while a drag sits near the viewport edge.
 * The returned object is STABLE — safe to pass to memoized clips.
 */
export function useEdgeAutoScroll(scrollRef: RefObject<HTMLElement | null>): EdgeAutoScroll {
  const stateRef = useRef<{ clientX: number; onFrame: () => void } | null>(null)
  const rafRef = useRef(0)

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    },
    [],
  )

  return useMemo(() => {
    function frame() {
      const state = stateRef.current
      const element = scrollRef.current
      if (!state || !element) {
        rafRef.current = 0
        return
      }
      const bounds = element.getBoundingClientRect()
      const delta = edgeScrollDelta(state.clientX, bounds.left, bounds.right)
      if (delta === 0) {
        rafRef.current = 0
        return
      }
      const previous = element.scrollLeft
      element.scrollLeft += delta
      if (element.scrollLeft !== previous) {
        state.onFrame()
      }
      rafRef.current = requestAnimationFrame(frame)
    }

    return {
      track(clientX: number, onFrame: () => void) {
        stateRef.current = { clientX, onFrame }
        if (!rafRef.current) rafRef.current = requestAnimationFrame(frame)
      },
      stop() {
        stateRef.current = null
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current)
          rafRef.current = 0
        }
      },
    }
  }, [scrollRef])
}
