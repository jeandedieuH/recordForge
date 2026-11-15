import { describe, expect, it } from "vitest"
import type { VideoClip } from "@recordforge/contracts"
import {
  VIDEO_SCALE_START,
  videoLayerAnimationRamps,
  videoLayerBaseRect,
  videoLayerPose,
  videoLayerPoseAt,
  videoLayerSourceMs,
} from "./video-layers"

const CANVAS = { width: 1920, height: 1080 }

function clip(overrides: Partial<VideoClip> = {}): VideoClip {
  return {
    id: "clip",
    kind: "video",
    assetId: "asset",
    startMs: 1_000,
    durationMs: 4_000,
    sourceInMs: 2_000,
    sourceOutMs: 6_000,
    speed: 1,
    x: 200,
    y: 100,
    width: 800,
    height: 450,
    rotation: 0,
    anchorX: 0.5,
    anchorY: 0.5,
    zIndex: 0,
    opacity: 1,
    borderRadius: 0,
    borderWidth: 0,
    borderColor: "#ffffff",
    shadowEnabled: false,
    shadowColor: "rgba(0, 0, 0, 0.5)",
    shadowBlur: 10,
    fit: "contain",
    layoutMode: "overlay",
    animationIn: "fade",
    animationOut: "fade",
    animationMs: 400,
    volume: 1,
    audioMuted: false,
    fadeInMs: 0,
    fadeOutMs: 0,
    enabled: true,
    locked: false,
    ...overrides,
  }
}

describe("video layer pose", () => {
  it("covers the canvas in fullscreen and clamps offset layers", () => {
    expect(videoLayerBaseRect(clip({ layoutMode: "fullscreen" }), CANVAS)).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    })
    // An off-canvas rect is pulled back inside the canvas.
    expect(videoLayerBaseRect(clip({ x: 1800 }), CANVAS).x).toBe(1920 - 800)
    expect(videoLayerBaseRect(clip({ x: 5000, y: 900 }), CANVAS)).toEqual({
      x: 1120,
      y: 630,
      width: 800,
      height: 450,
    })
  })

  it("caps animation ramps at half the clip duration", () => {
    expect(videoLayerAnimationRamps(clip({ animationMs: 400 }), 4_000)).toEqual({
      inMs: 400,
      outMs: 400,
    })
    expect(videoLayerAnimationRamps(clip({ animationMs: 5_000 }), 1_000)).toEqual({
      inMs: 500,
      outMs: 500,
    })
    expect(
      videoLayerAnimationRamps(clip({ animationIn: "none", animationOut: "fade" }), 4_000),
    ).toEqual({ inMs: 0, outMs: 400 })
  })

  it("fades in and out through the clip", () => {
    const value = clip()
    expect(videoLayerPoseAt(value, CANVAS, 1_000).opacity).toBeCloseTo(0, 5)
    expect(videoLayerPoseAt(value, CANVAS, 1_400).opacity).toBeCloseTo(1, 5)
    expect(videoLayerPoseAt(value, CANVAS, 3_000).opacity).toBeCloseTo(1, 5)
    expect(videoLayerPoseAt(value, CANVAS, 5_000).opacity).toBeCloseTo(0, 5)
  })

  it("scales about the rect center", () => {
    const value = clip({ animationIn: "scale", animationOut: "none" })
    const posed = videoLayerPose(value, CANVAS, 0, 0)
    expect(posed.rect.width).toBeCloseTo(800 * VIDEO_SCALE_START, 5)
    expect(posed.rect.x + posed.rect.width / 2).toBeCloseTo(200 + 400, 5)
    expect(posed.rect.y + posed.rect.height / 2).toBeCloseTo(100 + 225, 5)
  })

  it("slides up into place and back out", () => {
    const value = clip({ animationIn: "slide", animationOut: "slide" })
    const entering = videoLayerPose(value, CANVAS, 0, 0)
    expect(entering.rect.y).toBeGreaterThan(100)
    const holding = videoLayerPose(value, CANVAS, 1, 0)
    expect(holding.rect.y).toBeCloseTo(100, 5)
    const leaving = videoLayerPose(value, CANVAS, 1, 1)
    expect(leaving.rect.y).toBeLessThan(100)
  })

  it("maps timeline time to source time through clip speed", () => {
    expect(videoLayerSourceMs(clip(), 2_000)).toBe(3_000)
    expect(videoLayerSourceMs(clip({ speed: 2 }), 2_000)).toBe(4_000)
    // Before the clip starts the source stays pinned at the in point.
    expect(videoLayerSourceMs(clip(), 0)).toBe(2_000)
  })
})
