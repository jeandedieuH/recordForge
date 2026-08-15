import { describe, expect, it } from "vitest"
import { defaultCursorSettings, defaultSmartZoomSettings, type TimelineState } from "@recordforge/domain"
import {
  applyPresetToTextClip,
  createAddAnnotationClipCommand,
  createAddExternalAudioClipCommand,
  createAddImageClipCommand,
  createAddTextClipCommand,
  createAnnotationClip,
  createEngine,
  createTextClipFromPreset,
  createUpdateAnnotationClipCommand,
  createUpdateImageClipCommand,
  createUpdateTextClipCommand,
  executeCommand,
  getTextPresetById,
  listTextPresetsByCategory,
  redoCommand,
  resolvePreviewComposition,
  undoCommand,
} from "./index"

function makeTestTimeline(): TimelineState {
  const now = "2026-08-16T00:00:00.000Z"
  return {
    version: 1,
    id: "test-project",
    name: "Test Project",
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
        id: "track:screen",
        kind: "screen",
        name: "Screen",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "screen-clip-1",
            kind: "screen",
            assetId: "rec-1",
            startMs: 0,
            durationMs: 15_000,
            sourceInMs: 0,
            sourceOutMs: 15_000,
            speed: 1,
          },
        ],
      },
    ],
    markers: [],
    zoomSegments: [],
    smartZoomSettings: defaultSmartZoomSettings,
    createdAt: now,
    updatedAt: now,
  }
}

describe("Annotations & Vector Shapes", () => {
  it("creates and adds an annotation clip to the timeline", () => {
    let engine = createEngine(makeTestTimeline())
    const clip = createAnnotationClip("rectangle", {
      startMs: 1000,
      durationMs: 4000,
      strokeColor: "#38bdf8",
      strokeWidth: 4,
      canvasWidth: 1920,
      canvasHeight: 1080,
    })

    const res = executeCommand(engine, createAddAnnotationClipCommand(clip))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    engine = res.value

    const annotationTrack = engine.history.present.tracks.find((t) => t.kind === "annotations")
    expect(annotationTrack).toBeDefined()
    expect(annotationTrack?.clips.length).toBe(1)
    expect(annotationTrack?.clips[0].kind).toBe("annotation")
    expect((annotationTrack?.clips[0] as any).strokeColor).toBe("#38bdf8")
  })

  it("updates an annotation clip and supports undo/redo", () => {
    let engine = createEngine(makeTestTimeline())
    const clip = createAnnotationClip("arrow", {
      startMs: 2000,
      durationMs: 3000,
      canvasWidth: 1920,
      canvasHeight: 1080,
    })

    let res = executeCommand(engine, createAddAnnotationClipCommand(clip))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    engine = res.value

    res = executeCommand(
      engine,
      createUpdateAnnotationClipCommand(clip.id, {
        strokeColor: "#ef4444",
        strokeWidth: 8,
        x: 300,
        y: 400,
      }),
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    engine = res.value

    let found = engine.history.present.tracks[1].clips[0] as any
    expect(found.strokeColor).toBe("#ef4444")
    expect(found.strokeWidth).toBe(8)
    expect(found.x).toBe(300)

    // Undo
    const undoRes = undoCommand(engine)
    expect(undoRes.ok).toBe(true)
    if (!undoRes.ok) return
    engine = undoRes.value
    found = engine.history.present.tracks[1].clips[0] as any
    expect(found.strokeColor).toBe(clip.strokeColor)

    // Redo
    const redoRes = redoCommand(engine)
    expect(redoRes.ok).toBe(true)
    if (!redoRes.ok) return
    engine = redoRes.value
    found = engine.history.present.tracks[1].clips[0] as any
    expect(found.strokeColor).toBe("#ef4444")
  })
})

describe("Titles & Text Presets", () => {
  it("lists presets by category and retrieves preset by ID", () => {
    const titles = listTextPresetsByCategory("title")
    expect(titles.length).toBeGreaterThan(0)
    const lowerThirds = listTextPresetsByCategory("lower-third")
    expect(lowerThirds.length).toBeGreaterThan(0)

    const preset = getTextPresetById("title-modern")
    expect(preset).toBeDefined()
    expect(preset?.name).toBe("Modern Minimalist")
  })

  it("creates and adds a text clip from a preset and can swap presets", () => {
    let engine = createEngine(makeTestTimeline())
    const textClip = createTextClipFromPreset("lowerthird-accent-bar", {
      startMs: 1500,
      durationMs: 5000,
      canvasWidth: 1920,
      canvasHeight: 1080,
    })

    expect(textClip.presetId).toBe("lowerthird-accent-bar")
    expect(textClip.category).toBe("lower-third")
    expect(textClip.backdropStyle).toBe("accent-bar")

    let res = executeCommand(engine, createAddTextClipCommand(textClip))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    engine = res.value

    const titlesTrack = engine.history.present.tracks.find((t) => t.kind === "titles")
    expect(titlesTrack).toBeDefined()
    expect(titlesTrack?.clips.length).toBe(1)

    // Update text content and swap to modern glass pill preset
    const swapped = applyPresetToTextClip(textClip, "lowerthird-glass-pill")
    res = executeCommand(
      engine,
      createUpdateTextClipCommand(textClip.id, {
        ...swapped,
        primaryText: "Alex Mercer",
        secondaryText: "Lead Software Architect",
      }),
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    engine = res.value

    const updated = engine.history.present.tracks.find((t) => t.kind === "titles")?.clips[0] as any
    expect(updated.presetId).toBe("lowerthird-glass-pill")
    expect(updated.primaryText).toBe("Alex Mercer")
    expect(updated.secondaryText).toBe("Lead Software Architect")
    expect(updated.backdropStyle).toBe("pill")
  })
})

describe("External Media (Audio & Graphics)", () => {
  it("adds an external audio track to the timeline", () => {
    let engine = createEngine(makeTestTimeline())
    const res = executeCommand(
      engine,
      createAddExternalAudioClipCommand("music-asset-1", 0, 15000, {
        volume: 0.75,
        role: "music",
        trackName: "Background Music",
      }),
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    engine = res.value

    const audioTrack = engine.history.present.tracks.find((t) => t.name === "Background Music")
    expect(audioTrack).toBeDefined()
    expect(audioTrack?.clips.length).toBe(1)
    expect((audioTrack?.clips[0] as any).role).toBe("music")
    expect((audioTrack?.clips[0] as any).volume).toBe(0.75)
  })

  it("adds and updates an image graphic overlay", () => {
    let engine = createEngine(makeTestTimeline())
    const imageClip = {
      id: "img-1",
      assetId: "logo-asset",
      kind: "image" as const,
      startMs: 1000,
      durationMs: 6000,
      sourceInMs: 0,
      sourceOutMs: 6000,
      speed: 1,
      x: 100,
      y: 100,
      width: 250,
      height: 150,
      opacity: 0.9,
      borderRadius: 12,
      borderWidth: 2,
      borderColor: "#ffffff",
      shadowEnabled: true,
      shadowColor: "rgba(0,0,0,0.5)",
      shadowBlur: 10,
      fit: "contain" as const,
      animationIn: "fade" as const,
      animationOut: "fade" as const,
      enabled: true,
      locked: false,
    }

    let res = executeCommand(engine, createAddImageClipCommand(imageClip))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    engine = res.value

    expect(engine.history.present.tracks.find((t) => t.kind === "graphics")).toBeDefined()

    res = executeCommand(
      engine,
      createUpdateImageClipCommand(imageClip.id, {
        opacity: 1,
        borderRadius: 24,
        fit: "cover",
      }),
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    engine = res.value

    const graphicsTrack = engine.history.present.tracks.find((t) => t.kind === "graphics")
    const updated = graphicsTrack?.clips[0] as any
    expect(updated.opacity).toBe(1)
    expect(updated.borderRadius).toBe(24)
    expect(updated.fit).toBe("cover")
  })
})

describe("Preview Composition Integration", () => {
  it("resolves active annotations, texts, and images in PreviewComposition", () => {
    let engine = createEngine(makeTestTimeline())
    const rect = createAnnotationClip("rectangle", { startMs: 2000, durationMs: 4000 })
    const title = createTextClipFromPreset("title-cinematic", { startMs: 3000, durationMs: 4000 })

    let res = executeCommand(engine, createAddAnnotationClipCommand(rect))
    if (res.ok) engine = res.value
    res = executeCommand(engine, createAddTextClipCommand(title))
    if (res.ok) engine = res.value

    // At 1000ms: neither is active
    const comp1 = resolvePreviewComposition(engine.history.present, 1000)
    expect(comp1.annotations[0].active).toBe(false)
    expect(comp1.texts[0].active).toBe(false)

    // At 2500ms: annotation is active
    const comp2 = resolvePreviewComposition(engine.history.present, 2500)
    expect(comp2.annotations[0].active).toBe(true)
    expect(comp2.texts[0].active).toBe(false)

    // At 3500ms: both are active
    const comp3 = resolvePreviewComposition(engine.history.present, 3500)
    expect(comp3.annotations[0].active).toBe(true)
    expect(comp3.texts[0].active).toBe(true)
  })
})
