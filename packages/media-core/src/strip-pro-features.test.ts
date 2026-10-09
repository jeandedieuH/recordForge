import { describe, expect, it } from "vitest"
import {
  annotationClipSchema,
  defaultCursorSettings,
  textClipSchema,
  type AnnotationClip,
  type TextClip,
  type TimelineClip,
  type TimelineState,
} from "@recordforge/domain"
import { analyzeProFeatureUsage } from "@recordforge/editor-core"
import { buildRenderPlan, freeExportSettings, stripProTimelineFeatures } from "./render-plan"

function makeTimeline(clips: TimelineClip[] = []): TimelineState {
  const tracks: TimelineState["tracks"] = [
    {
      id: "screen-track",
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
          assetId: "rec-1",
          startMs: 0,
          durationMs: 10_000,
          sourceInMs: 0,
          sourceOutMs: 10_000,
          speed: 1,
        },
      ],
    },
  ]
  if (clips.length > 0) {
    tracks.push({
      id: "overlay-track",
      kind: "overlay",
      name: "Overlay",
      muted: false,
      locked: false,
      solo: false,
      volume: 1,
      clips,
    })
  }
  return {
    version: 1,
    id: "project-1",
    name: "Test",
    recordingId: "rec-1",
    canvas: {
      width: 1920,
      height: 1080,
      fps: 30,
      background: "#000",
      padding: 0,
      borderRadius: 0,
      shadow: false,
      cursorSettings: defaultCursorSettings,
    },
    tracks,
    markers: [{ id: "m1", timeMs: 1000, label: "Intro", color: "#f59e0b" }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

const CLIP_BASE = {
  assetId: "rec-1",
  startMs: 0,
  durationMs: 4000,
  sourceInMs: 0,
  sourceOutMs: 4000,
  speed: 1,
} as const

function premiumText(): TextClip {
  return textClipSchema.parse({
    kind: "text",
    id: "text-1",
    ...CLIP_BASE,
    primaryText: "Keep this wording",
    titleDesign: { version: 1, template: "emphasis", appearance: "light" },
  })
}

function legacyText(): TextClip {
  return textClipSchema.parse({
    kind: "text",
    id: "text-2",
    ...CLIP_BASE,
    primaryText: "Legacy preset",
    presetId: "lower-third-bold",
    titleDesign: undefined,
  })
}

function annotation(): AnnotationClip {
  return annotationClipSchema.parse({
    kind: "annotation",
    id: "ann-1",
    ...CLIP_BASE,
  })
}

describe("stripProTimelineFeatures", () => {
  it("disables annotations without deleting them", () => {
    const stripped = stripProTimelineFeatures(makeTimeline([annotation()]))
    const clip = stripped.tracks[1].clips[0]
    expect(clip.kind).toBe("annotation")
    if (clip.kind === "annotation") {
      expect(clip.enabled).toBe(false)
    }
  })

  it("converts premium and legacy text designs to clean-text", () => {
    const stripped = stripProTimelineFeatures(makeTimeline([premiumText(), legacyText()]))
    const [premium, legacy] = stripped.tracks[1].clips as TextClip[]
    expect(premium.titleDesign?.template).toBe("clean-text")
    expect(premium.primaryText).toBe("Keep this wording")
    // Compatible style controls are preserved from the original design.
    expect(premium.titleDesign?.appearance).toBe("light")
    expect(legacy.titleDesign?.template).toBe("clean-text")
    expect(legacy.presetId).toBe("lower-third-bold")
  })
})

describe("buildRenderPlan with stripProFeatures", () => {
  it("produces a plan with no Pro requirements", () => {
    const timeline = makeTimeline([premiumText(), legacyText(), annotation()])
    const result = buildRenderPlan({
      state: timeline,
      projectId: "project-1",
      stripProFeatures: true,
      settings: { preset: "balanced" } as never,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const plan = result.value
    expect(plan.annotations).toEqual([])
    expect(plan.texts.every((text) => text.titleDesign?.template === "clean-text")).toBe(true)
    expect(plan.texts.map((text) => text.primaryText)).toContain("Keep this wording")
    expect(plan.chapterMode).toBe("none")
    const overlayKinds = plan.overlayRenderPlan?.items.map((item) => item.kind) ?? []
    expect(overlayKinds).not.toContain("annotation")
    const overlayTexts = plan.overlayRenderPlan?.items.filter((item) => item.kind === "text") ?? []
    expect(overlayTexts.every((item) => item.titleDesign?.template === "clean-text")).toBe(true)
  })

  it("still flags Pro requirements when strip is off", () => {
    const timeline = makeTimeline([premiumText(), annotation()])
    const result = buildRenderPlan({ state: timeline, projectId: "project-1" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.annotations).toHaveLength(1)
    expect(result.value.chapterMode).toBe("embed")
  })
})

describe("freeExportSettings", () => {
  const base = {
    preset: "ultra-4k",
    codec: "h264",
    encoder: "auto",
    container: "mp4",
    captionMode: "burn-in",
    chapterMode: "embed",
    audioMastering: { denoise: true, loudnessTarget: -16 },
    brandWatermark: {
      enabled: false,
      logoPath: null,
      position: "bottom-right",
      scalePercent: 8,
      opacity: 0.85,
    },
    brandCards: {
      enabled: false,
      introMs: 0,
      outroMs: 0,
      title: null,
      subtitle: null,
      background: "#0f172a",
      textColor: "#f8fafc",
      fontPath: null,
    },
    keystrokeOverlay: { enabled: false },
    reframeMode: "fit",
    webcamBackground: {
      enabled: false,
      mode: "blur" as const,
      blurSigma: 20,
      replaceColor: "#0f172a",
    },
  } as const

  it("downgrades ultra presets and disables chapter output", () => {
    const settings = freeExportSettings({ ...base })
    expect(settings.preset).toBe("high-quality")
    expect(settings.chapterMode).toBe("none")
    expect(settings.codec).toBe("h264")
    // Studio Audio is Pro — mastering gets neutralized for Free exports.
    expect(settings.audioMastering).toEqual({ denoise: false, loudnessTarget: null })
  })

  it("neutralizes ratio presets but leaves others untouched", () => {
    expect(freeExportSettings({ ...base, preset: "vertical" }).preset).toBe("balanced")
    expect(freeExportSettings({ ...base, preset: "square" }).preset).toBe("balanced")
    expect(freeExportSettings({ ...base, preset: "fast-share" }).preset).toBe("fast-share")
  })
})

describe("free-tier analyzer agreement", () => {
  it("a stripped plan no longer requires Pro", () => {
    const timeline = makeTimeline([premiumText(), legacyText(), annotation()])
    expect(analyzeProFeatureUsage(timeline).requiresPro).toBe(true)
    const stripped = stripProTimelineFeatures(timeline)
    expect(
      analyzeProFeatureUsage(stripped, { preset: "balanced", chapterMode: "none" }).requiresPro,
    ).toBe(false)
  })
})
