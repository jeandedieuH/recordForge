import { describe, expect, it } from "vitest"
import { overlayFontSchema, overlayRenderPlanSchema, overlayTransformSchema } from "./overlay"
import { overlayAnimationSchema } from "./timeline"

describe("overlay transport contract", () => {
  it("provides stable defaults for the engine boundary", () => {
    expect(overlayTransformSchema.parse({})).toMatchObject({
      width: 100,
      height: 100,
      anchorX: 0.5,
      anchorY: 0.5,
      zIndex: 0,
      opacity: 1,
    })
    expect(overlayAnimationSchema.parse({})).toMatchObject({
      inType: "fade",
      outType: "fade",
      inDurationMs: 350,
      outDurationMs: 350,
      easing: "expo-out",
    })
  })

  it("parses an empty render plan without inventing assets or fonts", () => {
    const plan = overlayRenderPlanSchema.parse({
      canvas: { width: 1920, height: 1080 },
    })

    expect(plan).toMatchObject({ version: 1, items: [], assets: [], fonts: [] })
  })

  it("keeps exit animations within the shared animation vocabulary", () => {
    expect(() => overlayAnimationSchema.parse({ outType: "draw" })).toThrow()
    expect(() => overlayAnimationSchema.parse({ outType: "typewriter" })).toThrow()
    expect(overlayAnimationSchema.parse({ inType: "typewriter" }).inType).toBe("typewriter")
  })

  it("requires the approved font license identifier", () => {
    expect(
      overlayFontSchema.parse({
        family: "sans",
        file: "Inter-VariableFont_slnt,wght.ttf",
        license: "OFL-1.1",
      }),
    ).toEqual({
      family: "sans",
      file: "Inter-VariableFont_slnt,wght.ttf",
      license: "OFL-1.1",
    })
    expect(() =>
      overlayFontSchema.parse({
        family: "sans",
        file: "Inter-VariableFont_slnt,wght.ttf",
        license: "MIT",
      }),
    ).toThrow()
  })
})
