import { describe, expect, it } from "vitest"
import { defaultCursorSettings, type CameraClip, type TimelineState } from "@recordforge/domain"
import { buildCameraPresetTransform } from "./camera-presets"
import { createEngine, createUpdateCanvasCommand, executeCommand, undoCommand } from "./index"

const now = "2026-09-14T00:00:00.000Z"

function makeCameraClip(overrides?: Partial<CameraClip["transform"]>): CameraClip {
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
      // Geometry produced by the vertical-pip preset on a 1920×1080 canvas
      // fed by a 1280×720 webcam.
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

function makeState(withCamera = true): TimelineState {
  const tracks: TimelineState["tracks"] = [
    {
      id: "screen",
      kind: "screen",
      name: "Screen",
      muted: false,
      locked: false,
      solo: false,
      volume: 1,
      clips: [
        {
          id: "screen-clip",
          kind: "screen",
          assetId: "recording",
          startMs: 0,
          durationMs: 10_000,
          sourceInMs: 0,
          sourceOutMs: 10_000,
          speed: 1,
        },
      ],
    },
  ]
  if (withCamera) {
    tracks.push({
      id: "camera",
      kind: "camera",
      name: "Camera",
      muted: false,
      locked: false,
      solo: false,
      volume: 1,
      clips: [makeCameraClip()],
    })
  }
  return {
    version: 1,
    id: "smart-layout-project",
    name: "Smart Layout",
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
    tracks,
    markers: [],
    zoomSegments: [],
    createdAt: now,
    updatedAt: now,
  }
}

function cameraClipOf(state: TimelineState): CameraClip {
  const track = state.tracks.find((t) => t.kind === "camera")
  const clip = track?.clips.find((c) => c.kind === "camera")
  if (!clip || clip.kind !== "camera") throw new Error("camera clip missing")
  return clip
}

const CAMERA_SOURCES = { "camera-clip": { width: 1280, height: 720 } }

describe("smart per-ratio layout on aspect ratio switch", () => {
  it("applies the 9:16 default: 24px inset, centered video, 840px circle PiP", () => {
    const result = executeCommand(
      createEngine(makeState()),
      createUpdateCanvasCommand(
        { aspectRatio: "9:16", width: 1080, height: 1920 },
        { cameraSources: CAMERA_SOURCES },
      ),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const next = result.value.history.present
    expect(next.canvas).toMatchObject({
      aspectRatio: "9:16",
      width: 1080,
      height: 1920,
      padding: 24,
      borderRadius: 24,
      videoPositionY: 0.15,
    })

    const transform = cameraClipOf(next).transform
    expect(transform.preset).toBe("circle-pip")
    expect(transform.shape).toBe("circle")
    expect(transform.width).toBe(840)
    expect(transform.height).toBe(840)
    expect(transform.x).toBe(120) // centered on 1080
    expect(transform.y).toBe(950)
    expect(transform.crop).toEqual({ x: 280, y: 0, width: 720, height: 720 })
  })

  it.each([
    { ratio: "1:1" as const, w: 1080, h: 1080, dim: 460, x: 340, y: 665, posY: 0.05 },
    { ratio: "5:4" as const, w: 1350, h: 1080, dim: 350, x: 975, y: 715, posY: 0.05 },
    { ratio: "4:5" as const, w: 1080, h: 1350, dim: 600, x: 265, y: 750, posY: 0.1 },
  ])("applies the $ratio default camera placement", ({ ratio, w, h, dim, x, y, posY }) => {
    const result = executeCommand(
      createEngine(makeState()),
      createUpdateCanvasCommand(
        { aspectRatio: ratio, width: w, height: h },
        { cameraSources: CAMERA_SOURCES },
      ),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const next = result.value.history.present
    expect(next.canvas.videoPositionY).toBe(posY)

    const transform = cameraClipOf(next).transform
    expect(transform.preset).toBe("circle-pip")
    expect(transform.width).toBe(dim)
    expect(transform.height).toBe(dim)
    expect(transform.x).toBe(x)
    expect(transform.y).toBe(y)
  })

  it("switches to the side-by-side layout on 16:9 while keeping canvas insets", () => {
    const engine = createEngine(makeState())
    const portrait = executeCommand(
      engine,
      createUpdateCanvasCommand(
        { aspectRatio: "9:16", width: 1080, height: 1920 },
        { cameraSources: CAMERA_SOURCES },
      ),
    )
    expect(portrait.ok).toBe(true)
    if (!portrait.ok) return

    const landscape = executeCommand(
      portrait.value,
      createUpdateCanvasCommand(
        { aspectRatio: "16:9", width: 1920, height: 1080 },
        { cameraSources: CAMERA_SOURCES },
      ),
    )
    expect(landscape.ok).toBe(true)
    if (!landscape.ok) return

    const next = landscape.value.history.present
    // 16:9 keeps the caller's padding/radius and re-centers the video.
    expect(next.canvas).toMatchObject({
      aspectRatio: "16:9",
      width: 1920,
      height: 1080,
      padding: 24,
      borderRadius: 24,
      videoPositionY: 0.5,
    })

    const transform = cameraClipOf(next).transform
    const expected = buildCameraPresetTransform("side-by-side", {
      canvas: next.canvas,
      source: { width: 1280, height: 720 },
    })
    expect(transform.preset).toBe("side-by-side")
    expect(transform.locked).toBe(true)
    expect(transform.x).toBe(expected.x)
    expect(transform.y).toBe(expected.y)
    expect(transform.width).toBe(expected.width)
    expect(transform.height).toBe(expected.height)
  })

  it("re-layouts cameras the user positioned manually", () => {
    const state = makeState()
    const clip = cameraClipOf(state)
    // Manual drag clears the preset tag and unlocks the transform.
    clip.transform = { ...clip.transform, x: 40, y: 40, preset: undefined, locked: false }

    const result = executeCommand(
      createEngine(state),
      createUpdateCanvasCommand(
        { aspectRatio: "1:1", width: 1080, height: 1080 },
        { cameraSources: CAMERA_SOURCES },
      ),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const transform = cameraClipOf(result.value.history.present).transform
    expect(transform.preset).toBe("circle-pip")
    expect(transform.x).toBe(340)
    expect(transform.y).toBe(665)
  })

  it("lets explicit canvas fields win over the ratio defaults", () => {
    const result = executeCommand(
      createEngine(makeState()),
      createUpdateCanvasCommand(
        { aspectRatio: "9:16", width: 1080, height: 1920, padding: 64, videoPositionY: 0.2 },
        { cameraSources: CAMERA_SOURCES },
      ),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const next = result.value.history.present
    expect(next.canvas.padding).toBe(64)
    expect(next.canvas.borderRadius).toBe(24)
    expect(next.canvas.videoPositionY).toBe(0.2)
  })

  it("does not touch the camera when the ratio is unchanged", () => {
    const result = executeCommand(
      createEngine(makeState()),
      createUpdateCanvasCommand({ padding: 48 }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(cameraClipOf(result.value.history.present).transform.x).toBe(1656)
  })

  it("does not re-layout on a same-ratio update", () => {
    const result = executeCommand(
      createEngine(makeState()),
      createUpdateCanvasCommand({ aspectRatio: "16:9", padding: 48 }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const transform = cameraClipOf(result.value.history.present).transform
    expect(transform.preset).toBe("vertical-pip")
    expect(transform.x).toBe(1656)
  })

  it("applies canvas defaults even without a camera track", () => {
    const state = makeState(false)
    const result = executeCommand(
      createEngine(state),
      createUpdateCanvasCommand({ aspectRatio: "1:1", width: 1080, height: 1080 }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.history.present.canvas).toMatchObject({
      padding: 24,
      borderRadius: 24,
      videoPositionY: 0.05,
    })
    expect(result.value.history.present.tracks).toBe(state.tracks)
  })

  it("keeps a deliberately hidden camera hidden after re-layout", () => {
    const state = makeState()
    cameraClipOf(state).transform.visible = false

    const result = executeCommand(
      createEngine(state),
      createUpdateCanvasCommand(
        { aspectRatio: "9:16", width: 1080, height: 1920 },
        { cameraSources: CAMERA_SOURCES },
      ),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(cameraClipOf(result.value.history.present).transform.visible).toBe(false)
  })

  it("rebuilds the crop inside the existing crop when source sizes are unknown", () => {
    const result = executeCommand(
      createEngine(makeState()),
      createUpdateCanvasCommand({ aspectRatio: "9:16", width: 1080, height: 1920 }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const transform = cameraClipOf(result.value.history.present).transform
    // No cameraSources were provided: the new crop must stay a centered square
    // inside the previous 514x720 crop, offset back into source coordinates.
    expect(transform.crop).toEqual({ x: 383, y: 103, width: 514, height: 514 })
  })

  it("restores canvas and camera placement in a single undo", () => {
    const engine = createEngine(makeState())
    const result = executeCommand(
      engine,
      createUpdateCanvasCommand(
        { aspectRatio: "9:16", width: 1080, height: 1920 },
        { cameraSources: CAMERA_SOURCES },
      ),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const undone = undoCommand(result.value)
    expect(undone.ok).toBe(true)
    if (!undone.ok) return

    const present = undone.value.history.present
    expect(present.canvas).toMatchObject({
      aspectRatio: "16:9",
      width: 1920,
      height: 1080,
      padding: 96,
      borderRadius: 0,
    })
    expect(cameraClipOf(present).transform.preset).toBe("vertical-pip")
    expect(cameraClipOf(present).transform.x).toBe(1656)
  })
})
