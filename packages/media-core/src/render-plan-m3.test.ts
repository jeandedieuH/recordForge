import { describe, expect, it } from "vitest"
import {
  defaultCursorSettings,
  renderPlanSchema,
  type CameraLayoutSegment,
  type TimelineState,
  type VideoClip,
} from "@recordforge/contracts"
import { buildRenderPlan } from "./render-plan"

function videoClip(overrides: Partial<VideoClip> = {}): VideoClip {
  return {
    id: "video-clip",
    kind: "video",
    assetId: "broll",
    startMs: 1_000,
    durationMs: 3_000,
    sourceInMs: 0,
    sourceOutMs: 3_000,
    speed: 1,
    x: 200,
    y: 120,
    width: 960,
    height: 540,
    rotation: 0,
    anchorX: 0.5,
    anchorY: 0.5,
    zIndex: 0,
    opacity: 1,
    borderRadius: 12,
    borderWidth: 0,
    borderColor: "#ffffff",
    shadowEnabled: false,
    shadowColor: "rgba(0, 0, 0, 0.5)",
    shadowBlur: 10,
    fit: "contain",
    layoutMode: "overlay",
    animationIn: "fade",
    animationOut: "fade",
    animationMs: 400,
    volume: 1,
    audioMuted: false,
    fadeInMs: 0,
    fadeOutMs: 0,
    enabled: true,
    locked: false,
    ...overrides,
  }
}

function makeState(
  options: {
    video?: Partial<VideoClip>
    mutedMediaTrack?: boolean
    cameraLayouts?: CameraLayoutSegment[]
  } = {},
): TimelineState {
  return {
    version: 1,
    id: "m3-project",
    name: "M3",
    recordingId: "recording",
    canvas: {
      width: 1920,
      height: 1080,
      fps: 30,
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
            durationMs: 8_000,
            sourceInMs: 0,
            sourceOutMs: 8_000,
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
            durationMs: 8_000,
            sourceInMs: 0,
            sourceOutMs: 8_000,
            speed: 1,
            transform: {
              x: 1400,
              y: 700,
              width: 480,
              height: 270,
              opacity: 1,
              shape: "rounded",
            },
          },
        ],
      },
      {
        id: "media",
        kind: "media",
        name: "B-roll",
        muted: options.mutedMediaTrack ?? false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [videoClip(options.video)],
      },
    ],
    markers: [],
    zoomSegments: [],
    cameraLayouts: options.cameraLayouts,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }
}

describe("render plan — M3 video layers", () => {
  it("emits a b-roll clip as a video layer with animation keyframes", () => {
    const plan = buildRenderPlan({ state: makeState(), projectId: "m3-project" })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const layer = plan.value.overlays.find((overlay) => overlay.id === "video-clip")
    expect(layer).toBeDefined()
    expect(layer!.role).toBe("video")
    expect(layer!.fit).toBe("contain")
    expect(layer!.radius).toBe(12)
    expect(layer!.width).toBe(960)
    // Fade in/out over 400 ms at both ends.
    expect(layer!.keyframes?.length).toBeGreaterThanOrEqual(4)
    expect(layer!.keyframes![0].opacity).toBe(0)
    expect(layer!.keyframes![1].opacity).toBeGreaterThan(0)
    expect(layer!.keyframes![layer!.keyframes!.length - 1].opacity).toBeCloseTo(0, 1)
    expect(renderPlanSchema.safeParse(plan.value).success).toBe(true)
  })

  it("hides a muted media track and its audio", () => {
    const plan = buildRenderPlan({
      state: makeState({ mutedMediaTrack: true }),
      projectId: "m3-project",
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.overlays.some((overlay) => overlay.role === "video")).toBe(false)
    // Audio tracks travel with a `muted` flag rather than disappearing, so the
    // mixer keeps its track layout stable.
    const brollAudio = plan.value.audioTracks.find((track) => track.assetId === "broll")
    expect(brollAudio?.muted).toBe(true)
  })

  it("mixes embedded video audio as an export audio track", () => {
    const plan = buildRenderPlan({ state: makeState(), projectId: "m3-project" })
    if (!plan.ok) throw new Error(plan.error.message)
    const brollAudio = plan.value.audioTracks.find((track) => track.assetId === "broll")
    expect(brollAudio).toBeDefined()
    expect(brollAudio!.segments).toHaveLength(1)
    expect(brollAudio!.segments[0].outputStartMs).toBe(1_000)
    expect(brollAudio!.segments[0].outputEndMs).toBe(4_000)
  })

  it("skips the audio of a muted video clip", () => {
    const plan = buildRenderPlan({
      state: makeState({ video: { audioMuted: true } }),
      projectId: "m3-project",
    })
    if (!plan.ok) throw new Error(plan.error.message)
    expect(plan.value.audioTracks.some((track) => track.assetId === "broll")).toBe(false)
    // The visual layer still renders.
    expect(plan.value.overlays.some((overlay) => overlay.role === "video")).toBe(true)
  })

  it("fills the canvas for a fullscreen b-roll", () => {
    const plan = buildRenderPlan({
      state: makeState({ video: { layoutMode: "fullscreen" } }),
      projectId: "m3-project",
    })
    if (!plan.ok) throw new Error(plan.error.message)
    const layer = plan.value.overlays.find((overlay) => overlay.id === "video-clip")!
    expect(layer.fit).toBe("cover")
    expect({ x: layer.x, y: layer.y, width: layer.width, height: layer.height }).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    })
  })

  it("orders video layers and the camera by track order", () => {
    const plan = buildRenderPlan({ state: makeState(), projectId: "m3-project" })
    if (!plan.ok) throw new Error(plan.error.message)
    expect(plan.value.layerOrder).toEqual([
      { kind: "camera", id: "camera" },
      { kind: "video", id: "video-clip" },
    ])
  })
})

describe("render plan — M3 camera layouts", () => {
  it("emits per-frame camera and screen keyframes", () => {
    const state = makeState({
      cameraLayouts: [
        {
          id: "layout",
          startMs: 2_000,
          durationMs: 2_000,
          layout: "side-by-side",
          transitionInMs: 400,
          transitionOutMs: 400,
          easing: "linear",
          source: "manual",
          enabled: true,
          locked: false,
        },
      ],
    })
    const plan = buildRenderPlan({ state, projectId: "m3-project" })
    if (!plan.ok) throw new Error(plan.error.message)
    expect(plan.value.cameraLayouts).toHaveLength(1)
    const layout = plan.value.cameraLayouts[0]
    expect(layout.startMs).toBe(2_000)
    expect(layout.endMs).toBe(4_000)
    expect(layout.camera.length).toBeGreaterThanOrEqual(2)
    expect(layout.screen?.length).toBe(layout.camera.length)
    // The hold phase splits the frame: screen left, camera right. The sample at
    // the end of the transition ramp is already at the steady pose.
    const hold = layout.camera.find((keyframe) => keyframe.timeMs === 2_400)!
    expect(hold.x).toBe(960)
    expect(hold.width).toBe(960)
    const holdScreen = layout.screen!.find((keyframe) => keyframe.timeMs === 2_400)!
    expect(holdScreen.width).toBe(960)
    expect(renderPlanSchema.safeParse(plan.value).success).toBe(true)
  })

  it("maps layout keyframes into an export range", () => {
    const state = makeState({
      cameraLayouts: [
        {
          id: "layout",
          startMs: 2_000,
          durationMs: 2_000,
          layout: "fullscreen",
          transitionInMs: 200,
          transitionOutMs: 200,
          easing: "linear",
          source: "manual",
          enabled: true,
          locked: false,
        },
      ],
    })
    const plan = buildRenderPlan({
      state,
      projectId: "m3-project",
      range: { startMs: 1_000, endMs: 7_000 },
    })
    if (!plan.ok) throw new Error(plan.error.message)
    const layout = plan.value.cameraLayouts[0]
    expect(layout.startMs).toBe(1_000)
    expect(layout.endMs).toBe(3_000)
    // Keyframes ride the same offset as the window start.
    expect(layout.camera[0].timeMs).toBe(1_000)
    expect(renderPlanSchema.safeParse(plan.value).success).toBe(true)
  })

  it("keeps the lane empty for projects without layouts", () => {
    const plan = buildRenderPlan({ state: makeState(), projectId: "m3-project" })
    if (!plan.ok) throw new Error(plan.error.message)
    expect(plan.value.cameraLayouts).toEqual([])
  })
})
