import { describe, expect, it } from "vitest"
import {
  defaultCursorSettings,
  type LibraryRecording,
  type TimelineState,
} from "@recordforge/domain"
import { buildRenderPlan, isTimelineAudioMuted } from "./render-plan"

function makeTimeline(clipCount = 1): TimelineState {
  return {
    version: 1,
    id: "project-1",
    name: "Test",
    recordingId: "rec-1",
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
        id: "track-1",
        kind: "screen",
        name: "Screen",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: Array.from({ length: clipCount }, (_, index) => ({
          id: `clip-${index}`,
          kind: "screen" as const,
          assetId: "rec-1",
          startMs: index * 20_000,
          durationMs: 20_000,
          sourceInMs: index * 20_000,
          sourceOutMs: (index + 1) * 20_000,
          speed: 1,
        })),
      },
    ],
    markers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

const recording: LibraryRecording = {
  id: "rec-1",
  sessionId: "session-1",
  name: "Test recording",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  durationMs: 60_000,
  sizeBytes: 0,
  width: 1920,
  height: 1080,
  fps: 30,
  status: "completed",
  tags: [],
  source: {
    kind: "display",
    id: "display-1",
    name: "Display 1",
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  },
  profileName: "balanced",
  outputPath: "/tmp/rec-1/output.mp4",
  workDir: "/tmp/rec-1",
  markers: [],
}

describe("render-plan", () => {
  it("builds a plan from a single screen clip", () => {
    const plan = buildRenderPlan({
      state: makeTimeline(),
      recording,
      outputPath: "/tmp/export.mp4",
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    expect(plan.value.segments).toHaveLength(1)
    expect(plan.value.segments[0].sourceInMs).toBe(0)
    expect(plan.value.segments[0].sourceOutMs).toBe(20_000)
    expect(plan.value.segments[0].outputStartMs).toBe(0)
    expect(plan.value.segments[0].outputEndMs).toBe(20_000)
    expect(plan.value.audio?.muted).toBe(false)
  })

  it("builds independent audio track segments with stream indexes and volume", () => {
    const state = makeTimeline()
    state.tracks.push({
      id: "mic-track",
      kind: "audio",
      name: "Microphone",
      muted: false,
      locked: false,
      solo: false,
      volume: 0.8,
      clips: [
        {
          id: "mic-clip",
          kind: "audio",
          assetId: "rec-1",
          streamIndex: 1,
          startMs: 0,
          durationMs: 20_000,
          sourceInMs: 0,
          sourceOutMs: 20_000,
          speed: 1,
          volume: 0.5,
          fadeInMs: 0,
          fadeOutMs: 0,
        },
      ],
    })

    const plan = buildRenderPlan({ state, recording, outputPath: "/tmp/export.mp4" })

    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.audioTracks).toHaveLength(1)
    expect(plan.value.audioTracks[0]).toMatchObject({
      streamIndex: 1,
      muted: false,
      volume: 0.8,
    })
    expect(plan.value.audioTracks[0].segments[0]).toMatchObject({
      streamIndex: 1,
      volume: 0.4,
      sourceInMs: 0,
      sourceOutMs: 20_000,
    })
  })

  it("preserves muted audio tracks in the render plan", () => {
    const state = makeTimeline()
    state.tracks.push({
      id: "muted-audio-track",
      kind: "audio",
      name: "Microphone",
      muted: true,
      locked: false,
      solo: false,
      volume: 1,
      clips: [
        {
          id: "muted-audio-clip",
          kind: "audio",
          assetId: "rec-1",
          streamIndex: 1,
          startMs: 0,
          durationMs: 20_000,
          sourceInMs: 0,
          sourceOutMs: 20_000,
          speed: 1,
          volume: 1,
          fadeInMs: 0,
          fadeOutMs: 0,
        },
      ],
    })

    expect(isTimelineAudioMuted(state)).toBe(true)
    state.tracks[1].muted = false
    expect(isTimelineAudioMuted(state)).toBe(false)
    state.tracks[1].muted = true

    const plan = buildRenderPlan({ state, recording, outputPath: "/tmp/export.mp4" })

    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.audioTracks[0]).toMatchObject({
      streamIndex: 1,
      muted: true,
    })
  })

  it("builds a plan with continuous output times", () => {
    const plan = buildRenderPlan({
      state: makeTimeline(3),
      recording,
      outputPath: "/tmp/export.mp4",
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    expect(plan.value.segments).toHaveLength(3)
    expect(plan.value.segments[0].outputStartMs).toBe(0)
    expect(plan.value.segments[0].outputEndMs).toBe(20_000)
    expect(plan.value.segments[1].outputStartMs).toBe(20_000)
    expect(plan.value.segments[1].outputEndMs).toBe(40_000)
    expect(plan.value.segments[2].outputStartMs).toBe(40_000)
    expect(plan.value.segments[2].outputEndMs).toBe(60_000)
  })

  it("carries cursor range settings by asset and effect ids", () => {
    const state = makeTimeline()
    state.tracks.push({
      id: "cursor-track",
      kind: "cursor",
      name: "Cursor",
      muted: false,
      locked: false,
      solo: false,
      volume: 1,
      clips: [
        {
          id: "cursor-range",
          kind: "cursor-effect",
          assetId: "cursor-events:rec-1",
          startMs: 0,
          durationMs: 20_000,
          sourceInMs: 0,
          sourceOutMs: 0,
          speed: 1,
          presetId: "cyberpunk",
          scale: 1.5,
          smoothing: "strong",
          settings: { rightClickEnabled: false },
          enabled: true,
          locked: false,
        },
      ],
    })

    const plan = buildRenderPlan({ state, recording, outputPath: "/tmp/export.mp4" })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.cursorEffects).toEqual([
      expect.objectContaining({
        id: "cursor-range",
        assetId: "cursor-events:rec-1",
        startMs: 0,
        endMs: 20_000,
        presetId: "cyberpunk",
        smoothing: "strong",
        settings: { rightClickEnabled: false },
      }),
    ])
  })

  it("plans camera transforms, crop, visibility ranges, and manual zoom segments", () => {
    const state = makeTimeline()
    state.tracks.push({
      id: "camera-track",
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
          assetId: "rec-1",
          streamIndex: 2,
          startMs: 2_000,
          durationMs: 5_000,
          sourceInMs: 2_000,
          sourceOutMs: 7_000,
          speed: 1,
          transform: {
            x: 1_800,
            y: 1_000,
            width: 480,
            height: 320,
            crop: { x: 10, y: 20, width: 640, height: 480 },
            opacity: 0.8,
            shape: "circle",
            visible: false,
            borderWidth: 4,
            shadowEnabled: true,
          },
        },
      ],
    })
    state.zoomSegments = [
      {
        id: "zoom-1",
        startMs: 1_000,
        durationMs: 3_000,
        target: { x: -100, y: 100, width: 1_000, height: 700 },
        scale: 1.5,
        easing: "ease-out",
        enabled: true,
        locked: false,
      },
    ]

    const plan = buildRenderPlan({ state, recording, outputPath: "/tmp/export.mp4" })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.overlays[0]).toMatchObject({
      streamIndex: 2,
      outputStartMs: 2_000,
      visible: false,
      crop: { width: 640, height: 480 },
      shape: "circle",
    })
    expect(plan.value.zoomSegments[0]).toMatchObject({
      id: "zoom-1",
      startMs: 1_000,
      endMs: 4_000,
      target: { x: 0, y: 100 },
    })
  })

  it("carries audio fades and solo exclusion into the render plan", () => {
    const state = makeTimeline()
    state.tracks.push({
      id: "system-track",
      kind: "audio",
      name: "System Audio",
      muted: false,
      locked: false,
      solo: true,
      volume: 0.75,
      clips: [
        {
          id: "system-clip",
          kind: "audio",
          assetId: "rec-1",
          streamIndex: 2,
          role: "system_audio",
          startMs: 0,
          durationMs: 20_000,
          sourceInMs: 0,
          sourceOutMs: 20_000,
          speed: 1,
          volume: 0.5,
          fadeInMs: 500,
          fadeOutMs: 800,
        },
      ],
    })
    const plan = buildRenderPlan({ state, recording, outputPath: "/tmp/export.mp4" })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.audioTracks).toHaveLength(1)
    expect(plan.value.audioTracks[0]).toMatchObject({ role: "system_audio", muted: false })
    expect(plan.value.audioTracks[0].segments[0]).toMatchObject({
      volume: 0.375,
      fadeInMs: 500,
      fadeOutMs: 800,
    })
  })

  it("includes editable captions and static privacy masks in the render plan", () => {
    const state = makeTimeline()
    state.tracks.push(
      {
        id: "captions-track",
        kind: "captions",
        name: "Captions",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "caption-1",
            kind: "caption",
            assetId: "captions-track",
            startMs: 1_000,
            durationMs: 2_000,
            sourceInMs: 1_000,
            sourceOutMs: 3_000,
            speed: 1,
            text: "Private caption",
            style: "boxed",
            placement: "bottom",
            safeAreaMargin: 48,
          },
        ],
      },
      {
        id: "effects-track",
        kind: "effects",
        name: "Effects",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "mask-1",
            kind: "mask",
            assetId: "rec-1",
            startMs: 500,
            durationMs: 3_000,
            sourceInMs: 0,
            sourceOutMs: 3_000,
            speed: 1,
            mode: "pixelate",
            rect: { x: 100, y: 120, width: 480, height: 260 },
            blurRadius: 24,
            pixelSize: 16,
            redactColor: "black",
            enabled: true,
          },
        ],
      },
    )

    const plan = buildRenderPlan({ state, recording, outputPath: "/tmp/export.mp4" })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.captionMode).toBe("burn-in")
    expect(plan.value.captions).toEqual([
      expect.objectContaining({
        id: "caption-1",
        startMs: 1_000,
        endMs: 3_000,
        text: "Private caption",
        style: "boxed",
        placement: "bottom",
      }),
    ])
    expect(plan.value.masks).toEqual([
      expect.objectContaining({
        id: "mask-1",
        mode: "pixelate",
        rect: { x: 100, y: 120, width: 480, height: 260 },
      }),
    ])
  })

  it("supports sidecar captions without changing the source timeline", () => {
    const state = makeTimeline()
    state.tracks.push({
      id: "captions-track",
      kind: "captions",
      name: "Captions",
      muted: false,
      locked: false,
      solo: false,
      volume: 1,
      clips: [
        {
          id: "caption-1",
          kind: "caption",
          assetId: "captions-track",
          startMs: 0,
          durationMs: 1_000,
          sourceInMs: 0,
          sourceOutMs: 1_000,
          speed: 1,
          text: "Sidecar cue",
          style: "minimal",
        },
      ],
    })
    const plan = buildRenderPlan({
      state,
      recording,
      outputPath: "/tmp/export.mp4",
      captionMode: "sidecar",
    })
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.value.captionMode).toBe("sidecar")
  })

  it("fails when the recording has no output path", () => {
    const badRecording = { ...recording, outputPath: undefined }
    const plan = buildRenderPlan({
      state: makeTimeline(),
      recording: badRecording,
      outputPath: "/tmp/export.mp4",
    })
    expect(plan.ok).toBe(false)
  })
})
