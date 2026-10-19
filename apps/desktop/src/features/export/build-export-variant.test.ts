import { describe, expect, it } from "vitest"
import type { CanvasAspectRatio, TimelineState } from "@recordforge/contracts"
import { createEngine } from "@recordforge/editor-core"
import { buildExportVariant } from "./build-export-variant"

// Frozen-state export variant seam: current aspect returns state untouched,
// alternates reflow through the canvas-switch command on a throwaway engine.

const ASPECTS: CanvasAspectRatio[] = ["16:9", "9:16", "1:1", "4:5", "5:4"]

function timeline(aspect: CanvasAspectRatio, width = 1920, height = 1080): TimelineState {
  return {
    version: 1,
    id: "tl-1",
    name: "Demo",
    recordingId: "rec-1",
    canvas: {
      width,
      height,
      fps: 30,
      background: "#000000",
      padding: 0,
      borderRadius: 0,
      shadow: false,
      cursorSettings: { pointerStyle: "arrow", scale: 1, rippleEnabled: true },
      aspectRatio: aspect,
    },
    tracks: [],
    markers: [],
    updatedAt: "2026-01-01T00:00:00Z",
  } as unknown as TimelineState
}

describe("buildExportVariant", () => {
  it("every supported aspect produces a variant with exact target dimensions", () => {
    // Base 1280x720 → the short edge stays 720 in every alternate frame;
    // normalization through the resolution tier (1080 min) must NOT kick in.
    const state = timeline("16:9", 1280, 720)
    const expected: Record<CanvasAspectRatio, [number, number]> = {
      "16:9": [1280, 720],
      "9:16": [720, 1280],
      "1:1": [720, 720],
      "4:5": [720, 900],
      "5:4": [900, 720],
    }
    for (const aspect of ASPECTS) {
      const variant = buildExportVariant({ state, aspect, cameraSources: {} })
      expect(variant.ok, `aspect ${aspect}`).toBe(true)
      if (variant.ok) {
        const [w, h] = expected[aspect]
        expect(variant.value.canvas.aspectRatio).toBe(aspect)
        expect(variant.value.canvas.width, `width ${aspect}`).toBe(w)
        expect(variant.value.canvas.height, `height ${aspect}`).toBe(h)
      }
    }
  })

  it("returns the current state object UNCHANGED for the current aspect", () => {
    const state = timeline("16:9")
    const variant = buildExportVariant({ state, aspect: "16:9", cameraSources: {} })
    expect(variant.ok).toBe(true)
    if (variant.ok) {
      // Identity — custom canvas pixels are preserved verbatim, never
      // re-derived through the aspect table.
      expect(variant.value).toBe(state)
    }
  })

  it("preserves custom dimensions of the current aspect verbatim", () => {
    // A bespoke 1400x900 canvas labeled 16:9 must not be normalized to 1920x1080.
    const state = timeline("16:9", 1400, 900)
    const variant = buildExportVariant({ state, aspect: "16:9", cameraSources: {} })
    expect(variant.ok).toBe(true)
    if (variant.ok) {
      expect(variant.value.canvas.width).toBe(1400)
      expect(variant.value.canvas.height).toBe(900)
    }
  })

  it("alternate aspects get the target's standard frame", () => {
    const state = timeline("16:9", 1920, 1080)
    const variant = buildExportVariant({ state, aspect: "9:16", cameraSources: {} })
    expect(variant.ok).toBe(true)
    if (variant.ok) {
      expect(variant.value.canvas.aspectRatio).toBe("9:16")
      // Vertical frame: height is the long edge now.
      expect(variant.value.canvas.height).toBeGreaterThan(variant.value.canvas.width)
    }
  })

  it("never mutates the caller's engine/history", () => {
    const state = timeline("16:9")
    const engine = createEngine(state)
    const presentBefore = engine.history.present
    const variant = buildExportVariant({ state, aspect: "9:16", cameraSources: {} })
    expect(variant.ok).toBe(true)
    expect(engine.history.present).toBe(presentBefore)
    expect(engine.history.present.canvas.aspectRatio).toBe("16:9")
    // The source state object wasn't mutated in place either.
    expect(state.canvas.aspectRatio).toBe("16:9")
    expect(state.canvas.width).toBe(1920)
  })

  it("camera clips reflow to a source-correct crop at the new frame", () => {
    const base = timeline("16:9", 1280, 720)
    const originalTransform = {
      x: 1100,
      y: 620,
      width: 200,
      height: 100,
      crop: { x: 280, y: 0, width: 720, height: 720 },
      opacity: 1,
      shape: "rectangle" as const,
    }
    const withCamera: TimelineState = {
      ...base,
      tracks: [
        {
          id: "camera",
          kind: "camera",
          name: "Camera",
          muted: false,
          locked: false,
          solo: false,
          volume: 1,
          clips: [
            {
              id: "cam-1",
              kind: "camera",
              assetId: "asset-cam",
              startMs: 0,
              durationMs: 5000,
              sourceInMs: 0,
              sourceOutMs: 5000,
              speed: 1,
              transform: originalTransform,
            },
          ],
        },
      ],
    } as unknown as TimelineState
    const engine = createEngine(withCamera)
    const historyBefore = engine.history.present
    const variant = buildExportVariant({
      state: withCamera,
      aspect: "1:1",
      // cameraSources is keyed by CLIP id, not asset id — a wrong key means
      // the reflow silently falls back to 1280x720 defaults.
      cameraSources: { "cam-1": { width: 1280, height: 720 } },
    })
    expect(variant.ok).toBe(true)
    if (!variant.ok) return
    const clip = variant.value.tracks[0]?.clips[0]
    expect(clip?.kind).toBe("camera")
    const transform = clip && "transform" in clip ? clip.transform : undefined
    expect(transform).toBeDefined()
    // circle-pip on a 1:1 canvas crops the 1280x720 source to a centered
    // 720x720 window in SOURCE space: (1280-720)/2 = 280, y = 0.
    expect(transform?.crop).toEqual({ x: 280, y: 0, width: 720, height: 720 })
    // The canvas-space bounds fit inside the 720x720 target frame.
    expect(transform?.x).toBeGreaterThanOrEqual(0)
    expect(transform?.y).toBeGreaterThanOrEqual(0)
    expect((transform?.x ?? 0) + (transform?.width ?? 0)).toBeLessThanOrEqual(720)
    expect((transform?.y ?? 0) + (transform?.height ?? 0)).toBeLessThanOrEqual(720)
    // The throwaway reflow left the caller's engine/history/transform alone.
    expect(engine.history.present).toBe(historyBefore)
    const sourceClip = engine.history.present.tracks[0]?.clips[0]
    expect(sourceClip && "transform" in sourceClip ? sourceClip.transform : null).toEqual(
      originalTransform,
    )
  })
})
