import { describe, expect, it } from "vitest"
import { recommendedCursorSettings, type TimelineState } from "@recordforge/domain"
import { LOOK_PRESET_CATALOG, applyLookToState } from "./looks"

function makeState(): TimelineState {
  const now = "2026-11-20T00:00:00.000Z"
  return {
    version: 1,
    id: "looks-project",
    name: "Looks",
    recordingId: "recording",
    canvas: {
      width: 1920,
      height: 1080,
      fps: 30,
      background: "#000000",
      padding: 0,
      borderRadius: 0,
      shadow: false,
      cursorSettings: recommendedCursorSettings,
    },
    tracks: [],
    markers: [],
    zoomSegments: [],
    createdAt: now,
    updatedAt: now,
  }
}

describe("LOOK_PRESET_CATALOG cursor stroke bounds", () => {
  it("never sets cursor stroke width above 1.5px in any built-in look", () => {
    const base = makeState()
    expect(base.canvas.cursorSettings.strokeWidth).toBe(1.0)

    for (const preset of LOOK_PRESET_CATALOG.presets) {
      const strokeWidth = preset.definition.cursor.strokeWidth
      if (strokeWidth !== undefined) {
        expect(strokeWidth).toBeLessThanOrEqual(1.5)
      }
      const next = applyLookToState(base, preset.definition)
      expect(next.canvas.cursorSettings.strokeWidth).toBeLessThanOrEqual(1.5)
    }
  })
})
