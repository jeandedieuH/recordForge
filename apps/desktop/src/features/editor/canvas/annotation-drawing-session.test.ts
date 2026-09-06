import { describe, expect, it, vi } from "vitest"
import { getAnnotationShapePreset } from "@recordforge/editor-core"
import { createAnnotationDrawingSession } from "./annotation-drawing-session"

function setup() {
  let nextFrame = 0
  const frames = new Map<number, () => void>()
  const captures = new Set<number>()
  const requestFrame = vi.fn((callback: () => void) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  const cancelFrame = vi.fn((id: number) => {
    frames.delete(id)
  })
  const onInvalidate = vi.fn()
  const onCreateClip = vi.fn()
  const session = createAnnotationDrawingSession({
    requestFrame,
    cancelFrame,
    onInvalidate,
    onCreateClip,
  })
  const target = {
    setPointerCapture: vi.fn((id: number) => {
      captures.add(id)
    }),
    hasPointerCapture: (id: number) => captures.has(id),
    releasePointerCapture: vi.fn((id: number) => {
      captures.delete(id)
      session.cancel(id)
    }),
  }
  const input = {
    pointerId: 1,
    point: { x: 100, y: 100 },
    shiftKey: false,
    target,
    settings: {
      preset: getAnnotationShapePreset("arrow"),
      strokeColor: "red",
      strokeWidth: 8,
      strokeStyle: "dashed" as const,
    },
    startMs: 1000,
    bounds: { width: 1920, height: 1080 },
  }
  function flushFrame() {
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach((callback) => callback())
  }
  return {
    session,
    input,
    target,
    requestFrame,
    cancelFrame,
    onInvalidate,
    onCreateClip,
    captures,
    frames,
    flushFrame,
  }
}

const moved = { pointerId: 1, point: { x: 400, y: 300 }, shiftKey: false }

describe("annotation drawing session", () => {
  it("coalesces pointer movement into one frame with the latest geometry", () => {
    const { session, input, requestFrame, onInvalidate, flushFrame } = setup()
    expect(session.start(input)).toBe(true)
    for (let x = 110; x < 200; x++) session.move({ ...moved, point: { x, y: 100 } })
    expect(requestFrame).toHaveBeenCalledTimes(1)
    expect(onInvalidate).not.toHaveBeenCalled()
    expect(session.getPreview()).toMatchObject({ x: 100, y: 100, endX: 199, endY: 100, height: 1 })
    flushFrame()
    expect(onInvalidate).toHaveBeenCalledTimes(1)
    session.move(moved)
    expect(requestFrame).toHaveBeenCalledTimes(2)
  })

  it("commits once using pointer-up coordinates even before the pending frame", () => {
    const { session, input, target, frames, onCreateClip, onInvalidate } = setup()
    session.start(input)
    session.move(moved)
    session.finish({ ...moved, point: { x: 500, y: 100 } })
    session.finish(moved)
    expect(onCreateClip).toHaveBeenCalledTimes(1)
    expect(onCreateClip.mock.calls[0][0]).toMatchObject({
      x: 100,
      y: 100,
      endX: 500,
      endY: 100,
      width: 400,
      height: 1,
      startMs: 1000,
      strokeColor: "red",
      strokeWidth: 8,
      strokeStyle: "dashed",
    })
    expect(target.releasePointerCapture).toHaveBeenCalledWith(1)
    expect(frames.size).toBe(0)
    expect(session.getPreview()).toBeNull()
    expect(onInvalidate).toHaveBeenCalledTimes(1)
  })

  it.each(["pointercancel", "lostpointercapture", "Escape", "blur", "mode-change"])(
    "%s cancels instead of creating, and cancels pending frames",
    (reason) => {
      const { session, input, frames, captures, onCreateClip, onInvalidate, flushFrame } = setup()
      session.start(input)
      session.move(moved)
      if (reason === "lostpointercapture") captures.clear()
      session.cancel(reason === "pointercancel" || reason === "lostpointercapture" ? 1 : undefined)
      session.finish(moved)
      flushFrame()
      expect(session.isActive()).toBe(false)
      expect(session.getPreview()).toBeNull()
      expect(frames.size).toBe(0)
      expect(captures.size).toBe(0)
      expect(onCreateClip).not.toHaveBeenCalled()
      expect(onInvalidate).toHaveBeenCalledTimes(1)
    },
  )

  it("ignores other pointers throughout an active gesture", () => {
    const { session, input, onCreateClip } = setup()
    session.start(input)
    expect(session.start({ ...input, pointerId: 2 })).toBe(false)
    expect(session.move({ ...moved, pointerId: 2 })).toBe(false)
    session.finish({ ...moved, pointerId: 2 })
    session.cancel(2)
    expect(session.isActive()).toBe(true)
    expect(session.getPreview()).toBeNull()
    expect(onCreateClip).not.toHaveBeenCalled()
    session.finish(moved)
    expect(onCreateClip).toHaveBeenCalledTimes(1)
  })

  it("disposes captures and frames without rendering or committing after unmount", () => {
    const { session, input, frames, captures, onInvalidate, onCreateClip, flushFrame } = setup()
    session.start(input)
    session.move(moved)
    session.dispose()
    flushFrame()
    expect(frames.size).toBe(0)
    expect(captures.size).toBe(0)
    expect(onInvalidate).not.toHaveBeenCalled()
    expect(onCreateClip).not.toHaveBeenCalled()
  })

  it("does not start when pointer capture fails and does not create from a click", () => {
    const { session, input, target, onCreateClip } = setup()
    target.setPointerCapture.mockImplementationOnce(() => {
      throw new Error("inactive pointer")
    })
    expect(session.start(input)).toBe(false)
    expect(session.isActive()).toBe(false)
    session.start(input)
    session.finish(input)
    expect(onCreateClip).not.toHaveBeenCalled()
  })

  it("uses the latest Shift state for both preview and final geometry", () => {
    const { session, input, onCreateClip } = setup()
    session.start(input)
    session.move({ ...moved, point: { x: 400, y: 130 }, shiftKey: true })
    expect(session.getPreview()!.endY).toBe(100)
    session.finish({ ...moved, point: { x: 400, y: 130 }, shiftKey: false })
    expect(onCreateClip.mock.calls[0][0].endY).toBe(130)
  })
})
