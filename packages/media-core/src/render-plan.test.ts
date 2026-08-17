import { describe, expect, it } from "vitest"
import {
  annotationClipSchema,
  defaultCursorSettings,
  imageClipSchema,
  textClipSchema,
  type ProjectAsset,
  type TimelineState,
} from "@recordforge/domain"
import { buildOverlayRenderPlan, buildRenderPlan, isTimelineAudioMuted } from "./render-plan"

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

describe("render-plan", () => {
  it("builds a project-scoped plan and preserves intentional gaps and speed", () => {
    const state = makeTimeline()
    state.tracks[0].clips.push({
      id: "clip-1",
      kind: "screen",
      assetId: "rec-1",
      startMs: 25_000,
      durationMs: 2_500,
      sourceInMs: 20_000,
      sourceOutMs: 25_000,
      speed: 2,
    })

    const plan = buildRenderPlan({ state, projectId: "project-1" })

    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.projectId).toBe("project-1")
    expect(plan.value.gaps).toEqual([{ startMs: 20_000, endMs: 25_000 }])
    expect(plan.value.segments[1]).toMatchObject({
      speed: 2,
      outputStartMs: 25_000,
      outputEndMs: 27_500,
    })
    expect(plan.value.durationMs).toBe(27_500)
  })

  it("maps a selected range into zero-based output time", () => {
    const state = makeTimeline()
    state.tracks[0].clips.push({
      id: "clip-1",
      kind: "screen",
      assetId: "rec-1",
      startMs: 25_000,
      durationMs: 2_500,
      sourceInMs: 20_000,
      sourceOutMs: 25_000,
      speed: 2,
    })

    const plan = buildRenderPlan({
      state,
      projectId: "project-1",
      range: { startMs: 10_000, endMs: 27_500 },
    })

    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.gaps).toEqual([{ startMs: 10_000, endMs: 15_000 }])
    expect(plan.value.segments[0]).toMatchObject({
      outputStartMs: 0,
      outputEndMs: 10_000,
      sourceInMs: 10_000,
    })
    expect(plan.value.segments[1]).toMatchObject({
      outputStartMs: 15_000,
      outputEndMs: 17_500,
      sourceInMs: 20_000,
    })
    expect(plan.value.durationMs).toBe(17_500)
  })

  it("builds a plan from a single screen clip", () => {
    const plan = buildRenderPlan({
      state: makeTimeline(),
      projectId: "project-1",
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

    const plan = buildRenderPlan({ state, projectId: "project-1" })

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

    const plan = buildRenderPlan({ state, projectId: "project-1" })

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
      projectId: "project-1",
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
          presetId: "recorded-system",
          scale: 1.5,
          smoothing: "strong",
          settings: { rightClickEnabled: false },
          enabled: true,
          locked: false,
        },
      ],
    })

    const plan = buildRenderPlan({ state, projectId: "project-1" })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.cursorEffects).toEqual([
      expect.objectContaining({
        id: "cursor-range",
        assetId: "cursor-events:rec-1",
        startMs: 0,
        endMs: 20_000,
        presetId: "recorded-system",
        smoothing: "strong",
        settings: { rightClickEnabled: false },
      }),
    ])
  })

  it("derives cursor effect from canvas settings and assets when no cursor track exists", () => {
    const state = makeTimeline()
    state.canvas.cursorSettings = {
      ...defaultCursorSettings,
      preset: "recorded-system",
      scale: 1.25,
      smoothMovement: true,
      enabled: true,
    }
    const assets: ProjectAsset[] = [
      {
        id: "cursor-events:rec-1",
        role: "cursor_events",
        path: "cursor_telemetry.json",
        status: "available",
        derivativeVersion: 1,
        durationMs: 60_000,
        hasAudio: false,
      },
    ]

    const plan = buildRenderPlan({ state, projectId: "project-1", assets })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.cursorEffects).toEqual([
      expect.objectContaining({
        id: "cursor-effect:cursor-events:rec-1",
        assetId: "cursor-events:rec-1",
        startMs: 0,
        endMs: 20_000,
        presetId: "recorded-system",
        scale: 1.25,
        smoothing: "smooth",
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
        mode: "auto",
        source: "click",
        preset: "product-demo",
      },
    ]

    const plan = buildRenderPlan({ state, projectId: "project-1" })
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
      mode: "auto",
      source: "click",
      preset: "product-demo",
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
    const plan = buildRenderPlan({ state, projectId: "project-1" })
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

    const plan = buildRenderPlan({ state, projectId: "project-1" })
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
      projectId: "project-1",
      captionMode: "sidecar",
    })
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.value.captionMode).toBe("sidecar")
  })

  it("rejects a missing project identity before building a render plan", () => {
    const plan = buildRenderPlan({ state: makeTimeline(), projectId: "" })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.error.code).toBe("missing_project_id")
  })

  it("builds a complete render plan with annotations, titles, image overlays, and audio tracks", () => {
    const state = makeTimeline()
    state.tracks.push(
      {
        id: "annotations-track",
        kind: "annotations",
        name: "Annotations",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "ann-1",
            assetId: "synth:ann-1",
            kind: "annotation",
            presetId: "",
            annotationType: "rounded-rect",
            startMs: 1_000,
            durationMs: 4_000,
            sourceInMs: 0,
            sourceOutMs: 4_000,
            speed: 1,
            x: 100,
            y: 150,
            width: 300,
            height: 200,
            rotation: 0,
            anchorX: 0.5,
            anchorY: 0.5,
            zIndex: 0,
            opacity: 1,
            strokeColor: "#e879f9",
            strokeWidth: 4,
            strokeStyle: "solid",
            fillColor: "#e879f9",
            fillOpacity: 0.2,
            cornerRadius: 16,
            arrowStartHead: "none",
            arrowEndHead: "arrow",
            textColor: "#ffffff",
            fontSize: 16,
            animationIn: "fade",
            animationOut: "fade",
            overlayAnimation: {
              inType: "fade",
              outType: "fade",
              inDurationMs: 350,
              outDurationMs: 350,
              easing: "expo-out",
            },
            shadowEnabled: true,
            shadowColor: "rgba(0,0,0,0.5)",
            shadowBlur: 8,
            enabled: true,
            locked: false,
          },
        ],
      },
      {
        id: "titles-track",
        kind: "titles",
        name: "Titles",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "title-1",
            assetId: "synth:title-1",
            kind: "text",
            presetId: "cyberpunk-neon",
            category: "title",
            primaryText: "Welcome to recordForge",
            secondaryText: "Next-gen Screen Recording",
            tagText: "PRO",
            startMs: 2_000,
            durationMs: 5_000,
            sourceInMs: 0,
            sourceOutMs: 5_000,
            speed: 1,
            x: 120,
            y: 80,
            width: 600,
            height: 180,
            rotation: 0,
            anchorX: 0.5,
            anchorY: 0.5,
            zIndex: 0,
            opacity: 1,
            alignment: "left",
            fontFamily: "sans",
            fontSize: 32,
            fontWeight: "700",
            textColor: "#ffffff",
            secondaryTextColor: "#94a3b8",
            accentColor: "#f59e0b",
            backdropStyle: "glass",
            backdropColor: "#0f172a",
            backdropOpacity: 0.8,
            backdropBlur: 16,
            backdropBorderRadius: 16,
            backdropPaddingX: 24,
            backdropPaddingY: 16,
            shadowEnabled: true,
            shadowColor: "rgba(0,0,0,0.4)",
            shadowBlur: 16,
            animationIn: "fade",
            animationOut: "fade",
            overlayAnimation: {
              inType: "fade",
              outType: "fade",
              inDurationMs: 350,
              outDurationMs: 350,
              easing: "expo-out",
            },
            enabled: true,
            locked: false,
          },
        ],
      },
      {
        id: "graphics-track",
        kind: "graphics",
        name: "Graphics",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "img-1",
            assetId: "logo-1",
            kind: "image",
            startMs: 500,
            durationMs: 8_000,
            sourceInMs: 0,
            sourceOutMs: 8_000,
            speed: 1,
            x: 40,
            y: 40,
            width: 160,
            height: 160,
            rotation: 0,
            anchorX: 0.5,
            anchorY: 0.5,
            zIndex: 0,
            opacity: 1,
            borderRadius: 8,
            borderWidth: 0,
            borderColor: "#ffffff",
            shadowEnabled: true,
            shadowColor: "rgba(0,0,0,0.3)",
            shadowBlur: 10,
            fit: "contain",
            animationIn: "fade",
            animationOut: "fade",
            overlayAnimation: {
              inType: "fade",
              outType: "fade",
              inDurationMs: 350,
              outDurationMs: 350,
              easing: "expo-out",
            },
            enabled: true,
            locked: false,
          },
        ],
      },
    )

    const plan = buildRenderPlan({ state, projectId: "project-1" })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.annotations).toHaveLength(1)
    expect(plan.value.annotations[0].annotationType).toBe("rounded-rect")
    expect(plan.value.texts).toHaveLength(1)
    expect(plan.value.texts[0].presetId).toBe("cyberpunk-neon")
    expect(plan.value.images).toHaveLength(1)
    expect(plan.value.images[0].assetId).toBe("logo-1")
  })

  it("emits one canonical overlay render plan with transform and animation metadata", () => {
    const state = makeTimeline()
    const baseClip = {
      assetId: "synthetic:overlay",
      startMs: 0,
      durationMs: 4_000,
      sourceInMs: 0,
      sourceOutMs: 4_000,
      speed: 1,
    }
    const annotation = annotationClipSchema.parse({
      ...baseClip,
      id: "overlay-annotation",
      kind: "annotation",
      x: 100,
      y: 120,
      width: 320,
      height: 180,
      rotation: 12,
      zIndex: 5,
      overlayAnimation: {
        inType: "draw",
        outType: "fade",
        inDurationMs: 500,
        outDurationMs: 250,
        easing: "ease-out",
      },
    })
    const text = textClipSchema.parse({
      ...baseClip,
      id: "overlay-text",
      kind: "text",
      x: 80,
      y: 80,
      zIndex: 1,
      primaryText: "Overlay title",
    })
    const image = imageClipSchema.parse({
      ...baseClip,
      id: "overlay-image",
      assetId: "asset-logo",
      kind: "image",
      x: 1_200,
      y: 60,
      width: 400,
      height: 120,
      zIndex: 1,
      rotation: -4,
      opacity: 0.9,
    })

    state.tracks.push({
      id: "overlay-track",
      kind: "overlay",
      name: "Overlays",
      muted: false,
      locked: false,
      solo: false,
      volume: 1,
      clips: [annotation, text, image],
    })

    const assets: ProjectAsset[] = [
      {
        id: "asset-logo",
        role: "graphic",
        path: "logo.svg",
        status: "available",
        derivativeVersion: 1,
        durationMs: 0,
        width: 400,
        height: 120,
        hasAudio: false,
        kind: "image",
      },
    ]
    const plan = buildRenderPlan({ state, projectId: "project-1", assets })
    const previewPlan = buildOverlayRenderPlan(state, assets)

    expect(previewPlan.items.map((item) => item.id)).toEqual([
      "overlay-image",
      "overlay-annotation",
      "overlay-text",
    ])
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.overlayRenderPlan).toBeDefined()
    expect(plan.value.overlayRenderPlan?.items.map((item) => item.kind)).toEqual([
      "image",
      "annotation",
      "text",
    ])
    expect(plan.value.overlayRenderPlan?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "overlay-annotation",
          transform: expect.objectContaining({ rotation: 12 }),
          animation: expect.objectContaining({ inType: "draw", inDurationMs: 500 }),
        }),
        expect.objectContaining({
          id: "overlay-image",
          transform: expect.objectContaining({ rotation: -4, opacity: 0.9 }),
        }),
      ]),
    )
    expect(plan.value.overlayRenderPlan?.assets).toEqual([
      expect.objectContaining({ id: "asset-logo", kind: "image", width: 400, height: 120 }),
    ])
  })
})
