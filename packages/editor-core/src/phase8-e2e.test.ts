import { describe, expect, it } from "vitest"
import type { TimelineState } from "@recordforge/domain"
import { defaultCursorSettings, timelineStateSchema } from "@recordforge/domain"
import type { AnnotationClip, ImageClip, ProjectAsset } from "@recordforge/contracts"
import { projectAssetSchema } from "@recordforge/contracts"
import {
  createAddAnnotationClipCommand,
  createAddExternalAudioClipCommand,
  createAddImageClipCommand,
  createAddTextClipCommand,
  createAnnotationClip,
  createTextClipFromPreset,
  createEngine,
  createOverlayTransaction,
  executeCommand,
  rotateOverlayTransform,
  undoCommand,
  redoCommand,
  resolvePreviewComposition,
} from "./index"

function makeEmptyProjectState(): { state: TimelineState; assets: ProjectAsset[] } {
  const now = "2026-08-17T00:00:00.000Z"
  const assets: ProjectAsset[] = [
    projectAssetSchema.parse({
      id: "asset:bg-music",
      path: "audio/upbeat-corporate.mp3",
      role: "music",
      kind: "audio",
      importStrategy: "copy",
      contentHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      derivativeVersion: 1,
      derivatives: { waveform: "derivatives/bg-music-waveform.png" },
      durationMs: 30_000,
      hasAudio: true,
      status: "available",
    }),
    projectAssetSchema.parse({
      id: "asset:brand-logo",
      path: "images/brand-logo.png",
      role: "graphic",
      kind: "image",
      importStrategy: "copy",
      contentHash: "8743b52063cd84097a65d1633f5c74f5",
      derivativeVersion: 1,
      derivatives: { thumbnail: "derivatives/brand-logo-thumb.png" },
      durationMs: 0,
      hasAudio: false,
      status: "available",
    }),
  ]

  const state: TimelineState = {
    version: 1,
    id: "phase8-e2e-project",
    name: "Full E2E Pipeline Project",
    recordingId: "rec-e2e-001",
    canvas: {
      width: 1920,
      height: 1080,
      fps: 60,
      background: "#0f172a",
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
            id: "screen-main",
            kind: "screen",
            assetId: "rec-e2e-001",
            startMs: 0,
            durationMs: 30_000,
            sourceInMs: 0,
            sourceOutMs: 30_000,
            speed: 1,
          },
        ],
      },
      {
        id: "track:audio",
        kind: "audio",
        name: "Background Music",
        muted: false,
        locked: false,
        solo: false,
        volume: 0.7,
        clips: [],
      },
      {
        id: "track:graphics",
        kind: "graphics",
        name: "Graphics Overlay",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [],
      },
      {
        id: "track:annotations",
        kind: "annotations",
        name: "Annotations",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [],
      },
      {
        id: "track:titles",
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

  return { state, assets }
}

describe("Phase 8 End-to-End lifecycle: import -> overlay -> transform -> evaluate", () => {
  it("executes the entire lifecycle from asset import to interactive overlay editing and preview composition", () => {
    const { state, assets } = makeEmptyProjectState()
    expect(assets.length).toBe(2)
    let engine = createEngine(state)

    // 1. Add imported audio asset to audio track
    const addAudioRes = executeCommand(
      engine,
      createAddExternalAudioClipCommand("asset:bg-music", 0, 25_000, {
        role: "music",
        trackId: "track:audio",
      }),
    )
    expect(addAudioRes.ok).toBe(true)
    if (addAudioRes.ok) engine = addAudioRes.value

    // 2. Add imported image asset to graphics track
    const imageClip: ImageClip = {
      id: "img-logo-1",
      kind: "image",
      assetId: "asset:brand-logo",
      startMs: 2_000,
      durationMs: 15_000,
      x: 100,
      y: 100,
      width: 240,
      height: 180,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
      zIndex: 1,
      opacity: 1.0,
      borderRadius: 12,
      borderWidth: 2,
      borderColor: "#38bdf8",
      shadowEnabled: true,
      shadowColor: "rgba(0,0,0,0.5)",
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
      sourceInMs: 0,
      sourceOutMs: 15_000,
      speed: 1,
    }
    const addImageRes = executeCommand(
      engine,
      createAddImageClipCommand(imageClip, "track:graphics"),
    )
    expect(addImageRes.ok).toBe(true)
    if (addImageRes.ok) engine = addImageRes.value

    // 3. Add Callout annotation shape
    const calloutClip = createAnnotationClip("callout", {
      startMs: 3_000,
      durationMs: 8_000,
      canvasWidth: 1920,
      canvasHeight: 1080,
    })
    calloutClip.id = "ann-callout-1"
    calloutClip.x = 400
    calloutClip.y = 300
    calloutClip.width = 360
    calloutClip.height = 140
    calloutClip.text = "Check this new feature!"
    calloutClip.strokeColor = "#f59e0b"
    calloutClip.fillColor = "#f59e0b"
    calloutClip.fillOpacity = 0.2
    calloutClip.zIndex = 10

    const addCalloutRes = executeCommand(
      engine,
      createAddAnnotationClipCommand(calloutClip, "track:annotations"),
    )
    expect(addCalloutRes.ok).toBe(true)
    if (addCalloutRes.ok) engine = addCalloutRes.value

    // 4. Add Title preset
    const titleClip = createTextClipFromPreset("title-cinematic-bold", {
      startMs: 1_000,
      durationMs: 6_000,
      canvasWidth: 1920,
      canvasHeight: 1080,
    })
    titleClip.id = "text-title-1"
    titleClip.primaryText = "RECORD FORGE PRO"
    titleClip.secondaryText = "Next-gen Local-First Screen Recording"
    titleClip.tagText = "RELEASE V1"
    titleClip.x = 200
    titleClip.y = 700
    titleClip.zIndex = 20

    const addTitleRes = executeCommand(engine, createAddTextClipCommand(titleClip, "track:titles"))
    expect(addTitleRes.ok).toBe(true)
    if (addTitleRes.ok) engine = addTitleRes.value

    // Verify all tracks populated
    expect(engine.history.present.tracks.find((t) => t.id === "track:audio")?.clips.length).toBe(1)
    expect(engine.history.present.tracks.find((t) => t.id === "track:graphics")?.clips.length).toBe(
      1,
    )
    expect(
      engine.history.present.tracks.find((t) => t.id === "track:annotations")?.clips.length,
    ).toBe(1)
    expect(engine.history.present.tracks.find((t) => t.id === "track:titles")?.clips.length).toBe(1)

    // Verify domain schema contract compliance
    expect(() => timelineStateSchema.parse(engine.history.present)).not.toThrow()

    // 5. Perform interactive gesture transaction (rotate callout)
    const transaction = createOverlayTransaction()
    transaction.begin(engine.history.present, {
      kind: "rotate",
      clipId: calloutClip.id,
      transform: {
        x: calloutClip.x,
        y: calloutClip.y,
        width: calloutClip.width,
        height: calloutClip.height,
        rotation: calloutClip.rotation,
        anchorX: calloutClip.anchorX,
        anchorY: calloutClip.anchorY,
        zIndex: calloutClip.zIndex,
        opacity: calloutClip.opacity,
      },
    })

    const pivot = {
      x: calloutClip.x + calloutClip.width * 0.5,
      y: calloutClip.y + calloutClip.height * 0.5,
    }
    const startPoint = { x: pivot.x, y: pivot.y - 100 }
    const rad = (15 * Math.PI) / 180
    const currentPoint = {
      x: pivot.x + 100 * Math.sin(rad),
      y: pivot.y - 100 * Math.cos(rad),
    }

    const rotatedTransform = rotateOverlayTransform(
      transaction.draft!.transform,
      startPoint,
      currentPoint,
      15,
    )
    transaction.update({
      kind: "rotate",
      clipId: calloutClip.id,
      transform: rotatedTransform,
    })

    const commitRes = transaction.commit()
    expect(commitRes.ok).toBe(true)
    if (commitRes.ok) {
      const execRotate = executeCommand(engine, commitRes.value.command)
      expect(execRotate.ok).toBe(true)
      if (execRotate.ok) engine = execRotate.value
    }

    const updatedCallout = engine.history.present.tracks
      .find((t) => t.id === "track:annotations")
      ?.clips.find((c) => c.id === calloutClip.id) as AnnotationClip
    expect(updatedCallout.rotation).toBe(15)

    // 6. Test Undo and Redo of transaction
    const undoRes = undoCommand(engine)
    expect(undoRes.ok).toBe(true)
    if (undoRes.ok) engine = undoRes.value
    const revertedCallout = engine.history.present.tracks
      .find((t) => t.id === "track:annotations")
      ?.clips.find((c) => c.id === calloutClip.id) as AnnotationClip
    expect(revertedCallout.rotation).toBe(0)

    const redoRes = redoCommand(engine)
    expect(redoRes.ok).toBe(true)
    if (redoRes.ok) engine = redoRes.value
    const restoredCallout = engine.history.present.tracks
      .find((t) => t.id === "track:annotations")
      ?.clips.find((c) => c.id === calloutClip.id) as AnnotationClip
    expect(restoredCallout.rotation).toBe(15)

    // 7. Preview composition multi-timestamp evaluation
    // At t = 500ms: only screen and audio active
    const comp500 = resolvePreviewComposition(engine.history.present, 500)
    expect(comp500.screen.active).toBe(true)
    expect(comp500.annotations.some((a) => a.active)).toBe(false)
    expect(comp500.images.some((img) => img.active)).toBe(false)

    // At t = 2500ms: title (1k-7k), image (2k-17k), audio (0-25k) active
    const comp2500 = resolvePreviewComposition(engine.history.present, 2500)
    expect(comp2500.screen.active).toBe(true)
    expect(comp2500.images.find((img) => img.clip.id === imageClip.id)?.active).toBe(true)
    expect(comp2500.texts.find((txt) => txt.clip.id === titleClip.id)?.active).toBe(true)
    expect(comp2500.annotations.some((a) => a.active)).toBe(false)

    // At t = 4000ms: callout (3k-11k), title (1k-7k), image (2k-17k) all active
    const comp4000 = resolvePreviewComposition(engine.history.present, 4000)
    expect(comp4000.annotations.find((a) => a.clip.id === calloutClip.id)?.active).toBe(true)
    expect(comp4000.images.find((img) => img.clip.id === imageClip.id)?.active).toBe(true)
    expect(comp4000.texts.find((txt) => txt.clip.id === titleClip.id)?.active).toBe(true)
  })
})
