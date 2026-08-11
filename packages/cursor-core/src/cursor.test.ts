import { describe, expect, it } from "vitest"
import {
  cursorRangeOverrideLabels,
  findCursorEventAtTime,
  fitCursorPoint,
  isCursorButtonEnabled,
  isCursorIdle,
  normalizeCursorTelemetry,
  timelineToCursorSourceTime,
  zoomSegmentBadges,
} from "./index"
import {
  defaultCursorSettings,
  type CursorEffectClip,
  type ManualZoomSegment,
  type TimelineState,
} from "@recordforge/contracts"

const telemetry = normalizeCursorTelemetry({
  recordingId: "recording",
  sourceWidth: 1024,
  sourceHeight: 768,
  events: [
    { tMs: 0, x: 10, y: 20, button: "none", clicked: false },
    { tMs: 100, x: 20, y: 30, button: "left", buttonEvent: "down", clicked: true },
    { tMs: 200, x: 20, y: 30, button: "left", buttonEvent: "held", clicked: false },
  ],
})

describe("cursor-core", () => {
  it("normalizes legacy telemetry with stable metadata", () => {
    expect(telemetry.assetId).toBe("cursor-events:recording")
    expect(telemetry.schemaVersion).toBe(1)
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
      presetId: "sleek-dark",
      scale: 1.5,
      smoothing: "off" as const,
      settings: { clickFeedback: "spotlight" as const },
    } satisfies CursorEffectClip
    const labels = cursorRangeOverrideLabels(range, base)
    const keys = labels.map((label) => label.key)
    expect(keys).toContain("locked")
    expect(keys).toContain("hidden")
    expect(keys).toContain("preset")
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

  it("produces zoom segment source and lock badges", () => {
    const segment = {
      id: "zoom",
      startMs: 0,
      durationMs: 1000,
      target: { x: 0, y: 0, width: 100, height: 100 },
      scale: 1,
      easing: "ease-in-out" as const,
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
