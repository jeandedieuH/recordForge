import { describe, expect, it } from "vitest"
import { defaultCursorSettings, type TimelineCanvas } from "@recordforge/contracts"
import {
  analyzeCursorTelemetry,
  generateSmartZoomSuggestions,
  normalizeCursorTelemetry,
} from "./index"

const canvas: TimelineCanvas = {
  width: 1920,
  height: 1080,
  fps: 30,
  background: "#000000",
  padding: 48,
  borderRadius: 0,
  shadow: false,
  cursorSettings: defaultCursorSettings,
}

const telemetry = normalizeCursorTelemetry({
  recordingId: "recording",
  sourceWidth: 1920,
  sourceHeight: 1080,
  events: [
    { tMs: 0, x: 200, y: 180 },
    { tMs: 100, x: 960, y: 540, clicked: true, button: "left", buttonEvent: "down" },
    { tMs: 500, x: 960, y: 540 },
    { tMs: 1_200, x: 960, y: 540 },
    { tMs: 1_500, x: 1_700, y: 900 },
    { tMs: 2_000, x: 1_900, y: 1_060, clicked: true, button: "right", buttonEvent: "down" },
  ],
})

describe("smart zoom telemetry analysis", () => {
  it("extracts click, dwell, movement, and safe-edge features", () => {
    const features = analyzeCursorTelemetry(telemetry, { minDwellMs: 500 })

    expect(features.clicks).toHaveLength(2)
    expect(features.dwells).toEqual([
      expect.objectContaining({ startMs: 100, endMs: 1_200, durationMs: 1_100 }),
    ])
    expect(features.movements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ startMs: 1_200, endMs: 1_500 }),
        expect.objectContaining({ startMs: 1_500, endMs: 2_000 }),
      ]),
    )
    expect(features.safeEdges[features.safeEdges.length - 1]).toEqual(
      expect.objectContaining({ nearRight: true, nearBottom: true }),
    )
  })

  it("generates aspect-ratio-aware, canvas-safe editable suggestions", () => {
    const suggestions = generateSmartZoomSuggestions(telemetry, canvas, {
      preset: "product-demo",
      minDwellMs: 500,
    })

    expect(suggestions.length).toBeGreaterThan(0)
    expect(suggestions.some((segment) => segment.source === "click")).toBe(true)
    expect(suggestions.some((segment) => segment.source === "dwell")).toBe(true)
    for (const segment of suggestions) {
      expect(segment.mode).toBe("auto")
      expect(segment.locked).toBe(false)
      expect(segment.target.x).toBeGreaterThanOrEqual(canvas.padding)
      expect(segment.target.y).toBeGreaterThanOrEqual(canvas.padding)
      expect(segment.target.x + segment.target.width).toBeLessThanOrEqual(
        canvas.width - canvas.padding,
      )
      expect(segment.target.y + segment.target.height).toBeLessThanOrEqual(
        canvas.height - canvas.padding,
      )
      expect(segment.target.width / segment.target.height).toBeCloseTo(
        canvas.width / canvas.height,
        5,
      )
    }
  })

  it("returns no suggestions when the manual-only preset is selected", () => {
    expect(generateSmartZoomSuggestions(telemetry, canvas, { preset: "manual-only" })).toEqual([])
  })
})
