import { describe, expect, it } from "vitest"
import {
  defaultCursorSettings,
  defaultSmartZoomSettings,
  type TimelineState,
} from "@recordforge/domain"
import {
  applyPresetToTextClip,
  createAddAnnotationClipCommand,
  createAddExternalAudioClipCommand,
  createAddImageClipCommand,
  createAddTextClipCommand,
  createAnnotationClip,
  createEngine,
  createMoveClipCommand,
  createMoveClipsCommand,
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

  it("applies phase 1 transform and animation updates to overlay clips", () => {
    let engine = createEngine(makeTestTimeline())
    const clip = createAnnotationClip("rectangle", { startMs: 500, durationMs: 2_000 })
    const added = executeCommand(engine, createAddAnnotationClipCommand(clip))
    expect(added.ok).toBe(true)
    if (!added.ok) return
    engine = added.value

    const updated = executeCommand(
      engine,
      createUpdateAnnotationClipCommand(clip.id, {
        rotation: 18,
        zIndex: 42,
        anchorX: 0.25,
        anchorY: 0.75,
        opacity: 0.8,
        overlayAnimation: {
          inType: "draw",
          outType: "fade",
          inDurationMs: 500,
          outDurationMs: 200,
          easing: "ease-out",
        },
      }),
    )
    expect(updated.ok).toBe(true)
    if (!updated.ok) return

    const next = updated.value.history.present.tracks[1].clips[0]
    expect(next).toMatchObject({
      rotation: 18,
      zIndex: 42,
      anchorX: 0.25,
      anchorY: 0.75,
      opacity: 0.8,
      overlayAnimation: {
        inType: "draw",
        outType: "fade",
        inDurationMs: 500,
        outDurationMs: 200,
        easing: "ease-out",
      },
    })

    const partial = executeCommand(
      updated.value,
      createUpdateAnnotationClipCommand(clip.id, {
        overlayAnimation: { inDurationMs: 600 },
      }),
    )
    expect(partial.ok).toBe(true)
    if (!partial.ok) return
    expect(partial.value.history.present.tracks[1].clips[0]).toMatchObject({
      overlayAnimation: {
        inDurationMs: 600,
        outDurationMs: 200,
        easing: "ease-out",
      },
    })
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
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
      zIndex: 0,
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
      overlayAnimation: {
        inType: "fade" as const,
        outType: "fade" as const,
        inDurationMs: 350,
        outDurationMs: 350,
        easing: "expo-out" as const,
      },
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

describe("Track Movement for Overlays (Annotations, Titles, Graphics)", () => {
  it("moves an annotation clip along its annotations track", () => {
    let engine = createEngine(makeTestTimeline())
    const clip = createAnnotationClip("rectangle", { startMs: 1000, durationMs: 4000 })
    const addRes = executeCommand(engine, createAddAnnotationClipCommand(clip))
    expect(addRes.ok).toBe(true)
    if (!addRes.ok) return
    engine = addRes.value

    const moveRes = executeCommand(engine, createMoveClipCommand(clip.id, 6000))
    expect(moveRes.ok).toBe(true)
    if (!moveRes.ok) return
    engine = moveRes.value

    const track = engine.history.present.tracks.find((t) => t.kind === "annotations")
    expect(track).toBeDefined()
    expect(track?.clips[0].startMs).toBe(6000)
  })

  it("moves a title / text clip along its titles track", () => {
    let engine = createEngine(makeTestTimeline())
    const clip = createTextClipFromPreset("title-modern", { startMs: 2000, durationMs: 5000 })
    const addRes = executeCommand(engine, createAddTextClipCommand(clip))
    expect(addRes.ok).toBe(true)
    if (!addRes.ok) return
    engine = addRes.value

    const moveRes = executeCommand(engine, createMoveClipCommand(clip.id, 8000))
    expect(moveRes.ok).toBe(true)
    if (!moveRes.ok) return
    engine = moveRes.value

    const track = engine.history.present.tracks.find((t) => t.kind === "titles")
    expect(track).toBeDefined()
    expect(track?.clips[0].startMs).toBe(8000)
  })

  it("moves an image graphic clip along its graphics track", () => {
    let engine = createEngine(makeTestTimeline())
    const imageClip = {
      id: "img-move-1",
      assetId: "logo-asset",
      kind: "image" as const,
      startMs: 1500,
      durationMs: 4000,
      sourceInMs: 0,
      sourceOutMs: 4000,
      speed: 1,
      x: 100,
      y: 100,
      width: 200,
      height: 100,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
      zIndex: 0,
      opacity: 1,
      borderRadius: 0,
      borderWidth: 0,
      borderColor: "#ffffff",
      shadowEnabled: false,
      shadowColor: "#000000",
      shadowBlur: 0,
      fit: "contain" as const,
      animationIn: "fade" as const,
      animationOut: "fade" as const,
      overlayAnimation: {
        inType: "fade" as const,
        outType: "fade" as const,
        inDurationMs: 350,
        outDurationMs: 350,
        easing: "expo-out" as const,
      },
      enabled: true,
      locked: false,
    }
    const addRes = executeCommand(engine, createAddImageClipCommand(imageClip))
    expect(addRes.ok).toBe(true)
    if (!addRes.ok) return
    engine = addRes.value

    const moveRes = executeCommand(engine, createMoveClipCommand(imageClip.id, 7000))
    expect(moveRes.ok).toBe(true)
    if (!moveRes.ok) return
    engine = moveRes.value

    const track = engine.history.present.tracks.find((t) => t.kind === "graphics")
    expect(track).toBeDefined()
    expect(track?.clips[0].startMs).toBe(7000)
  })

  it("moves multiple overlay clips together along the timeline", () => {
    let engine = createEngine(makeTestTimeline())
    const annClip = createAnnotationClip("rectangle", { startMs: 1000, durationMs: 4000 })
    const titleClip = createTextClipFromPreset("title-modern", { startMs: 2000, durationMs: 5000 })

    let res = executeCommand(engine, createAddAnnotationClipCommand(annClip))
    if (res.ok) engine = res.value
    res = executeCommand(engine, createAddTextClipCommand(titleClip))
    if (res.ok) engine = res.value

    const moveMultipleRes = executeCommand(
      engine,
      createMoveClipsCommand([annClip.id, titleClip.id], 3000),
    )
    expect(moveMultipleRes.ok).toBe(true)
    if (!moveMultipleRes.ok) return
    engine = moveMultipleRes.value

    const annTrack = engine.history.present.tracks.find((t) => t.kind === "annotations")
    const titlesTrack = engine.history.present.tracks.find((t) => t.kind === "titles")
    expect(annTrack?.clips[0].startMs).toBe(4000)
    expect(titlesTrack?.clips[0].startMs).toBe(5000)
  })

  it("allows overlapping overlay clips on annotations, titles, and graphics tracks", () => {
    let engine = createEngine(makeTestTimeline())
    const clip1 = createAnnotationClip("rectangle", { startMs: 1000, durationMs: 4000 })
    const clip2 = createAnnotationClip("arrow", { startMs: 7000, durationMs: 3000 })
    clip2.id = "arrow-clip-2"

    let res = executeCommand(engine, createAddAnnotationClipCommand(clip1))
    if (res.ok) engine = res.value
    res = executeCommand(engine, createAddAnnotationClipCommand(clip2))
    if (res.ok) engine = res.value

    // Move clip2 so that it overlaps clip1 (2000ms is within 1000-5000ms)
    const moveRes = executeCommand(engine, createMoveClipCommand(clip2.id, 2000))
    expect(moveRes.ok).toBe(true)
    if (!moveRes.ok) return
    engine = moveRes.value

    const track = engine.history.present.tracks.find((t) => t.kind === "annotations")
    expect(track?.clips.length).toBe(2)
  })

  it("rejects moving overlay clip to an incompatible track kind", () => {
    let engine = createEngine(makeTestTimeline())
    const clip = createAnnotationClip("rectangle", { startMs: 1000, durationMs: 4000 })
    const addRes = executeCommand(engine, createAddAnnotationClipCommand(clip))
    expect(addRes.ok).toBe(true)
    if (!addRes.ok) return
    engine = addRes.value

    // Attempt to move annotation clip to the screen track
    const screenTrackId = engine.history.present.tracks[0].id
    const moveRes = executeCommand(engine, createMoveClipCommand(clip.id, 3000, screenTrackId))
    expect(moveRes.ok).toBe(false)
    if (!moveRes.ok) {
      expect(moveRes.error.code).toBe("invalid_move")
      expect(moveRes.error.message).toBe("Clip kind does not match target track")
    }
  })
})
