import { describe, expect, it } from "vitest"
import {
  defaultCursorSettings,
  type CameraLayoutSegment,
  type ClipTransform,
  type TimelineState,
} from "@recordforge/contracts"
import {
  applyCommand,
  createAddCameraLayoutCommand,
  createDeleteCameraLayoutCommand,
  createRippleDeleteRangeCommand,
  createSplitCameraLayoutCommand,
  createUpdateCameraLayoutCommand,
} from "./commands"
import type { CommandRecord } from "./command-records"
import {
  baseCameraLayoutPose,
  blendCameraLayoutPose,
  cameraLayoutPose,
  evaluateCameraLayoutWindow,
  resolveCameraLayoutAt,
  resolveCameraLayoutWindows,
  sampleCameraLayoutKeyframes,
} from "./camera-layouts"
import { warpTimeline } from "./time-warp"

const CAMERA_TRANSFORM: ClipTransform = {
  x: 1400,
  y: 640,
  width: 480,
  height: 270,
  opacity: 1,
  shape: "rounded",
}

function makeState(cameraLayouts: CameraLayoutSegment[] = []): TimelineState {
  return {
    version: 1,
    id: "camera-layouts-project",
    name: "Camera layouts",
    recordingId: "recording",
    canvas: {
      width: 1920,
      height: 1080,
      fps: 60,
      background: "#000000",
      padding: 0,
      borderRadius: 0,
      shadow: false,
      cursorSettings: defaultCursorSettings,
    },
    tracks: [
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
            durationMs: 20_000,
            sourceInMs: 0,
            sourceOutMs: 20_000,
            speed: 1,
          },
        ],
      },
      {
        id: "camera",
        kind: "camera",
        name: "Camera",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "camera-clip",
            kind: "camera",
            assetId: "recording",
            startMs: 0,
            durationMs: 20_000,
            sourceInMs: 0,
            sourceOutMs: 20_000,
            speed: 1,
            transform: CAMERA_TRANSFORM,
          },
        ],
      },
    ],
    markers: [],
    zoomSegments: [],
    cameraLayouts,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }
}

function segment(
  id: string,
  startMs: number,
  durationMs: number,
  layout: CameraLayoutSegment["layout"],
  overrides: Partial<CameraLayoutSegment> = {},
): CameraLayoutSegment {
  return {
    id,
    startMs,
    durationMs,
    layout,
    transitionInMs: 400,
    transitionOutMs: 400,
    easing: "linear",
    source: "manual",
    enabled: true,
    locked: false,
    ...overrides,
  }
}

describe("camera layout resolver", () => {
  it("keeps the clip transform when the lane is empty", () => {
    const state = makeState()
    expect(resolveCameraLayoutAt(state, 1_000, CAMERA_TRANSFORM)).toBeNull()
  })

  it("applies the pip rect with the base clip aspect ratio", () => {
    const state = makeState([
      segment("one", 1_000, 2_000, "pip", {
        pip: { corner: "br", sizeFraction: 0.3, shape: "rounded" },
      }),
    ])
    const resolved = resolveCameraLayoutAt(state, 2_000, CAMERA_TRANSFORM)
    expect(resolved).not.toBeNull()
    expect(resolved!.layout).toBe("pip")
    const height = Math.round(1080 * 0.3)
    const width = Math.round(height * (480 / 270))
    expect(resolved!.pose.camera.height).toBe(height)
    expect(resolved!.pose.camera.width).toBe(width)
    // Bottom-right corner with a 4% margin.
    expect(resolved!.pose.camera.x).toBe(1920 - width - Math.round(1080 * 0.04))
    expect(resolved!.pose.camera.y).toBe(1080 - height - Math.round(1080 * 0.04))
    expect(resolved!.pose.radius).toBeGreaterThan(0)
  })

  it("covers the canvas in fullscreen and keeps the fitted screen rect", () => {
    const state = makeState([segment("one", 0, 2_000, "fullscreen")])
    const resolved = resolveCameraLayoutAt(state, 500, CAMERA_TRANSFORM)
    expect(resolved!.pose.camera).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
    expect(resolved!.pose.radius).toBe(0)
    expect(resolved!.pose.opacity).toBe(1)
  })

  it("fades the camera out for a hidden segment", () => {
    const state = makeState([segment("one", 0, 2_000, "hidden")])
    const resolved = resolveCameraLayoutAt(state, 1_000, CAMERA_TRANSFORM)
    expect(resolved!.pose.opacity).toBe(0)
  })

  it("splits the frame in side-by-side and moves the screen into its slot", () => {
    const state = makeState([segment("one", 0, 2_000, "side-by-side")])
    const resolved = resolveCameraLayoutAt(state, 1_000, CAMERA_TRANSFORM)
    expect(resolved!.pose.screen).toEqual({ x: 0, y: 0, width: 960, height: 1080 })
    expect(resolved!.pose.camera.x).toBe(960)
    expect(resolved!.pose.camera.width).toBe(960)
  })

  it("interpolates the rect across the transition window", () => {
    const state = makeState([segment("one", 0, 2_000, "fullscreen")])
    const base = baseCameraLayoutPose(state.canvas, CAMERA_TRANSFORM)
    const mid = resolveCameraLayoutAt(state, 200, CAMERA_TRANSFORM)!
    const end = resolveCameraLayoutAt(state, 1_000, CAMERA_TRANSFORM)!
    // Halfway through a linear 400 ms transition the rect sits between the
    // base bubble and the full-bleed frame.
    expect(mid.pose.camera.width).toBeGreaterThan(base.camera.width)
    expect(mid.pose.camera.width).toBeLessThan(end.pose.camera.width)
    expect(mid.pose.camera.width).toBeCloseTo(1_200, 0)
  })

  it("bridges adjacent segments and relaxes to the base at the tail", () => {
    const state = makeState([
      segment("a", 0, 1_000, "pip", { transitionOutMs: 0 }),
      segment("b", 1_000, 1_000, "fullscreen", { transitionInMs: 0, transitionOutMs: 400 }),
    ])
    const base = baseCameraLayoutPose(state.canvas, CAMERA_TRANSFORM)
    const windows = resolveCameraLayoutWindows(state.canvas, state.cameraLayouts!, { base })
    expect(windows).toHaveLength(2)
    expect(windows[0].toPose).toBe(windows[1].pose)
    expect(windows[1].fromPose).toBe(windows[0].pose)
    expect(windows[1].toPose).toEqual(base)
    const tail = resolveCameraLayoutAt(state, 1_950, CAMERA_TRANSFORM)!
    expect(tail.pose.camera.width).toBeLessThan(1920)
  })

  it("skips disabled segments", () => {
    const state = makeState([segment("one", 0, 2_000, "hidden", { enabled: false })])
    expect(resolveCameraLayoutAt(state, 1_000, CAMERA_TRANSFORM)).toBeNull()
  })

  it("samples holds with endpoints and transitions at the step cadence", () => {
    const state = makeState([segment("one", 0, 2_000, "fullscreen")])
    const base = baseCameraLayoutPose(state.canvas, CAMERA_TRANSFORM)
    const [window] = resolveCameraLayoutWindows(state.canvas, state.cameraLayouts!, { base })
    const samples = sampleCameraLayoutKeyframes(window, 100)
    expect(samples[0].timeMs).toBe(0)
    expect(samples[samples.length - 1].timeMs).toBe(2_000)
    // 400 ms of transition in, 400 ms out, 100 ms cadence → extra interior
    // samples on both ramps.
    expect(samples.length).toBeGreaterThanOrEqual(8)
    expect(samples[1].camera.width).toBeGreaterThan(base.camera.width)
  })

  it("blends shape past the midpoint", () => {
    const from = cameraLayoutPose(
      { width: 1920, height: 1080 },
      segment("a", 0, 100, "pip", { pip: { corner: "br", sizeFraction: 0.2, shape: "circle" } }),
      baseCameraLayoutPose({ width: 1920, height: 1080 }, CAMERA_TRANSFORM),
    )
    const to = cameraLayoutPose(
      { width: 1920, height: 1080 },
      segment("b", 0, 100, "fullscreen"),
      baseCameraLayoutPose({ width: 1920, height: 1080 }, CAMERA_TRANSFORM),
    )
    expect(blendCameraLayoutPose(from, to, 0.25).shape).toBe("circle")
    expect(blendCameraLayoutPose(from, to, 0.75).shape).toBe("rectangle")
  })

  it("evaluates the steady pose in the hold phase", () => {
    const state = makeState([segment("one", 0, 2_000, "fullscreen")])
    const base = baseCameraLayoutPose(state.canvas, CAMERA_TRANSFORM)
    const [window] = resolveCameraLayoutWindows(state.canvas, state.cameraLayouts!, { base })
    expect(evaluateCameraLayoutWindow(window, 1_000).camera.width).toBe(1920)
  })
})

function applyOk(state: TimelineState, command: CommandRecord): TimelineState {
  const result = applyCommand(state, command)
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

describe("camera layout commands", () => {
  it("adds, updates, splits and deletes a segment", () => {
    const state = makeState()
    const withSegment = applyOk(state, createAddCameraLayoutCommand(1_000, 3_000, "pip"))
    expect(withSegment.cameraLayouts).toHaveLength(1)
    const id = withSegment.cameraLayouts![0].id

    const updated = applyOk(
      withSegment,
      createUpdateCameraLayoutCommand(id, { layout: "fullscreen" }),
    )
    expect(updated.cameraLayouts![0].layout).toBe("fullscreen")

    const split = applyOk(withSegment, createSplitCameraLayoutCommand(id, 2_000))
    expect(split.cameraLayouts).toHaveLength(2)

    const deleted = applyOk(withSegment, createDeleteCameraLayoutCommand(id))
    expect(deleted.cameraLayouts).toHaveLength(0)
  })

  it("rejects overlapping segments", () => {
    const state = makeState([segment("one", 1_000, 2_000, "pip")])
    const result = applyCommand(state, createAddCameraLayoutCommand(2_000, 4_000, "hidden"))
    expect(result.ok).toBe(false)
  })

  it("remaps the lane on a ripple delete", () => {
    const state = makeState([segment("one", 4_000, 2_000, "pip")])
    const next = applyOk(state, createRippleDeleteRangeCommand(0, 2_000))
    expect(next.cameraLayouts![0].startMs).toBe(2_000)
    expect(next.cameraLayouts![0].durationMs).toBe(2_000)
  })

  it("scales the lane through a time warp", () => {
    const state = makeState([segment("one", 2_000, 4_000, "pip")])
    const warped = warpTimeline(state, 2_000, 6_000, 2_000, { ripple: true })
    expect(warped.cameraLayouts![0].startMs).toBe(2_000)
    expect(warped.cameraLayouts![0].durationMs).toBe(2_000)
  })
})
