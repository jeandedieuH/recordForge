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
import {
  analyzeProFeatureUsage,
  canvasResolutionTier,
  canvasSizeForAspectRatio,
  textClipIsFree,
} from "./index"

function makeTimeline(
  clips: TimelineClip[] = [],
  canvas?: Partial<TimelineState["canvas"]>,
): TimelineState {
  const tracks = clips.length
    ? [
        {
          id: "screen-track",
          kind: "screen" as const,
          name: "Screen",
          muted: false,
          locked: false,
          solo: false,
          volume: 1,
          clips: [
            {
              id: "screen-clip",
              kind: "screen" as const,
              assetId: "rec-1",
              startMs: 0,
              durationMs: 10_000,
              sourceInMs: 0,
              sourceOutMs: 10_000,
              speed: 1,
            },
          ],
        },
        {
          id: "overlay-track",
          kind: "overlay" as const,
          name: "Overlay",
          muted: false,
          locked: false,
          solo: false,
          volume: 1,
          clips,
        },
      ]
    : []
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
      ...canvas,
    },
    tracks,
    markers: [],
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

function textClip(overrides: Partial<TextClip> = {}): TextClip {
  return textClipSchema.parse({
    kind: "text",
    id: crypto.randomUUID(),
    ...CLIP_BASE,
    ...overrides,
  })
}

function annotationClip(overrides: Partial<AnnotationClip> = {}): AnnotationClip {
  return annotationClipSchema.parse({
    kind: "annotation",
    id: crypto.randomUUID(),
    ...CLIP_BASE,
    ...overrides,
  })
}

describe("canvasResolutionTier", () => {
  it("keys tiers by the short edge regardless of orientation", () => {
    expect(canvasResolutionTier({ width: 1920, height: 1080 })).toBe("1080p")
    expect(canvasResolutionTier({ width: 1080, height: 1920 })).toBe("1080p")
    expect(canvasResolutionTier({ width: 3840, height: 2160 })).toBe("2160p")
    expect(canvasResolutionTier({ width: 2160, height: 3840 })).toBe("2160p")
  })

  it("does not mistake a 1440p widescreen for 4K", () => {
    // Regression: the old max-edge rule returned 4K sizes here.
    expect(canvasResolutionTier({ width: 2560, height: 1440 })).toBe("1440p")
    expect(canvasSizeForAspectRatio("16:9", { width: 2560, height: 1440 })).toEqual({
      width: 2560,
      height: 1440,
    })
  })

  it("keeps 2160p relayouts on the 2160 base for all ratios", () => {
    const canvas = { width: 2160, height: 3840 }
    expect(canvasSizeForAspectRatio("9:16", canvas)).toEqual({ width: 2160, height: 3840 })
    expect(canvasSizeForAspectRatio("1:1", canvas)).toEqual({ width: 2160, height: 2160 })
  })
})

describe("textClipIsFree", () => {
  it("treats clean-text designs as free", () => {
    const clip = textClip({
      titleDesign: { version: 1, template: "clean-text" } as TextClip["titleDesign"],
    })
    expect(textClipIsFree(clip)).toBe(true)
  })

  it("treats other templates and legacy presetId-only clips as pro", () => {
    expect(
      textClipIsFree(
        textClip({
          titleDesign: { version: 1, template: "kinetic-hook" } as TextClip["titleDesign"],
        }),
      ),
    ).toBe(false)
    expect(textClipIsFree(textClip({ presetId: "lower-third-bold", titleDesign: undefined }))).toBe(
      false,
    )
  })
})

describe("analyzeProFeatureUsage", () => {
  it("reports no requirements for a clean 16:9 timeline", () => {
    const analysis = analyzeProFeatureUsage(makeTimeline())
    expect(analysis.requiresPro).toBe(false)
    expect(analysis.features).toEqual([])
    expect(analysis.outputCappedTo1080p).toBe(false)
  })

  it("flags enabled annotations but ignores disabled and muted ones", () => {
    const timeline = makeTimeline([annotationClip(), annotationClip({ enabled: false })])
    timeline.tracks[1].clips.push(annotationClip())
    timeline.tracks[1].muted = false
    const analysis = analyzeProFeatureUsage(timeline)
    expect(analysis.features).toEqual([
      { feature: "annotations", count: 2, detail: "2 annotations" },
    ])

    timeline.tracks[1].muted = true
    expect(analyzeProFeatureUsage(timeline).requiresPro).toBe(false)
  })

  it("flags non-clean text designs and counts them", () => {
    const timeline = makeTimeline([
      textClip({ titleDesign: { version: 1, template: "emphasis" } as TextClip["titleDesign"] }),
      textClip({ presetId: "title-modern", titleDesign: undefined }),
      textClip({ titleDesign: { version: 1, template: "clean-text" } as TextClip["titleDesign"] }),
    ])
    const analysis = analyzeProFeatureUsage(timeline)
    expect(analysis.features).toEqual([
      { feature: "premium-titles", count: 2, detail: "2 title presets" },
    ])
  })

  it("flags non-16:9 canvases and 4K canvases as capped", () => {
    const vertical = analyzeProFeatureUsage(makeTimeline([], { width: 1080, height: 1920 }))
    expect(vertical.features.map((f) => f.feature)).toEqual(["custom-aspect-ratio"])
    expect(vertical.outputCappedTo1080p).toBe(false)

    const fourK = analyzeProFeatureUsage(makeTimeline([], { width: 3840, height: 2160 }))
    expect(fourK.requiresPro).toBe(false) // 4K 16:9 canvas: downscaled, not blocked
    expect(fourK.outputCappedTo1080p).toBe(true)
  })

  it("flags chapters only when markers exist and chapter output is enabled", () => {
    const timeline = makeTimeline()
    timeline.markers.push({ id: "m1", timeMs: 1000, label: "Intro", color: "#f59e0b" })
    expect(
      analyzeProFeatureUsage(timeline, { preset: "balanced", chapterMode: "embed" }).features,
    ).toEqual([{ feature: "chapters", count: 1, detail: "1 chapter" }])
    expect(
      analyzeProFeatureUsage(timeline, { preset: "balanced", chapterMode: "none" }).requiresPro,
    ).toBe(false)
  })

  it("flags ultra presets and ratio presets via settings", () => {
    const timeline = makeTimeline()
    expect(
      analyzeProFeatureUsage(timeline, { preset: "ultra-4k", chapterMode: "none" }).features.map(
        (f) => f.feature,
      ),
    ).toEqual(["high-res-export"])
    expect(
      analyzeProFeatureUsage(timeline, { preset: "vertical", chapterMode: "none" }).features.map(
        (f) => f.feature,
      ),
    ).toEqual(["custom-aspect-ratio"])
  })
})
