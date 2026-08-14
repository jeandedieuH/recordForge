import { describe, expect, it } from "vitest"
import {
  cursorRangeOverrideLabels,
  findCursorEventAtTime,
  fitCursorPoint,
  isCursorButtonEnabled,
  isCursorIdle,
  normalizeCursorTelemetry,
  resolveCursorAsset,
  timelineToCursorSourceTime,
  zoomSegmentBadges,
} from "./index"
import {
  defaultCursorSettings,
  type CursorEffectClip,
  type ManualZoomSegment,
  type TimelineState,
} from "@recordforge/contracts"

const buttons = (left: boolean, right = false, middle = false) => ({
  left,
  right,
  middle,
  x1: false,
  x2: false,
})

const v2Event = (
  tMs: number,
  x: number,
  y: number,
  buttonEvent: string,
  isLeft = false,
  isRight = false,
  isMiddle = false,
) => ({
  tMs,
  rawX: x,
  rawY: y,
  sourceX: x,
  sourceY: y,
  buttons: buttons(isLeft, isRight, isMiddle),
  buttonEvent,
  visible: true,
  shapeId: "arrow",
  shapeChanged: false,
})

const telemetry = normalizeCursorTelemetry({
  recordingId: "recording",
  sourceWidth: 1024,
  sourceHeight: 768,
  events: [
    v2Event(0, 10, 20, "none"),
    v2Event(100, 20, 30, "left-down", true),
    v2Event(200, 20, 30, "left-held", true),
  ],
})

describe("cursor-core", () => {
  it("normalizes v2 telemetry with stable metadata", () => {
    expect(telemetry.assetId).toBe("cursor-events:recording")
    expect(telemetry.schemaVersion).toBe(2)
    expect(telemetry.captureBounds.width).toBe(1024)
  })

  it("looks up the nearest event with a deterministic tie break", () => {
    expect(findCursorEventAtTime(telemetry, 150)?.event.tMs).toBe(100)
    expect(findCursorEventAtTime(telemetry, 190)?.event.tMs).toBe(200)
  })

  it("distinguishes a down edge from a held sample", () => {
    expect(isCursorButtonEnabled(telemetry.events[1], defaultCursorSettings)).toBe(true)
    expect(isCursorButtonEnabled(telemetry.events[2], defaultCursorSettings)).toBe(false)
  })

  it("fits non-16:9 sources without stretching", () => {
    const result = fitCursorPoint({ x: 1024, y: 768 }, telemetry, 1920, 1080)
    expect(result.scale).toBe(1.40625)
    expect(result.x).toBeCloseTo(1680)
    expect(result.y).toBeCloseTo(1080)
  })

  it("clamps partially out-of-bounds coordinates to the source edge", () => {
    const result = fitCursorPoint({ x: -20, y: 900 }, telemetry, 1024, 768)
    expect(result.wasClamped).toBe(true)
    expect(result.sourceX).toBe(0)
    expect(result.sourceY).toBe(768)
  })

  it("labels cursor range overrides against the project profile", () => {
    const base = defaultCursorSettings
    const range = {
      id: "range",
      kind: "cursor-effect" as const,
      assetId: "cursor",
      startMs: 0,
      durationMs: 1000,
      sourceInMs: 0,
      sourceOutMs: 0,
      speed: 1,
      enabled: false,
      locked: true,
      presetId: "recorded-system",
      scale: 1.5,
      smoothing: "off" as const,
      settings: { clickFeedback: "spotlight" as const },
    } satisfies CursorEffectClip
    const labels = cursorRangeOverrideLabels(range, base)
    const keys = labels.map((label) => label.key)
    expect(keys).toContain("locked")
    expect(keys).toContain("hidden")
    expect(keys).toContain("scale")
    expect(keys).toContain("smoothing")
    expect(keys).toContain("click")
  })

  it("returns empty cursor range labels when the range inherits the project profile", () => {
    const range = {
      id: "range",
      kind: "cursor-effect" as const,
      assetId: "cursor",
      startMs: 0,
      durationMs: 1000,
      sourceInMs: 0,
      sourceOutMs: 0,
      speed: 1,
      enabled: true,
      locked: false,
      presetId: defaultCursorSettings.preset,
      scale: defaultCursorSettings.scale,
      smoothing: defaultCursorSettings.smoothMovement ? "smooth" : ("off" as const),
      settings: {},
    } satisfies CursorEffectClip
    expect(cursorRangeOverrideLabels(range, defaultCursorSettings)).toHaveLength(0)
  })

  it("maps a known recorded shape id to the generic shape asset", () => {
    const asset = resolveCursorAsset("hand", "recorded-system", { shapeMode: "optimized" })
    expect(asset.id).toBe("shape-hand")
    expect(asset.effectiveId).toBe("shape-hand")
  })

  it("falls back to the recorded system arrow for unknown shape ids", () => {
    const asset = resolveCursorAsset("unknown-shape", "recorded-system", { shapeMode: "optimized" })
    expect(asset.id).toBe("recorded-system")
    expect(asset.effectiveId).toBe("recorded-system")
  })

  it("honors literal manifest ids in recorded shape mode", () => {
    const asset = resolveCursorAsset("shape-arrow", "recorded-system", { shapeMode: "recorded" })
    expect(asset.id).toBe("shape-arrow")
    expect(asset.effectiveId).toBe("shape-arrow")

    const fallback = resolveCursorAsset("hand", "recorded-system", { shapeMode: "recorded" })
    expect(fallback.id).toBe("shape-hand")
  })

  it("uses the recorded system preset asset when shape mode is preset", () => {
    const asset = resolveCursorAsset("hand", "recorded-system", { shapeMode: "preset" })
    expect(asset.id).toBe("recorded-system")
    expect(asset.effectiveId).toBe("recorded-system")
  })

  it("resolves the recorded system style to a shape-specific asset", () => {
    const asset = resolveCursorAsset("hand-32", "recorded-system", {
      shapes: [
        {
          shapeId: "hand-32",
          hotspotX: 0,
          hotspotY: 0,
          width: 32,
          height: 32,
          kind: "hand",
        },
      ],
    })
    expect(asset.id).toBe("shape-hand:hand-32")
    expect(asset.effectiveId).toBe("hand-32")
    expect(asset.width).toBe(32)
    expect(asset.height).toBe(32)
  })

  it("produces zoom segment source and lock badges", () => {
    const segment = {
      id: "zoom",
      startMs: 0,
      durationMs: 1000,
      target: { x: 0, y: 0, width: 100, height: 100 },
      scale: 1,
      easing: "ease-in-out" as const,
      transitionInMs: 400,
      transitionOutMs: 400,
      enabled: true,
      locked: true,
      mode: "auto" as const,
      source: "click" as const,
      preset: "product-demo" as const,
    } satisfies ManualZoomSegment
    const labels = zoomSegmentBadges(segment)
    const keys = labels.map((label) => label.key)
    expect(keys).toContain("locked")
    expect(keys).toContain("source")
    expect(keys).toContain("preset")
  })

  it("supports idle hiding and source mapping through a sped-up clip", () => {
    expect(isCursorIdle(telemetry, 2, 800, 500)).toBe(true)
    const state = {
      version: 1,
      id: "project",
      name: "Project",
      recordingId: "recording",
      canvas: {
        width: 1024,
        height: 768,
        fps: 30,
        background: "#000000",
        padding: 0,
        borderRadius: 0,
        shadow: false,
        cursorSettings: defaultCursorSettings,
      },
      tracks: [
        {
          id: "screen",
          kind: "screen",
          name: "Screen",
          muted: false,
          locked: false,
          solo: false,
          volume: 1,
          clips: [
            {
              id: "clip",
              kind: "screen",
              assetId: "recording",
              startMs: 1000,
              durationMs: 500,
              sourceInMs: 200,
              sourceOutMs: 450,
              speed: 0.5,
            },
          ],
        },
      ],
      markers: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    } satisfies TimelineState
    expect(timelineToCursorSourceTime(state, 1250)).toBe(325)
  })
})
