import { describe, expect, it } from "vitest"
import {
  annotationClipSchema,
  exportTimelineOptionsSchema,
  imageClipSchema,
  renderPlanSchema,
  renderPlanZoomMotionPlanSchema,
  textClipSchema,
} from "./timeline"
import { projectSchema, projectAssetSchema, projectExportSettingsSchema } from "./project"

const minimalProject = {
  format: "recordforge.project",
  version: 1,
  id: "project-1",
  name: "My Project",
  recordingId: "rec-1",
  canvas: {
    width: 1920,
    height: 1080,
    fps: 30,
    background: "#000000",
    padding: 0,
    borderRadius: 0,
    shadow: false,
    cursorSettings: {
      preset: "recorded-system",
      scale: 1,
      fillColor: "#3b82f6",
      fillOpacity: 1,
      strokeColor: "#ffffff",
      strokeWidth: 2,
      strokeOpacity: 1,
      shadowEnabled: true,
      shadowColor: "#000000",
      shadowBlur: 8,
      shadowOffsetX: 2,
      shadowOffsetY: 4,
      shadowOpacity: 0.4,
      clickFeedback: "ripple",
      clickColor: "#60a5fa",
      clickSize: 36,
      smoothMovement: true,
      smoothFactor: 0.25,
      autoHideIdle: false,
      idleTimeoutMs: 2000,
      spotlightMode: false,
      spotlightRadius: 120,
      spotlightDimOpacity: 0.5,
      hideNativeCursor: true,
    },
  },
  assets: [
    {
      id: "asset-1",
      role: "screen",
      path: "output.mp4",
      status: "available",
      durationMs: 10_000,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
    },
  ],
  tracks: [
    {
      id: "track-1",
      kind: "screen",
      name: "Screen",
      muted: false,
      locked: false,
      solo: false,
      volume: 1,
      clips: [
        {
          id: "clip-1",
          kind: "screen",
          assetId: "asset-1",
          startMs: 0,
          durationMs: 10_000,
          sourceInMs: 0,
          sourceOutMs: 10_000,
          speed: 1,
        },
      ],
    },
  ],
  markers: [],
  exportSettings: {
    preset: "default-mp4",
    codec: "h264",
    container: "mp4",
    captionMode: "burn-in",
  },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  checksum: "sha256:abc",
}

describe("project contract", () => {
  it("parses a valid v1 project", () => {
    const parsed = projectSchema.parse(minimalProject)
    expect(parsed.id).toBe("project-1")
    expect(parsed.recordingId).toBe("rec-1")
    expect(parsed.assets[0].role).toBe("screen")
    expect(parsed.tracks[0].clips[0].assetId).toBe("asset-1")
  })

  it("keeps generated zoom metadata editable in the durable project shape", () => {
    const parsed = projectSchema.parse({
      ...minimalProject,
      smartZoomSettings: { preset: "cinematic", minDwellMs: 900 },
      zoomSegments: [
        {
          id: "smart-zoom-1",
          startMs: 1_000,
          durationMs: 800,
          target: { x: 100, y: 50, width: 960, height: 540 },
          scale: 1,
          easing: "cinematic",
          enabled: true,
          locked: false,
          mode: "auto",
          source: "click",
          preset: "cinematic",
        },
      ],
    })
    expect(parsed.smartZoomSettings?.preset).toBe("cinematic")
    expect(parsed.zoomSegments?.[0]).toMatchObject({
      mode: "auto",
      source: "click",
      preset: "cinematic",
    })
  })

  it("rejects a project with the wrong format", () => {
    expect(() => projectSchema.parse({ ...minimalProject, format: "other.project" })).toThrow()
  })

  it("rejects a project with an unsupported version", () => {
    expect(() => projectSchema.parse({ ...minimalProject, version: 2 })).toThrow()
  })

  it("defaults missing export settings", () => {
    const parsed = projectExportSettingsSchema.parse({})
    expect(parsed).toEqual({
      preset: "default-mp4",
      codec: "h264",
      encoder: "auto",
      container: "mp4",
      captionMode: "burn-in",
      chapterMode: "embed",
    })

    expect(projectExportSettingsSchema.parse({ preset: "smooth-60fps" }).preset).toBe(
      "smooth-60fps",
    )
    expect(projectExportSettingsSchema.parse({ preset: "ultra-4k" }).preset).toBe("ultra-4k")
    expect(projectExportSettingsSchema.parse({ preset: "ultra-4k-60" }).preset).toBe("ultra-4k-60")
    expect(projectExportSettingsSchema.parse({ preset: "gif-balanced" }).preset).toBe(
      "gif-balanced",
    )
    expect(projectExportSettingsSchema.parse({ preset: "gif-high-quality" }).preset).toBe(
      "gif-high-quality",
    )
    expect(projectExportSettingsSchema.parse({ preset: "gif-fast" }).preset).toBe("gif-fast")
    expect(
      projectExportSettingsSchema.parse({
        preset: "gif-balanced",
        container: "gif",
        codec: "gif",
        chapterMode: "none",
      }),
    ).toEqual({
      preset: "gif-balanced",
      container: "gif",
      codec: "gif",
      encoder: "auto",
      captionMode: "burn-in",
      chapterMode: "none",
    })
  })

  it("requires project-scoped render plans and keeps media paths out of the DTO", () => {
    const plan = renderPlanSchema.parse({
      projectId: "project-1",
      canvas: minimalProject.canvas,
      durationMs: 10_000,
      segments: [
        {
          assetId: "asset-1",
          sourceInMs: 0,
          sourceOutMs: 10_000,
          outputStartMs: 0,
          outputEndMs: 10_000,
          speed: 1,
        },
      ],
      gaps: [],
    })
    expect(plan.projectId).toBe("project-1")
    expect("inputPath" in plan.segments[0]).toBe(false)
    expect(() =>
      renderPlanSchema.parse({ ...plan, gaps: [{ startMs: 1_000, endMs: 2_000 }] }),
    ).toThrow()
    expect(() => renderPlanSchema.parse({ ...plan, projectId: "" })).toThrow()
  })

  it("validates compact zoom motion plans as contiguous cubic paths", () => {
    const motionPlan = renderPlanZoomMotionPlanSchema.parse({
      version: 1,
      kind: "cubic-bezier",
      segments: [
        {
          startMs: 0,
          endMs: 500,
          start: { x: 100, y: 100 },
          control1: { x: 120, y: 100 },
          control2: { x: 180, y: 200 },
          end: { x: 200, y: 200 },
        },
        {
          startMs: 500,
          endMs: 1_000,
          start: { x: 200, y: 200 },
          control1: { x: 220, y: 200 },
          control2: { x: 280, y: 300 },
          end: { x: 300, y: 300 },
        },
      ],
    })

    expect(motionPlan.segments).toHaveLength(2)
    expect(() =>
      renderPlanZoomMotionPlanSchema.parse({
        ...motionPlan,
        segments: [motionPlan.segments[0], { ...motionPlan.segments[1], startMs: 600 }],
      }),
    ).toThrow()
  })

  it("validates export settings separately from the render plan", () => {
    const parsed = exportTimelineOptionsSchema.parse({
      projectId: "project-1",
      outputPath: "C:/exports/demo.mp4",
      plan: {
        projectId: "project-1",
        canvas: minimalProject.canvas,
        durationMs: 10_000,
        segments: [
          {
            assetId: "asset-1",
            sourceInMs: 0,
            sourceOutMs: 10_000,
            outputStartMs: 0,
            outputEndMs: 10_000,
            speed: 1,
          },
        ],
        gaps: [],
      },
      settings: { preset: "high-quality", codec: "h264", container: "mp4", captionMode: "burn-in" },
    })
    expect(parsed.settings.preset).toBe("high-quality")
    expect(parsed.plan.projectId).toBe(parsed.projectId)
  })

  it("preserves cursor telemetry metadata in the asset registry", () => {
    const parsed = projectAssetSchema.parse({
      id: "cursor-events:rec-1",
      role: "cursor_events",
      path: "cursor_telemetry.json",
      sourceWidth: 1024,
      sourceHeight: 768,
      sampleRateHz: 60,
      schemaVersion: 1,
      captureBounds: { x: 0, y: 0, width: 1024, height: 768 },
      dpiScale: { x: 1, y: 1 },
      timebase: { unit: "ms", ticksPerSecond: 1000 },
    })
    expect(parsed.role).toBe("cursor_events")
    expect(parsed.captureBounds?.width).toBe(1024)
    expect(parsed.timebase?.ticksPerSecond).toBe(1000)
  })

  it("round-trips caption and privacy mask clips in the durable project shape", () => {
    const project = projectSchema.parse({
      ...minimalProject,
      tracks: [
        ...minimalProject.tracks,
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
              startMs: 500,
              durationMs: 1_000,
              sourceInMs: 500,
              sourceOutMs: 1_500,
              speed: 1,
              text: "Safe caption",
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
              assetId: "asset-1",
              startMs: 500,
              durationMs: 2_000,
              sourceInMs: 0,
              sourceOutMs: 2_000,
              speed: 1,
              mode: "redact",
              rect: { x: 10, y: 20, width: 320, height: 180 },
              blurRadius: 24,
              pixelSize: 12,
              redactColor: "black",
              enabled: true,
            },
          ],
        },
      ],
    })

    expect(project.tracks[1].clips[0]).toMatchObject({ kind: "caption", text: "Safe caption" })
    expect(project.tracks[2].clips[0]).toMatchObject({ kind: "mask", mode: "redact" })
  })

  it("defaults phase 1 overlay fields for every overlay clip kind", () => {
    const baseClip = {
      id: "overlay-clip",
      assetId: "synthetic:overlay",
      startMs: 0,
      durationMs: 1_000,
      sourceInMs: 0,
      sourceOutMs: 1_000,
      speed: 1,
    }

    expect(annotationClipSchema.parse({ ...baseClip, kind: "annotation" })).toMatchObject({
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
      zIndex: 0,
      opacity: 1,
      overlayAnimation: {
        inType: "fade",
        outType: "fade",
        inDurationMs: 350,
        outDurationMs: 350,
        easing: "expo-out",
      },
    })
    expect(textClipSchema.parse({ ...baseClip, kind: "text" })).toMatchObject({
      rotation: 0,
      zIndex: 0,
      overlayAnimation: expect.any(Object),
    })
    expect(imageClipSchema.parse({ ...baseClip, kind: "image" })).toMatchObject({
      rotation: 0,
      zIndex: 0,
      overlayAnimation: expect.any(Object),
    })
  })

  it("migrates v1 overlay animation fields and infers asset metadata on load", () => {
    const parsed = projectSchema.parse({
      ...minimalProject,
      assets: [
        ...minimalProject.assets,
        {
          id: "asset-logo",
          role: "graphic",
          path: "logo.svg",
          durationMs: 0,
          hasAudio: false,
        },
      ],
      tracks: [
        ...minimalProject.tracks,
        {
          id: "track-overlays",
          kind: "overlay",
          name: "Overlays",
          muted: false,
          locked: false,
          solo: false,
          volume: 1,
          clips: [
            {
              id: "legacy-annotation",
              assetId: "synthetic:annotation",
              kind: "annotation",
              annotationType: "rectangle",
              startMs: 100,
              durationMs: 500,
              sourceInMs: 0,
              sourceOutMs: 500,
              speed: 1,
              animationIn: "draw",
              animationOut: "fade",
              enabled: true,
              locked: false,
            },
          ],
        },
      ],
    })

    const asset = parsed.assets.find((candidate) => candidate.id === "asset-logo")
    expect(asset).toMatchObject({
      kind: "image",
      importStrategy: "copy",
      derivativeVersion: 1,
    })

    const clip = parsed.tracks[1].clips[0]
    expect(clip).toMatchObject({
      rotation: 0,
      zIndex: 0,
      overlayAnimation: {
        inType: "draw",
        outType: "fade",
        inDurationMs: 350,
        outDurationMs: 350,
        easing: "expo-out",
      },
    })
  })

  it("accepts persisted asset provenance and derivatives", () => {
    const parsed = projectAssetSchema.parse({
      id: "asset-logo",
      role: "graphic",
      kind: "image",
      path: "logo.svg",
      contentHash: "sha256:abc",
      importStrategy: "copy",
      originalPath: "C:/Users/example/logo.svg",
      svgSafe: true,
      derivatives: { thumbnail: "derivatives/logo.png" },
    })

    expect(parsed).toMatchObject({
      contentHash: "sha256:abc",
      importStrategy: "copy",
      originalPath: "C:/Users/example/logo.svg",
      svgSafe: true,
      derivativeVersion: 1,
      derivatives: { thumbnail: "derivatives/logo.png" },
    })
  })

  it("defaults missing asset status", () => {
    const parsed = projectAssetSchema.parse({
      id: "asset-2",
      role: "microphone",
      path: "mic.wav",
      durationMs: 10_000,
    })
    expect(parsed.status).toBe("available")
    expect(parsed.hasAudio).toBe(false)
    expect(parsed.fps).toBeUndefined()
  })

  it("validates canvas background blur and dim filter fields", () => {
    const parsed = projectSchema.parse({
      ...minimalProject,
      canvas: {
        ...minimalProject.canvas,
        background: "/backgrounds/bg-1.jpg",
        backgroundBlur: 24,
        backgroundDim: 0.35,
      },
    })
    expect(parsed.canvas.backgroundBlur).toBe(24)
    expect(parsed.canvas.backgroundDim).toBe(0.35)
  })
})
