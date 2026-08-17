import { describe, expect, it } from "vitest"
import {
  defaultCursorSettings,
  type OverlayTransform,
  type TimelineState,
} from "@recordforge/domain"
import {
  applyCommand,
  buildOverlayCommand,
  constrainOverlayTransform,
  createAddAnnotationClipCommand,
  createAnnotationClip,
  createEngine,
  createOverlayTransaction,
  getOverlayBounds,
  overlayTransformFromClip,
  resizeOverlayTransform,
  rotateOverlayTransform,
  snapOverlayPoint,
} from "./index"

function makeTimeline(): TimelineState {
  const now = "2026-08-17T00:00:00.000Z"
  return {
    version: 1,
    id: "overlay-project",
    name: "Overlay project",
    recordingId: "recording-1",
    canvas: {
      width: 1_920,
      height: 1_080,
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
            id: "screen-clip",
            kind: "screen",
            assetId: "recording-1",
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
    createdAt: now,
    updatedAt: now,
  }
}

function addAnnotation() {
  const engine = createEngine(makeTimeline())
  const clip = createAnnotationClip("rectangle", {
    startMs: 0,
    durationMs: 4_000,
    canvasWidth: 1_920,
    canvasHeight: 1_080,
  })
  const result = applyCommand(engine.history.present, createAddAnnotationClipCommand(clip))
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error.message)
  return { timeline: result.value, clip }
}

describe("overlay interaction transaction", () => {
  it("builds one validated transform command and leaves the base unchanged", () => {
    const { timeline, clip } = addAnnotation()
    const transaction = createOverlayTransaction()
    const transform: OverlayTransform = {
      x: 320,
      y: 240,
      width: 420,
      height: 260,
      rotation: 30,
      anchorX: 0.5,
      anchorY: 0.5,
      zIndex: 4,
      opacity: 0.75,
    }

    transaction.begin(timeline, { kind: "move", clipId: clip.id, transform })
    expect(transaction.preview.valid).toBe(true)
    const result = transaction.commit()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.command.kind).toBe("update-annotation-clip")
    expect(timeline.tracks[1]?.clips[0]).toMatchObject({ x: clip.x, y: clip.y })

    const applied = applyCommand(timeline, result.value.command)
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    expect(applied.value.tracks[1]?.clips[0]).toMatchObject({
      x: 320,
      y: 240,
      width: 420,
      height: 260,
      rotation: 30,
      zIndex: 4,
      opacity: 0.75,
    })
  })

  it("cancels a draft without producing a command", () => {
    const { timeline, clip } = addAnnotation()
    const transaction = createOverlayTransaction()
    transaction.begin(timeline, {
      kind: "resize",
      clipId: clip.id,
      transform: overlayTransformFromClip(clip),
    })
    transaction.update({
      kind: "resize",
      clipId: clip.id,
      transform: {
        x: 40,
        y: 40,
        width: 600,
        height: 360,
        rotation: 0,
        anchorX: 0.5,
        anchorY: 0.5,
        zIndex: 0,
        opacity: 1,
      },
    })
    transaction.cancel()

    expect(transaction.phase).toBe("cancelled")
    expect(transaction.preview.state).toBeNull()
    expect(timeline.tracks[1]?.clips[0]).toMatchObject({ width: clip.width, height: clip.height })
  })

  it("updates an arrow endpoint without moving the arrow body", () => {
    const engine = createEngine(makeTimeline())
    const clip = createAnnotationClip("arrow", {
      startMs: 0,
      durationMs: 4_000,
      canvasWidth: 1_920,
      canvasHeight: 1_080,
    })
    const added = applyCommand(engine.history.present, createAddAnnotationClipCommand(clip))
    expect(added.ok).toBe(true)
    if (!added.ok) return

    const result = buildOverlayCommand(
      {
        kind: "arrow-end",
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
        endX: 900,
        endY: 500,
      },
      added.value,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const updated = applyCommand(added.value, result.value.command)
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect(updated.value.tracks[1]?.clips[0]).toMatchObject({
      x: clip.x,
      y: clip.y,
      endX: 900,
      endY: 500,
    })
  })
})

describe("overlay transform constraints", () => {
  const start: OverlayTransform = {
    x: 100,
    y: 100,
    width: 200,
    height: 100,
    rotation: 0,
    anchorX: 0.5,
    anchorY: 0.5,
    zIndex: 0,
    opacity: 1,
  }

  it("supports every resize handle while enforcing minimum dimensions", () => {
    for (const handle of ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const) {
      const next = resizeOverlayTransform(start, handle, -1_000, -1_000, {
        minWidth: 20,
        minHeight: 20,
      })
      expect(next.width).toBeGreaterThanOrEqual(20)
      expect(next.height).toBeGreaterThanOrEqual(20)
    }
  })

  it("snaps endpoint coordinates while allowing modifier-based opt out", () => {
    expect(snapOverlayPoint({ x: 101, y: 102 })).toEqual({ x: 104, y: 104 })
    expect(snapOverlayPoint({ x: 101, y: 102 }, { disabled: true })).toEqual({ x: 101, y: 102 })
  })

  it("snaps rotation to fifteen degree increments and includes rotated bounds", () => {
    const rotated = rotateOverlayTransform(start, { x: 200, y: 50 }, { x: 250, y: 100 })
    expect(rotated.rotation % 15).toBe(0)

    const constrained = constrainOverlayTransform(
      { ...rotated, x: -1_000, y: -1_000 },
      1_920,
      1_080,
    )
    const bounds = getOverlayBounds(constrained)
    expect(bounds.minX).toBeGreaterThanOrEqual(-bounds.width * 0.25 - 0.001)
    expect(bounds.minY).toBeGreaterThanOrEqual(-bounds.height * 0.25 - 0.001)
  })
})
