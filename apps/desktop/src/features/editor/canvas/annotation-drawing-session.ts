import type { AnnotationClip } from "@recordforge/contracts"
import type { AnnotationDrawSettings } from "../annotations/annotation-tools"
import {
  createAnnotationDrawingClip,
  getAnnotationDrawingGeometry,
  type AnnotationDrawingBounds,
  type AnnotationDrawingPoint,
} from "./annotation-drawing"

interface PointerCaptureTarget {
  setPointerCapture: (pointerId: number) => void
  hasPointerCapture: (pointerId: number) => boolean
  releasePointerCapture: (pointerId: number) => void
}

interface DrawingPointer {
  pointerId: number
  point: AnnotationDrawingPoint
  shiftKey: boolean
}

interface DrawingStart extends DrawingPointer {
  target: PointerCaptureTarget
  settings: AnnotationDrawSettings
  startMs: number
  bounds: AnnotationDrawingBounds
}

interface DrawingSessionOptions {
  requestFrame: (callback: () => void) => number
  cancelFrame: (id: number) => void
  onInvalidate: () => void
  onCreateClip: (clip: AnnotationClip) => void
}

interface DrawingDraft extends DrawingStart {
  clip: AnnotationClip
  current: AnnotationDrawingPoint
}

export function createAnnotationDrawingSession(options: DrawingSessionOptions) {
  let draft: DrawingDraft | null = null
  let frame: number | null = null

  function scheduleFrame() {
    if (frame !== null) return
    frame = options.requestFrame(() => {
      frame = null
      options.onInvalidate()
    })
  }

  function getPreview(): AnnotationClip | null {
    if (!draft) return null
    const geometry = getAnnotationDrawingGeometry(
      draft.clip.annotationType,
      draft.point,
      draft.current,
      draft.bounds,
      draft.shiftKey,
    )
    return geometry ? { ...draft.clip, ...geometry } : null
  }

  function reset(invalidate: boolean) {
    const previous = draft
    // Clear the session before releasing capture: lostpointercapture can arrive synchronously.
    draft = null
    if (frame !== null) options.cancelFrame(frame)
    frame = null
    if (previous?.target.hasPointerCapture(previous.pointerId)) {
      previous.target.releasePointerCapture(previous.pointerId)
    }
    if (invalidate && previous) options.onInvalidate()
  }

  return {
    getPreview,
    isActive: () => draft !== null,
    start(input: DrawingStart): boolean {
      if (draft) return false
      try {
        input.target.setPointerCapture(input.pointerId)
      } catch {
        return false
      }
      draft = {
        ...input,
        clip: createAnnotationDrawingClip(input.settings, input.startMs, input.bounds),
        current: input.point,
      }
      return true
    },
    move(input: DrawingPointer): boolean {
      if (!draft || draft.pointerId !== input.pointerId) return false
      draft.current = input.point
      draft.shiftKey = input.shiftKey
      scheduleFrame()
      return true
    },
    finish(input: DrawingPointer) {
      if (!draft || draft.pointerId !== input.pointerId) return
      draft.current = input.point
      draft.shiftKey = input.shiftKey
      const clip = getPreview()
      reset(true)
      if (clip) options.onCreateClip(clip)
    },
    cancel(pointerId?: number) {
      if (pointerId !== undefined && draft?.pointerId !== pointerId) return
      reset(true)
    },
    dispose() {
      reset(false)
    },
  }
}
