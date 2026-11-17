import { describe, expect, it } from "vitest"
import {
  cameraFrameSchema,
  timelineStateSchema,
  type CameraClip,
  type CameraPlacementPreset,
  type ClipTransform,
} from "@recordforge/contracts"
import { defaultCursorSettings, type TimelineState } from "@recordforge/domain"
import { buildCameraPresetTransform } from "./camera-presets"
import {
  normalizeCameraFrames,
  reconcileCameraFramesForCanvas,
  syncCameraTransform,
  updateCameraClipTransform,
} from "./camera-frame-state"
import { getCameraFrame, resolveCameraFrame } from "./camera-frame"
import {
  createApplyCameraPresetCommand,
  createEngine,
  createUpdateCameraFrameCommand,
  createUpdateClipTransformCommand,
  executeCommand,
  redoCommand,
  undoCommand,
} from "./index"

const now = "2026-09-14T00:00:00.000Z"

function makeCameraClip(overrides?: Partial<ClipTransform>): CameraClip {
  return {
    id: "camera-clip",
    kind: "camera",
    assetId: "recording",
    streamIndex: 1,
    startMs: 0,
    durationMs: 10_000,
    sourceInMs: 0,
    sourceOutMs: 10_000,
    speed: 1,
    transform: {
      // vertical-pip preset geometry on a 1920x1080 canvas, 1280x720 webcam.
      x: 1656,
      y: 720,
      width: 240,
      height: 336,
      crop: { x: 383, y: 0, width: 514, height: 720 },
      opacity: 1,
      shape: "rectangle",
      visible: true,
      preset: "vertical-pip",
      locked: false,
      ...overrides,
    },
  }
}

function makeState(clip: CameraClip = makeCameraClip()): TimelineState {
  return {
    version: 1,
    id: "frame-state-project",
    name: "Frame State",
    recordingId: "recording",
    canvas: {
      width: 1920,
      height: 1080,
      fps: 30,
      background: "#000000",
      padding: 96,
      borderRadius: 0,
      shadow: false,
      aspectRatio: "16:9",
      cursorSettings: defaultCursorSettings,
    },
    tracks: [
      {
        id: "camera",
        kind: "camera",
        name: "Camera",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [clip],
      },
    ],
    markers: [],
    zoomSegments: [],
    createdAt: now,
    updatedAt: now,
  }
}

function cameraClipOf(state: TimelineState): CameraClip {
  const clip = state.tracks.flatMap((track) => track.clips).find((c) => c.kind === "camera")
  if (!clip || clip.kind !== "camera") throw new Error("camera clip missing")
  return clip
}

function expectNear(actual: number, expected: number, tolerance = 1) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance)
}

function expectTransformNear(actual: ClipTransform, expected: ClipTransform) {
  expectNear(actual.x, expected.x)
  expectNear(actual.y, expected.y)
  expectNear(actual.width, expected.width)
  expectNear(actual.height, expected.height)
}

describe("normalizeCameraFrames", () => {
  it.each(["camera-only", "vertical-pip", "circle-pip", "side-by-side"] as const)(
    "migrates a %s transform to a frame and mirrors within 1px",
    (preset: CameraPlacementPreset) => {
      const canvas = makeState().canvas
      const transform = buildCameraPresetTransform(preset, {
        canvas,
        source: { width: 1280, height: 720 },
      })
      const state = makeState(makeCameraClip(transform))
      const normalized = normalizeCameraFrames(state)
      const clip = cameraClipOf(normalized)

      expect(clip.frame).toBeDefined()
      expect(clip.frame?.placement.origin).toBe("auto")
      expect(clip.frame?.preset).toBe(preset)
      expectTransformNear(clip.transform, transform)
    },
  )

  it("pins a manual transform and mirrors back the same rect", () => {
    const original = {
      ...makeCameraClip().transform,
      x: 500,
      y: 300,
      width: 320,
      height: 200,
      preset: undefined,
    }
    const state = makeState(makeCameraClip(original))
    const clip = cameraClipOf(normalizeCameraFrames(state))

    expect(clip.frame?.placement.origin).toBe("pinned")
    expectTransformNear(clip.transform, original)
  })

  it("is idempotent and referentially stable", () => {
    const state = makeState()
    const once = normalizeCameraFrames(state)
    expect(once).not.toBe(state)
    expect(normalizeCameraFrames(once)).toBe(once)
  })

  it("leaves a state without camera clips untouched", () => {
    const state = makeState()
    state.tracks = []
    expect(normalizeCameraFrames(state)).toBe(state)
  })

  it("survives a JSON round-trip through the timeline schema", () => {
    const normalized = normalizeCameraFrames(makeState())
    const roundTripped = timelineStateSchema.parse(
      JSON.parse(JSON.stringify(normalized)),
    ) as TimelineState
    const clip = cameraClipOf(roundTripped)
    expect(clip.frame).toEqual(cameraClipOf(normalized).frame)
    expect(normalizeCameraFrames(roundTripped)).toBe(roundTripped)
  })

  it("lets an older reader resolve the same rect from the mirrored transform alone", () => {
    const normalized = normalizeCameraFrames(makeState())
    const clip = cameraClipOf(normalized)
    const stripped: CameraClip = { ...clip }
    delete stripped.frame

    const canvas = { width: 1920, height: 1080, padding: 96, aspectRatio: "16:9" as const }
    const fromFrame = resolveCameraFrame({ frame: clip.frame!, canvas })
    const fromTransform = resolveCameraFrame({
      frame: getCameraFrame(stripped, canvas),
      canvas,
    })
    expectNear(fromTransform.rect.x, fromFrame.rect.x)
    expectNear(fromTransform.rect.y, fromFrame.rect.y)
    expectNear(fromTransform.rect.width, fromFrame.rect.width)
    expectNear(fromTransform.rect.height, fromFrame.rect.height)
  })
})

describe("reconcileCameraFramesForCanvas", () => {
  it("keeps a pinned camera's fractions across 16:9 -> 9:16 -> 1:1", () => {
    let state = normalizeCameraFrames(
      makeState(makeCameraClip({ x: 40, y: 40, preset: undefined })),
    )
    const pinned = cameraClipOf(state).frame
    expect(pinned?.placement.origin).toBe("pinned")

    for (const [width, height, aspectRatio] of [
      [1080, 1920, "9:16"],
      [1080, 1080, "1:1"],
    ] as const) {
      const previousCanvas = state.canvas
      const next = {
        ...state,
        canvas: { ...state.canvas, width, height, aspectRatio },
      }
      state = reconcileCameraFramesForCanvas(next, previousCanvas)
      const clip = cameraClipOf(state)
      expect(clip.frame?.placement.align).toEqual(pinned?.placement.align)
      expect(clip.frame?.placement.size).toBe(pinned?.placement.size)
      expect(clip.transform.x).toBeGreaterThanOrEqual(0)
      expect(clip.transform.y).toBeGreaterThanOrEqual(0)
      expect(clip.transform.x + clip.transform.width).toBeLessThanOrEqual(width)
      expect(clip.transform.y + clip.transform.height).toBeLessThanOrEqual(height)
    }
  })

  it("rebuilds auto frames for the new ratio and keeps a customised border", () => {
    const state = normalizeCameraFrames(makeState(makeCameraClip({ borderWidth: 12 })))
    const previousCanvas = state.canvas
    const next = {
      ...state,
      canvas: { ...state.canvas, width: 1080, height: 1920, aspectRatio: "9:16" as const },
    }
    const reconciled = reconcileCameraFramesForCanvas(next, previousCanvas)
    const clip = cameraClipOf(reconciled)

    expect(clip.frame?.preset).toBe("circle-pip")
    expect(clip.frame?.placement.origin).toBe("auto")
    expect(clip.frame?.style.borderWidth).toBeCloseTo(12, 5)
    expect(clip.transform.shape).toBe("circle")
  })

  it("takes the new preset's default style when the style was untouched", () => {
    const canvas = makeState().canvas
    const transform = buildCameraPresetTransform("camera-only", {
      canvas,
      source: { width: 1280, height: 720 },
    })
    const state = normalizeCameraFrames(makeState(makeCameraClip(transform)))
    const clipBefore = cameraClipOf(state)
    expect(clipBefore.frame?.style.borderWidth).toBe(0)

    const next = {
      ...state,
      canvas: { ...state.canvas, width: 1080, height: 1080, aspectRatio: "1:1" as const },
    }
    const clip = cameraClipOf(reconcileCameraFramesForCanvas(next, state.canvas))
    // camera-only's default style (no ring/shadow) yields to circle-pip's.
    expect(clip.frame?.preset).toBe("circle-pip")
    expect(clip.frame?.style.borderWidth).toBe(2)
    expect(clip.frame?.style.shadowEnabled).toBe(true)
  })

  it("re-resolves content-anchored frames on a padding change", () => {
    const frame = cameraFrameSchema.parse({
      placement: {
        mode: "overlay",
        anchorTo: "content",
        align: { x: 0, y: 0 },
        margin: 0,
        size: 0.3,
        origin: "pinned",
      },
    })
    const clip = syncCameraTransform({ ...makeCameraClip(), frame }, makeState().canvas)
    const state = makeState(clip)
    expect(cameraClipOf(state).transform.x).toBe(96) // content starts at padding

    const next = { ...state, canvas: { ...state.canvas, padding: 200 } }
    const reconciled = reconcileCameraFramesForCanvas(next, state.canvas)
    expect(cameraClipOf(reconciled).transform.x).toBe(200)
  })
})

describe("camera frame commands", () => {
  it("update-camera-frame merges a patch, pins placement and mirrors", () => {
    const engine = createEngine(makeState())
    const result = executeCommand(
      engine,
      createUpdateCameraFrameCommand("camera-clip", { placement: { size: 0.5 } }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const clip = cameraClipOf(result.value.history.present)
    expect(clip.frame?.placement.size).toBe(0.5)
    expect(clip.frame?.placement.origin).toBe("pinned")
    expect(clip.frame?.preset).toBeUndefined()
    expect(clip.transform.height).toBe(Math.round(0.5 * 1080))
  })

  it("keeps auto origin when the patch only touches style", () => {
    const engine = createEngine(makeState())
    const result = executeCommand(
      engine,
      createUpdateCameraFrameCommand("camera-clip", { style: { borderColor: "#ff0000" } }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const clip = cameraClipOf(result.value.history.present)
    expect(clip.frame?.placement.origin).toBe("auto")
    expect(clip.frame?.preset).toBe("vertical-pip")
    expect(clip.transform.borderColor).toBe("#ff0000")
    expect(clip.transform.borderWidth).toBe(2)
  })

  it("coalesces consecutive patches into one undo step like transform edits", () => {
    const engine = createEngine(makeState())
    const first = executeCommand(
      engine,
      createUpdateCameraFrameCommand("camera-clip", { placement: { size: 0.4 } }),
    )
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = executeCommand(
      first.value,
      createUpdateCameraFrameCommand("camera-clip", { placement: { size: 0.5 } }),
    )
    expect(second.ok).toBe(true)
    if (!second.ok) return

    const undone = undoCommand(second.value)
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    // One undo restores the pre-gesture frame, not the intermediate patch.
    expect(cameraClipOf(undone.value.history.present).frame?.placement.size).toBeCloseTo(0.3111, 3)
    const redone = redoCommand(undone.value)
    expect(redone.ok).toBe(true)
    if (!redone.ok) return
    expect(cameraClipOf(redone.value.history.present).frame?.placement.size).toBe(0.5)
  })

  it("apply-camera-preset rebuilds the frame and keeps framing and visibility", () => {
    const clip = makeCameraClip({ visible: false })
    const engine = createEngine(makeState(clip))
    const withFraming = executeCommand(
      engine,
      createUpdateCameraFrameCommand("camera-clip", { framing: { zoom: 1.5 } }),
    )
    expect(withFraming.ok).toBe(true)
    if (!withFraming.ok) return

    const result = executeCommand(
      withFraming.value,
      createApplyCameraPresetCommand("camera-clip", "circle-pip"),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const next = cameraClipOf(result.value.history.present)
    expect(next.frame?.preset).toBe("circle-pip")
    expect(next.frame?.placement.origin).toBe("auto")
    expect(next.frame?.framing.zoom).toBe(1.5)
    expect(next.frame?.visible).toBe(false)
    expect(next.transform.visible).toBe(false)
    expect(next.transform.shape).toBe("circle")
  })

  it("legacy update-clip-transform still applies and derives a frame", () => {
    const engine = createEngine(makeState())
    const dragged: ClipTransform = {
      ...makeCameraClip().transform,
      x: 100,
      y: 50,
      preset: undefined,
    }
    const result = executeCommand(engine, createUpdateClipTransformCommand("camera-clip", dragged))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const clip = cameraClipOf(result.value.history.present)
    expect(clip.frame?.placement.origin).toBe("pinned")
    expectTransformNear(clip.transform, dragged)
    // Framing from the dragged crop survives in the frame.
    expect(clip.frame?.framing.zoom).toBeGreaterThanOrEqual(1)
  })

  it("keeps the existing frame's cornerRadius through a legacy transform write", () => {
    const clip = makeCameraClip()
    clip.frame = cameraFrameSchema.parse({ cornerRadius: 0.3 })
    const engine = createEngine(makeState(clip))
    const dragged: ClipTransform = { ...clip.transform, x: 10 }
    const result = executeCommand(engine, createUpdateClipTransformCommand("camera-clip", dragged))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(cameraClipOf(result.value.history.present).frame?.cornerRadius).toBe(0.3)
  })
})

describe("updateCameraClipTransform", () => {
  it("keeps the prior crop when the mirror cannot express one", () => {
    const clip = makeCameraClip({ crop: { x: 10, y: 20, width: 400, height: 300 } })
    const withFrame = cameraFrameSchema.parse({})
    const state = updateCameraClipTransform(
      { ...clip, frame: withFrame },
      { ...clip.transform, x: 5 },
      { width: 1920, height: 1080, padding: 96, aspectRatio: "16:9" },
    )
    expect(state.transform.crop).toEqual({ x: 10, y: 20, width: 400, height: 300 })
  })
})
