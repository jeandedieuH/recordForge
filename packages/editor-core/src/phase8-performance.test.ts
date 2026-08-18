import { describe, expect, it } from "vitest"
import type { TimelineState } from "@recordforge/domain"
import { defaultCursorSettings } from "@recordforge/domain"
import type { ImageClip } from "@recordforge/contracts"
import {
  createAddAnnotationClipCommand,
  createAddImageClipCommand,
  createAddTextClipCommand,
  createAnnotationClip,
  createTextClipFromPreset,
  createEngine,
  createOverlayTransaction,
  executeCommand,
  moveOverlayTransform,
  resolvePreviewComposition,
} from "./index"

function makeBaseTimelineState(): TimelineState {
  const now = "2026-08-17T00:00:00.000Z"
  return {
    version: 1,
    id: "phase8-perf-project",
    name: "Phase 8 Performance Project",
    recordingId: "recording-1",
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
        id: "screen-track",
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
            assetId: "recording-1",
            startMs: 0,
            durationMs: 60_000,
            sourceInMs: 0,
            sourceOutMs: 60_000,
            speed: 1,
          },
        ],
      },
      {
        id: "graphics-track",
        kind: "graphics",
        name: "Graphics Overlay",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [],
      },
      {
        id: "annotations-track",
        kind: "annotations",
        name: "Annotations",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [],
      },
      {
        id: "titles-track",
        kind: "titles",
        name: "Titles",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [],
      },
    ],
    markers: [],
    zoomSegments: [],
    createdAt: now,
    updatedAt: now,
  }
}

describe("Phase 8 performance budgets", () => {
  it("maintains <= 16 ms budget for 60 fps playback frame evaluation with 30 active overlays", () => {
    let engine = createEngine(makeBaseTimelineState())

    // Add 10 annotation shapes
    const shapes = [
      "rectangle",
      "rounded-rect",
      "circle",
      "arrow",
      "line",
      "callout",
      "spotlight",
      "badge",
    ] as const
    for (let i = 0; i < 10; i++) {
      const type = shapes[i % shapes.length]
      const clip = createAnnotationClip(type, {
        startMs: 1_000,
        durationMs: 10_000,
        canvasWidth: 1920,
        canvasHeight: 1080,
      })
      clip.id = `perf-ann-${i}`
      clip.x = 50 + ((i * 60) % 1600)
      clip.y = 50 + ((i * 40) % 800)
      clip.zIndex = i
      const res = executeCommand(engine, createAddAnnotationClipCommand(clip, "annotations-track"))
      expect(res.ok).toBe(true)
      if (res.ok) engine = res.value
    }

    // Add 10 styled text title presets
    for (let i = 0; i < 10; i++) {
      const textClip = createTextClipFromPreset("lowerthird-accent-bar", {
        startMs: 1_000,
        durationMs: 10_000,
        canvasWidth: 1920,
        canvasHeight: 1080,
      })
      textClip.id = `perf-text-${i}`
      textClip.primaryText = `Benchmark Title Preset ${i}`
      textClip.secondaryText = `Subtitle line for item ${i}`
      textClip.tagText = `TAG ${i}`
      textClip.x = 100 + i * 40
      textClip.y = 200 + i * 30
      textClip.width = 450
      textClip.height = 120
      textClip.zIndex = 10 + i

      const res = executeCommand(engine, createAddTextClipCommand(textClip, "titles-track"))
      expect(res.ok).toBe(true)
      if (res.ok) engine = res.value
    }

    // Add 10 image graphic overlays
    for (let i = 0; i < 10; i++) {
      const imgClip: ImageClip = {
        id: `perf-img-${i}`,
        kind: "image",
        assetId: `asset-img-${i % 3}`,
        startMs: 1_000,
        durationMs: 10_000,
        x: 300 + i * 50,
        y: 150 + i * 40,
        width: 320,
        height: 240,
        rotation: i * 5,
        anchorX: 0.5,
        anchorY: 0.5,
        zIndex: 20 + i,
        opacity: 0.9,
        borderRadius: 8,
        borderWidth: 2,
        borderColor: "#ffffff",
        shadowEnabled: true,
        shadowColor: "rgba(0,0,0,0.5)",
        shadowBlur: 8,
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
        sourceInMs: 0,
        sourceOutMs: 10_000,
        speed: 1,
      }
      const res = executeCommand(engine, createAddImageClipCommand(imgClip, "graphics-track"))
      expect(res.ok).toBe(true)
      if (res.ok) engine = res.value
    }

    const finalState = engine.history.present

    // Simulate 60 frame ticks at 60 fps (16.66ms step over 1 second)
    const frameTimes: number[] = []

    for (let frame = 0; frame < 60; frame++) {
      const timeMs = 1_000 + frame * (1000 / 60)
      const frameStart = performance.now()

      const composition = resolvePreviewComposition(finalState, timeMs)
      const activeAnnotations = composition.annotations.filter((a) => a.active)
      const activeTexts = composition.texts.filter((t) => t.active)
      const activeImages = composition.images.filter((img) => img.active)

      expect(activeAnnotations.length).toBe(10)
      expect(activeTexts.length).toBe(10)
      expect(activeImages.length).toBe(10)

      const frameDuration = performance.now() - frameStart
      frameTimes.push(frameDuration)
    }

    const averageFrameTime = frameTimes.reduce((acc, t) => acc + t, 0) / frameTimes.length
    expect(averageFrameTime).toBeLessThan(16) // Target budget: <= 16 ms at 60 fps
  })

  it("handles 100 transactional pointer moves with 0 intermediate commits and <= 16 ms final commit latency", () => {
    const baseState = makeBaseTimelineState()
    const clip = createAnnotationClip("rectangle", {
      startMs: 0,
      durationMs: 5_000,
      canvasWidth: 1920,
      canvasHeight: 1080,
    })
    clip.id = "gesture-test-clip"

    let engine = createEngine(baseState)
    const addResult = executeCommand(
      engine,
      createAddAnnotationClipCommand(clip, "annotations-track"),
    )
    expect(addResult.ok).toBe(true)
    if (!addResult.ok) return
    engine = addResult.value

    const initialHistoryLength = engine.history.past.length

    // Create transactional interaction handler
    const transaction = createOverlayTransaction()

    // 1. Begin gesture
    transaction.begin(engine.history.present, {
      kind: "move",
      clipId: clip.id,
      transform: {
        x: clip.x,
        y: clip.y,
        width: clip.width,
        height: clip.height,
        rotation: clip.rotation,
        anchorX: clip.anchorX,
        anchorY: clip.anchorY,
        zIndex: clip.zIndex,
        opacity: clip.opacity,
      },
    })

    expect(transaction.preview.valid).toBe(true)

    // 2. Perform 100 high-frequency pointer updates
    let currentTransform = {
      x: clip.x,
      y: clip.y,
      width: clip.width,
      height: clip.height,
      rotation: clip.rotation,
      anchorX: clip.anchorX,
      anchorY: clip.anchorY,
      zIndex: clip.zIndex,
      opacity: clip.opacity,
    }
    for (let step = 1; step <= 100; step++) {
      currentTransform = moveOverlayTransform(currentTransform, 1.5, 1.0, {
        canvasWidth: 1920,
        canvasHeight: 1080,
      })
      transaction.update({
        kind: "move",
        clipId: clip.id,
        transform: currentTransform,
      })
      // Assert no intermediate history entry was created
      expect(engine.history.past.length).toBe(initialHistoryLength)
    }

    // 3. Commit gesture on pointer release
    const commitStart = performance.now()
    const commitResult = transaction.commit()
    const commitDuration = performance.now() - commitStart

    expect(commitResult.ok).toBe(true)
    expect(commitDuration).toBeLessThan(16) // Transaction commit budget <= 16 ms

    if (commitResult.ok) {
      const executed = executeCommand(engine, commitResult.value.command)
      expect(executed.ok).toBe(true)
      if (executed.ok) {
        // Exactly 1 new history entry was added for the entire 100-movement gesture
        expect(executed.value.history.past.length).toBe(initialHistoryLength + 1)
      }
    }
  })

  it("loads and validates a project with 50 overlay clips under 200 ms", () => {
    const loadStart = performance.now()
    let engine = createEngine(makeBaseTimelineState())

    for (let i = 0; i < 50; i++) {
      const clip = createAnnotationClip("rounded-rect", {
        startMs: i * 500,
        durationMs: 3_000,
        canvasWidth: 1920,
        canvasHeight: 1080,
      })
      clip.id = `load-benchmark-clip-${i}`
      clip.x = (i * 35) % 1400
      clip.y = (i * 25) % 800
      clip.zIndex = i
      const res = executeCommand(engine, createAddAnnotationClipCommand(clip, "annotations-track"))
      expect(res.ok).toBe(true)
      if (res.ok) engine = res.value
    }

    const loadDuration = performance.now() - loadStart
    expect(loadDuration).toBeLessThan(200) // Project load budget <= 200 ms
    expect(engine.history.present.tracks.find((t) => t.kind === "annotations")?.clips.length).toBe(
      50,
    )
  })
})
