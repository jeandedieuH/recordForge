import { describe, expect, it } from "vitest"
import type { ResolvedCameraStyle } from "@recordforge/editor-core"
import {
  borderRingRadiusPx,
  cssBorderRadius,
  cssShadow,
  cssSolidBorder,
  mixBorderColor,
} from "./camera-frame-style"

const baseStyle: ResolvedCameraStyle = {
  opacity: 1,
  borderWidth: 4,
  borderColor: "#ffffff",
  borderOpacity: 1,
  borderStyle: "solid",
  shadowEnabled: true,
  shadowColor: "#000000",
  shadowBlur: 16,
  shadowOffsetX: 0,
  shadowOffsetY: 6,
}

describe("cssBorderRadius", () => {
  it("keeps circles at 50% so any aspect stays elliptical", () => {
    expect(cssBorderRadius("circle", 240, 0.5)).toBe("50%")
  })

  it("scales the resolved px radius for rounded frames — never a percentage", () => {
    expect(cssBorderRadius("rounded", 40, 0.5)).toBe("20px")
    expect(cssBorderRadius("rounded", 40, 1)).toBe("40px")
  })

  it("emits 0px for rectangles and non-positive radii", () => {
    expect(cssBorderRadius("rectangle", 0, 0.5)).toBe("0px")
    expect(cssBorderRadius("rounded", -4, 1)).toBe("0px")
  })
})

describe("cssSolidBorder", () => {
  it("scales the resolved px border width by the preview scale", () => {
    expect(cssSolidBorder(baseStyle, 0.5)).toBe(
      "2px solid color-mix(in srgb, #ffffff 100%, transparent)",
    )
  })

  it("returns undefined for non-solid styles and zero widths", () => {
    expect(cssSolidBorder({ ...baseStyle, borderStyle: "gradient" }, 0.5)).toBeUndefined()
    expect(cssSolidBorder({ ...baseStyle, borderWidth: 0 }, 0.5)).toBeUndefined()
  })

  it("honours border opacity via color-mix", () => {
    expect(cssSolidBorder({ ...baseStyle, borderOpacity: 0.5 }, 1)).toBe(
      "4px solid color-mix(in srgb, #ffffff 50%, transparent)",
    )
  })
})

describe("cssShadow", () => {
  it("scales blur and offsets by the preview scale", () => {
    expect(cssShadow(baseStyle, 0.5)).toBe("0px 3px 8px #000000")
  })

  it("returns undefined when the shadow is disabled", () => {
    expect(cssShadow({ ...baseStyle, shadowEnabled: false }, 0.5)).toBeUndefined()
  })
})

describe("borderRingRadiusPx", () => {
  it("scales the rounded radius and leaves other shapes to their own paths", () => {
    expect(borderRingRadiusPx("rounded", 40, 0.5)).toBe(20)
    expect(borderRingRadiusPx("circle", 240, 0.5)).toBe(0)
    expect(borderRingRadiusPx("rectangle", 40, 0.5)).toBe(0)
  })
})

describe("mixBorderColor", () => {
  it("falls back to the foreground token and clamps opacity", () => {
    expect(mixBorderColor(undefined, undefined)).toBe(
      "color-mix(in srgb, var(--color-foreground) 100%, transparent)",
    )
    expect(mixBorderColor("#fff", 2)).toBe("color-mix(in srgb, #fff 100%, transparent)")
    expect(mixBorderColor("#fff", -1)).toBe("color-mix(in srgb, #fff 0%, transparent)")
  })
})
