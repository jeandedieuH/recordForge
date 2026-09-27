import { describe, expect, it } from "vitest"
import { zoomPresetSchema } from "@recordforge/contracts"
import {
  FOLLOW_SPEED_SMOOTH_TIME_S,
  ZOOM_PRESETS,
  followSpeedSchemaValues,
  type FollowSpeed,
} from "./zoom-presets"

describe("zoom presets", () => {
  it("covers every schema preset exactly once", () => {
    const schemaValues = zoomPresetSchema.options
    expect(Object.keys(ZOOM_PRESETS).sort()).toEqual([...schemaValues].sort())
    for (const preset of schemaValues) {
      expect(ZOOM_PRESETS[preset].id).toBe(preset)
    }
  })

  it("keeps the settled scale and transition values per preset", () => {
    expect(ZOOM_PRESETS.subtle).toMatchObject({
      label: "Subtle",
      scale: 1.25,
      easing: "smooth",
      transitionInMs: 450,
      transitionOutMs: 450,
      clickDurationMs: 900,
      dwellTailMs: 450,
      followSpeed: "relaxed",
    })
    expect(ZOOM_PRESETS["product-demo"]).toMatchObject({
      label: "Product demo",
      scale: 1.5,
      easing: "smooth",
      transitionInMs: 450,
      transitionOutMs: 450,
      clickDurationMs: 1_200,
      dwellTailMs: 600,
      followSpeed: "balanced",
    })
    expect(ZOOM_PRESETS.cinematic).toMatchObject({
      label: "Cinematic",
      scale: 1.8,
      easing: "cinematic",
      transitionInMs: 700,
      transitionOutMs: 700,
      clickDurationMs: 1_800,
      dwellTailMs: 900,
      followSpeed: "relaxed",
    })
    expect(ZOOM_PRESETS.developer).toMatchObject({
      label: "Developer",
      scale: 2.2,
      easing: "smooth",
      transitionInMs: 320,
      transitionOutMs: 320,
      clickDurationMs: 1_400,
      dwellTailMs: 700,
      followSpeed: "tight",
    })
    expect(ZOOM_PRESETS["manual-only"]).toMatchObject({
      label: "Manual only",
      scale: 1.5,
      easing: "smooth",
      transitionInMs: 450,
      transitionOutMs: 450,
      clickDurationMs: 0,
      dwellTailMs: 0,
      followSpeed: "balanced",
    })
  })

  it("orders follow smooth times from laggy to tight", () => {
    expect(FOLLOW_SPEED_SMOOTH_TIME_S.relaxed).toBe(0.45)
    expect(FOLLOW_SPEED_SMOOTH_TIME_S.balanced).toBe(0.3)
    expect(FOLLOW_SPEED_SMOOTH_TIME_S.tight).toBe(0.18)
    const values: FollowSpeed[] = [...followSpeedSchemaValues]
    expect(values.every((speed) => FOLLOW_SPEED_SMOOTH_TIME_S[speed] !== undefined)).toBe(true)
  })
})
