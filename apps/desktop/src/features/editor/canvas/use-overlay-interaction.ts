import { useCallback, useEffect, useRef, useState } from "react"
import type { PointerEvent, RefObject } from "react"
import type {
  OverlayClip,
  OverlayClipUpdate,
  OverlayGestureDraft,
  OverlayHandle,
  OverlayResizeHandle,
  InteractionTransaction,
} from "@recordforge/editor-core"
import {
  createOverlayTransaction,
  constrainOverlayTransform,
  moveOverlayTransform,
  overlayMinimumSize,
  overlayTransformFromClip,
  resizeOverlayTransform,
  rotateOverlayTransform,
  snapOverlayPoint,
} from "@recordforge/editor-core"
import type { OverlayTransform } from "@recordforge/contracts"
import { useTimelineStore } from "../../../stores/timeline-store"
import { usePlayheadMs } from "../timeline/use-playback-state"

export interface OverlayInteractionOptions {
  canvasRef: RefObject<HTMLElement | null>
  canvasWidth: number
  canvasHeight: number
}

export interface OverlayPointerState {
  clipId: string
  pointerId: number
  handle: OverlayHandle
  startClient: { x: number; y: number }
  startCanvas: { x: number; y: number }
  startTransform: OverlayTransform
  startArrow?: {
    start: { x: number; y: number }
    end: { x: number; y: number }
  }
  mode: "drag-threshold" | "active"
  moved: boolean
  captureTarget: Element
}

export interface OverlayInteraction {
  readonly isRotateMode: boolean
  beginGesture: (event: PointerEvent<Element>, clip: OverlayClip, handle: OverlayHandle) => void
  moveGesture: (event: PointerEvent<Element>) => void
  finishGesture: (event: PointerEvent<Element>) => void
  handleLostPointerCapture: (event: PointerEvent<Element>) => void
  updateClip: (
    clipId: string,
    update: OverlayClipUpdate,
    options?: { phase?: "draft" | "commit" | "cancel" },
  ) => void
  nudgeSelected: (clipId: string, deltaX: number, deltaY: number) => void
  resizeSelected: (clipId: string, deltaWidth: number, deltaHeight: number) => void
  rotateSelected: (clipId: string, deltaDegrees: number) => void
  startRotateMode: (clipId: string) => void
  finishRotateMode: () => void
  cancel: () => void
}

interface PointerSnapshot {
  pointerId: number
  clientX: number
  clientY: number
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}

interface PointerDraftResult {
  draft: OverlayGestureDraft
  distance: number
}

function isActive(clip: OverlayClip, playheadMs: number): boolean {
  return (
    clip.enabled !== false &&
    playheadMs >= clip.startMs &&
    playheadMs < clip.startMs + clip.durationMs
  )
}

function isArrowClip(clip: OverlayClip): clip is Extract<OverlayClip, { kind: "annotation" }> {
  return (
    clip.kind === "annotation" &&
    (clip.annotationType === "arrow" || clip.annotationType === "line")
  )
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function pointerSnapshot(event: PointerEvent<Element>): PointerSnapshot {
  return {
    pointerId: event.pointerId,
    clientX: event.clientX,
    clientY: event.clientY,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
  }
}

function isResizeHandle(handle: OverlayHandle): handle is OverlayResizeHandle {
  return (
    handle !== "body" && handle !== "rotate" && handle !== "arrow-start" && handle !== "arrow-end"
  )
}

function gestureKind(handle: OverlayHandle): OverlayGestureDraft["kind"] {
  if (handle === "body") return "move"
  if (handle === "rotate") return "rotate"
  if (handle === "arrow-start") return "arrow-start"
  if (handle === "arrow-end") return "arrow-end"
  return "resize"
}

function getPointerTarget(event: PointerEvent<Element>): Element {
  return event.currentTarget
}

interface PointerCaptureTarget extends Element {
  hasPointerCapture(pointerId: number): boolean
  releasePointerCapture(pointerId: number): void
  setPointerCapture(pointerId: number): void
}

function isPointerCaptureTarget(target: Element): target is PointerCaptureTarget {
  return (
    typeof target.hasPointerCapture === "function" &&
    typeof target.releasePointerCapture === "function" &&
    typeof target.setPointerCapture === "function"
  )
}

function getPointerCaptureTarget(target: Element): PointerCaptureTarget | null {
  return isPointerCaptureTarget(target) ? target : null
}

function setPointerCapture(target: Element, pointerId: number): void {
  getPointerCaptureTarget(target)?.setPointerCapture(pointerId)
}

function releasePointerCapture(target: Element, pointerId: number): void {
  const captureTarget = getPointerCaptureTarget(target)
  if (captureTarget?.hasPointerCapture(pointerId)) captureTarget.releasePointerCapture(pointerId)
}

export function useOverlayInteraction({
  canvasRef,
  canvasWidth,
  canvasHeight,
}: OverlayInteractionOptions): OverlayInteraction {
  const playheadMs = usePlayheadMs()
  const dimensionsRef = useRef({ canvasWidth, canvasHeight })
  dimensionsRef.current = { canvasWidth, canvasHeight }
  const playheadRef = useRef(playheadMs)
  playheadRef.current = playheadMs

  const transactionRef = useRef<InteractionTransaction<OverlayGestureDraft> | null>(null)
  const gestureRef = useRef<OverlayPointerState | null>(null)
  const pendingPointerRef = useRef<PointerSnapshot | null>(null)
  const frameRef = useRef<number | null>(null)
  const frameUsesTimeoutRef = useRef(false)
  const [rotateModeClipId, setRotateModeClipId] = useState<string | null>(null)

  const getBase = useCallback(() => useTimelineStore.getState().engine?.history.present ?? null, [])

  const clearFrame = useCallback(() => {
    if (frameRef.current === null || typeof window === "undefined") return
    if (frameUsesTimeoutRef.current) window.clearTimeout(frameRef.current)
    else window.cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    frameUsesTimeoutRef.current = false
  }, [])

  const clearTransaction = useCallback(() => {
    transactionRef.current?.cancel()
    transactionRef.current = null
    useTimelineStore.getState().clearDraft()
  }, [])

  const cancel = useCallback(() => {
    clearFrame()
    pendingPointerRef.current = null
    gestureRef.current = null
    clearTransaction()
    setRotateModeClipId(null)
  }, [clearFrame, clearTransaction])

  const getCanvasPoint = useCallback(
    (clientX: number, clientY: number) => {
      const rect = canvasRef.current?.getBoundingClientRect()
      const { canvasWidth: width, canvasHeight: height } = dimensionsRef.current
      if (!rect) return { x: 0, y: 0 }
      return {
        x: ((clientX - rect.left) / Math.max(1, rect.width)) * width,
        y: ((clientY - rect.top) / Math.max(1, rect.height)) * height,
      }
    },
    [canvasRef],
  )

  const setDraftPreview = useCallback(() => {
    const preview = transactionRef.current?.preview
    if (!preview) return
    useTimelineStore.getState().setDraftTimeline(preview.state, preview.error)
  }, [])

  const commitTransaction = useCallback(() => {
    const transaction = transactionRef.current
    if (!transaction) return
    const latestBase = getBase()
    if (latestBase) transaction.rebase(latestBase)
    const result = transaction.commit()
    if (result.ok) {
      useTimelineStore.getState().execute(result.value.command)
    } else {
      transaction.cancel()
      useTimelineStore.getState().setError(result.error.message)
    }
    transactionRef.current = null
    useTimelineStore.getState().clearDraft()
  }, [getBase])

  const beginTransaction = useCallback(
    (draft: OverlayGestureDraft) => {
      const base = getBase()
      if (!base) return false
      clearTransaction()
      const transaction = createOverlayTransaction()
      transaction.begin(base, draft)
      transactionRef.current = transaction
      setDraftPreview()
      return true
    },
    [clearTransaction, getBase, setDraftPreview],
  )

  const buildPointerDraft = useCallback(
    (gesture: OverlayPointerState, snapshot: PointerSnapshot): PointerDraftResult => {
      const { canvasWidth: width, canvasHeight: height } = dimensionsRef.current
      const current = getCanvasPoint(snapshot.clientX, snapshot.clientY)
      const deltaX = current.x - gesture.startCanvas.x
      const deltaY = current.y - gesture.startCanvas.y
      const distance = Math.hypot(deltaX, deltaY)
      const snapDisabled = snapshot.ctrlKey || snapshot.metaKey
      let transform = gesture.startTransform
      let endX = gesture.startArrow?.end.x
      let endY = gesture.startArrow?.end.y

      if (gesture.handle === "body") {
        const constrainedDelta = snapshot.shiftKey
          ? Math.abs(deltaX) >= Math.abs(deltaY)
            ? { x: deltaX, y: 0 }
            : { x: 0, y: deltaY }
          : { x: deltaX, y: deltaY }
        transform = moveOverlayTransform(
          gesture.startTransform,
          constrainedDelta.x,
          constrainedDelta.y,
          {
            canvasWidth: width,
            canvasHeight: height,
            snapDisabled,
          },
        )
        if (gesture.startArrow) {
          const appliedX = transform.x - gesture.startTransform.x
          const appliedY = transform.y - gesture.startTransform.y
          endX = gesture.startArrow.end.x + appliedX
          endY = gesture.startArrow.end.y + appliedY
        }
      } else if (isResizeHandle(gesture.handle)) {
        const clip = getOverlayClip(gesture.clipId)
        const minimumSize = clip ? overlayMinimumSize(clip) : { width: 20, height: 20 }
        transform = resizeOverlayTransform(gesture.startTransform, gesture.handle, deltaX, deltaY, {
          minWidth: minimumSize.width,
          minHeight: minimumSize.height,
          preserveAspectRatio: snapshot.shiftKey,
          fromCenter: snapshot.altKey,
        })
        transform = constrainOverlayTransform(transform, width, height)
      } else if (gesture.handle === "rotate") {
        transform = rotateOverlayTransform(
          gesture.startTransform,
          gesture.startCanvas,
          current,
          snapshot.shiftKey ? 15 : 0,
        )
      } else if (gesture.handle === "arrow-start" && gesture.startArrow) {
        const point = snapOverlayPoint(
          {
            x: gesture.startArrow.start.x + deltaX,
            y: gesture.startArrow.start.y + deltaY,
          },
          { disabled: snapDisabled },
        )
        transform = {
          ...gesture.startTransform,
          x: clamp(point.x, 0, width),
          y: clamp(point.y, 0, height),
        }
      } else if (gesture.handle === "arrow-end" && gesture.startArrow) {
        const point = snapOverlayPoint(
          {
            x: gesture.startArrow.end.x + deltaX,
            y: gesture.startArrow.end.y + deltaY,
          },
          { disabled: snapDisabled },
        )
        endX = clamp(point.x, 0, width)
        endY = clamp(point.y, 0, height)
      }

      return {
        distance,
        draft: {
          kind: gestureKind(gesture.handle),
          clipId: gesture.clipId,
          transform,
          endX,
          endY,
        },
      }
    },
    [getCanvasPoint],
  )

  const applyPointerSnapshot = useCallback(
    (snapshot: PointerSnapshot) => {
      const gesture = gestureRef.current
      const transaction = transactionRef.current
      if (!gesture || !transaction || snapshot.pointerId !== gesture.pointerId) {
        return false
      }
      const result = buildPointerDraft(gesture, snapshot)
      if (!gesture.moved && result.distance < 2) return false
      gesture.mode = "active"
      gesture.moved = true
      transaction.update(result.draft)
      setDraftPreview()
      return true
    },
    [buildPointerDraft, setDraftPreview],
  )

  const beginGesture = useCallback(
    (event: PointerEvent<Element>, clip: OverlayClip, handle: OverlayHandle) => {
      if (event.button !== 0 || !isActive(clip, playheadRef.current) || clip.locked) return
      event.preventDefault()
      event.stopPropagation()
      clearFrame()
      pendingPointerRef.current = null
      if (gestureRef.current || transactionRef.current) clearTransaction()

      const startCanvas = getCanvasPoint(event.clientX, event.clientY)
      const startArrow = isArrowClip(clip)
        ? {
            start: { x: clip.x, y: clip.y },
            end: { x: clip.endX ?? clip.x + clip.width, y: clip.endY ?? clip.y + clip.height },
          }
        : undefined
      const transform = overlayTransformFromClip(clip)
      const draft: OverlayGestureDraft = {
        kind: gestureKind(handle),
        clipId: clip.id,
        transform,
        endX: startArrow?.end.x,
        endY: startArrow?.end.y,
      }
      if (!beginTransaction(draft)) return

      const target = getPointerTarget(event)
      setPointerCapture(target, event.pointerId)
      gestureRef.current = {
        clipId: clip.id,
        pointerId: event.pointerId,
        handle,
        startClient: { x: event.clientX, y: event.clientY },
        startCanvas,
        startTransform: transform,
        startArrow,
        mode: "drag-threshold",
        moved: false,
        captureTarget: target,
      }
    },
    [beginTransaction, clearFrame, clearTransaction, getCanvasPoint],
  )

  const moveGesture = useCallback(
    (event: PointerEvent<Element>) => {
      const gesture = gestureRef.current
      if (!gesture || event.pointerId !== gesture.pointerId) return
      event.preventDefault()
      pendingPointerRef.current = pointerSnapshot(event)
      if (frameRef.current !== null || typeof window === "undefined") {
        if (typeof window === "undefined") applyPointerSnapshot(pendingPointerRef.current)
        return
      }
      const callback = () => {
        frameRef.current = null
        frameUsesTimeoutRef.current = false
        const pending = pendingPointerRef.current
        pendingPointerRef.current = null
        if (pending) applyPointerSnapshot(pending)
      }
      if (typeof window.requestAnimationFrame === "function") {
        frameRef.current = window.requestAnimationFrame(callback)
      } else {
        frameUsesTimeoutRef.current = true
        frameRef.current = window.setTimeout(callback, 16)
      }
    },
    [applyPointerSnapshot],
  )

  const finishGesture = useCallback(
    (event: PointerEvent<Element>) => {
      const gesture = gestureRef.current
      if (!gesture || event.pointerId !== gesture.pointerId) return
      clearFrame()
      const pending = pendingPointerRef.current
      pendingPointerRef.current = null
      if (pending && event.type !== "pointercancel") applyPointerSnapshot(pending)
      if (event.type !== "pointercancel" && event.type !== "lostpointercapture") {
        applyPointerSnapshot(pointerSnapshot(event))
      }
      const wasCancelled = event.type === "pointercancel" || event.type === "lostpointercapture"
      const didMove = gesture.moved
      gestureRef.current = null
      releasePointerCapture(gesture.captureTarget, event.pointerId)
      if (wasCancelled || !didMove) {
        clearTransaction()
        return
      }
      commitTransaction()
    },
    [applyPointerSnapshot, clearFrame, clearTransaction, commitTransaction],
  )

  const handleLostPointerCapture = useCallback(
    (event: PointerEvent<Element>) => {
      if (gestureRef.current) finishGesture(event)
    },
    [finishGesture],
  )

  const createDraftForUpdate = useCallback(
    (clipId: string, update: OverlayClipUpdate): OverlayGestureDraft | null => {
      const clip = getOverlayClip(clipId)
      if (!clip) return null
      const transform = overlayTransformFromClip(clip)
      transform.x = update.x ?? transform.x
      transform.y = update.y ?? transform.y
      transform.width = update.width ?? transform.width
      transform.height = update.height ?? transform.height
      transform.rotation = update.rotation ?? transform.rotation
      transform.anchorX = update.anchorX ?? transform.anchorX
      transform.anchorY = update.anchorY ?? transform.anchorY
      transform.zIndex = update.zIndex ?? transform.zIndex
      transform.opacity = update.opacity ?? transform.opacity
      return {
        kind: "text-edit",
        clipId,
        transform,
        endX:
          clip.kind === "annotation"
            ? "endX" in update
              ? (update.endX ?? clip.endX)
              : clip.endX
            : undefined,
        endY:
          clip.kind === "annotation"
            ? "endY" in update
              ? (update.endY ?? clip.endY)
              : clip.endY
            : undefined,
        update,
      }
    },
    [],
  )

  const updateClip = useCallback(
    (
      clipId: string,
      update: OverlayClipUpdate,
      options: { phase?: "draft" | "commit" | "cancel" } = {},
    ) => {
      if (options.phase === "cancel") {
        cancel()
        return
      }
      const draft = createDraftForUpdate(clipId, update)
      if (!draft) return
      if (options.phase === "draft") {
        const current = transactionRef.current
        if (!current || current.phase !== "drafting") beginTransaction(draft)
        else {
          current.update(draft)
          setDraftPreview()
        }
        return
      }
      if (!beginTransaction(draft)) return
      commitTransaction()
    },
    [beginTransaction, cancel, commitTransaction, createDraftForUpdate, setDraftPreview],
  )

  const commitTransformDraft = useCallback(
    (draft: OverlayGestureDraft) => {
      if (!beginTransaction(draft)) return
      commitTransaction()
    },
    [beginTransaction, commitTransaction],
  )

  const nudgeSelected = useCallback(
    (clipId: string, deltaX: number, deltaY: number) => {
      const clip = getOverlayClip(clipId)
      if (!clip) return
      const start = overlayTransformFromClip(clip)
      const next = moveOverlayTransform(start, deltaX, deltaY, {
        canvasWidth: dimensionsRef.current.canvasWidth,
        canvasHeight: dimensionsRef.current.canvasHeight,
        snapDisabled: true,
      })
      const appliedX = next.x - start.x
      const appliedY = next.y - start.y
      commitTransformDraft({
        kind: "move",
        clipId,
        transform: next,
        endX: isArrowClip(clip) ? (clip.endX ?? clip.x + clip.width) + appliedX : undefined,
        endY: isArrowClip(clip) ? (clip.endY ?? clip.y + clip.height) + appliedY : undefined,
      })
    },
    [commitTransformDraft],
  )

  const resizeSelected = useCallback(
    (clipId: string, deltaWidth: number, deltaHeight: number) => {
      const clip = getOverlayClip(clipId)
      if (!clip) return
      const start = overlayTransformFromClip(clip)
      const minimum = overlayMinimumSize(clip)
      const next = constrainOverlayTransform(
        resizeOverlayTransform(start, "se", deltaWidth, deltaHeight, {
          minWidth: minimum.width,
          minHeight: minimum.height,
        }),
        dimensionsRef.current.canvasWidth,
        dimensionsRef.current.canvasHeight,
      )
      commitTransformDraft({ kind: "resize", clipId, transform: next })
    },
    [commitTransformDraft],
  )

  const rotateSelected = useCallback(
    (clipId: string, deltaDegrees: number) => {
      const clip = getOverlayClip(clipId)
      if (!clip) return
      const transform = overlayTransformFromClip(clip)
      const rotation = ((((transform.rotation + deltaDegrees + 180) % 360) + 360) % 360) - 180
      commitTransformDraft({ kind: "rotate", clipId, transform: { ...transform, rotation } })
    },
    [commitTransformDraft],
  )

  const startRotateMode = useCallback((clipId: string) => {
    if (getOverlayClip(clipId)) setRotateModeClipId(clipId)
  }, [])

  const finishRotateMode = useCallback(() => setRotateModeClipId(null), [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      if (
        event.target instanceof HTMLElement &&
        ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)
      ) {
        return
      }
      cancel()
    }
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("blur", cancel)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("blur", cancel)
      clearFrame()
      transactionRef.current?.cancel()
      transactionRef.current = null
      useTimelineStore.getState().clearDraft()
    }
  }, [cancel, clearFrame])

  return {
    isRotateMode: rotateModeClipId !== null,
    beginGesture,
    moveGesture,
    finishGesture,
    handleLostPointerCapture,
    updateClip,
    nudgeSelected,
    resizeSelected,
    rotateSelected,
    startRotateMode,
    finishRotateMode,
    cancel,
  }
}

function getOverlayClip(clipId: string): OverlayClip | null {
  const timeline = useTimelineStore.getState().engine?.history.present
  if (!timeline) return null
  const found = timeline.tracks.flatMap((track) => track.clips).find((clip) => clip.id === clipId)
  if (!found || (found.kind !== "annotation" && found.kind !== "text" && found.kind !== "image")) {
    return null
  }
  return found
}
