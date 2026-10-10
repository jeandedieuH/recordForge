import { useCallback, useEffect, useLayoutEffect, useRef } from "react"
import {
  advanceScrollPosition,
  adoptUserScroll,
  clamp,
  END_EPSILON_PX,
} from "../lib/teleprompter-math"
import { useTeleprompterStore } from "../teleprompter-store"

/** Throttled (~4 Hz) scroll state pushed to the shell for the progress bar,
 *  remaining-time label, and end-of-script affordances. */
export interface PrompterScrollInfo {
  position: number
  maxScroll: number
  progress: number
  atEnd: boolean
}

const PROGRESS_EMIT_MS = 250

interface UseAutoScrollOptions {
  viewportEl: HTMLElement | null
  playing: boolean
  pxPerSecond: number
  restartToken: number
  /** Changes when the scrollable range may shift (font size, wrap width,
   *  viewport height); triggers re-applying the preserved scroll ratio. */
  relayoutKey: string
  onProgress: (info: PrompterScrollInfo) => void
}

interface AutoScrollHandle {
  seekTo: (position: number) => void
}

/**
 * rAF-driven prompter scroller. The authoritative position is a float ref —
 * browsers quantize `scrollTop`, so accumulating there would stall slow speeds.
 * React state is only updated via the throttled `onProgress` callback.
 */
export function useAutoScroll({
  viewportEl,
  playing,
  pxPerSecond,
  restartToken,
  relayoutKey,
  onProgress,
}: UseAutoScrollOptions): AutoScrollHandle {
  const positionRef = useRef(0)
  const lastTopRef = useRef(0)
  const lastMaxScrollRef = useRef(0)
  const lastEmitRef = useRef(0)
  const pxPerSecondRef = useRef(pxPerSecond)
  const onProgressRef = useRef(onProgress)

  pxPerSecondRef.current = pxPerSecond
  onProgressRef.current = onProgress

  const emit = useCallback((el: HTMLElement | null, force = false) => {
    const now = performance.now()
    if (!force && now - lastEmitRef.current < PROGRESS_EMIT_MS) return
    lastEmitRef.current = now
    const maxScroll = el ? Math.max(0, el.scrollHeight - el.clientHeight) : 0
    const position = positionRef.current
    // Remaining time is intentionally NOT pushed here — it is derived at render
    // time from the live wpm so speed changes while paused update immediately.
    onProgressRef.current({
      position,
      maxScroll,
      progress: maxScroll > 0 ? clamp(position / maxScroll, 0, 1) : 0,
      atEnd: maxScroll > 0 && position >= maxScroll - END_EPSILON_PX,
    })
  }, [])

  const writeScrollTop = useCallback((el: HTMLElement, top: number) => {
    el.scrollTop = top
    // Track our own writes so the scroll listener never adopts them as user input.
    lastTopRef.current = el.scrollTop
  }, [])

  // Playback loop. Depends only on `playing`/element identity so speed or
  // layout changes never interrupt the frame cadence.
  useEffect(() => {
    if (!playing || !viewportEl) return
    const el = viewportEl
    let last = performance.now()
    let rafId = 0

    const tick = (now: number) => {
      const deltaMs = now - last
      last = now
      const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight)
      const result = advanceScrollPosition({
        position: positionRef.current,
        pxPerSecond: pxPerSecondRef.current,
        deltaMs,
        maxScroll,
      })
      positionRef.current = result.position
      writeScrollTop(el, result.position)
      emit(el, result.reachedEnd)
      if (result.reachedEnd) {
        useTeleprompterStore.getState().pause()
        return
      }
      rafId = requestAnimationFrame(tick)
    }

    emit(el, true)
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [playing, viewportEl, emit, writeScrollTop])

  // Adopt manual scrolling (wheel, keys, scrollbar drag) into the accumulator —
  // scroll events dispatch before rAF callbacks in the same frame, so a wheel
  // tick is always adopted before the next write and never snaps back.
  useEffect(() => {
    if (!viewportEl) return
    const el = viewportEl
    const onScroll = () => {
      positionRef.current = adoptUserScroll({
        position: positionRef.current,
        lastTop: lastTopRef.current,
        currentTop: el.scrollTop,
      })
      lastTopRef.current = el.scrollTop
      emit(el)
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [viewportEl, emit])

  // Preserve the relative position across relayouts (font size, width) so the
  // speaker never loses their place. Also runs on mount, restoring `position`
  // onto a freshly (re)attached scroll container.
  useLayoutEffect(() => {
    if (!viewportEl) return
    const maxScroll = Math.max(0, viewportEl.scrollHeight - viewportEl.clientHeight)
    if (lastMaxScrollRef.current > 0 && maxScroll !== lastMaxScrollRef.current) {
      positionRef.current = clamp(
        positionRef.current * (maxScroll / lastMaxScrollRef.current),
        0,
        maxScroll,
      )
    }
    writeScrollTop(viewportEl, positionRef.current)
    lastMaxScrollRef.current = maxScroll
    emit(viewportEl, true)
  }, [viewportEl, relayoutKey, emit, writeScrollTop])

  // Restart: pause + jump to the top, handled exactly once per token bump —
  // later viewport remounts (Edit<->Prompt toggle) must not reset the position.
  // With no viewport mounted (edit mode), still reset the accumulator and drop
  // the stale range so re-entering prompt mode starts at the top.
  const handledRestartRef = useRef(restartToken)
  useEffect(() => {
    if (restartToken === handledRestartRef.current) return
    handledRestartRef.current = restartToken
    positionRef.current = 0
    if (viewportEl) {
      writeScrollTop(viewportEl, 0)
    } else {
      lastTopRef.current = 0
      lastMaxScrollRef.current = 0
    }
    emit(viewportEl, true)
  }, [restartToken, viewportEl, emit, writeScrollTop])

  const seekTo = useCallback(
    (position: number) => {
      positionRef.current = Math.max(0, position)
      if (viewportEl) writeScrollTop(viewportEl, positionRef.current)
      emit(viewportEl, true)
    },
    [viewportEl, emit, writeScrollTop],
  )

  return { seekTo }
}
