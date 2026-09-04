import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { SliderField } from "./slider"

describe("SliderField component", () => {
  it("renders with label, formatted value readout, and preset buttons", () => {
    const html = renderToString(
      createElement(SliderField, {
        label: "Canvas Padding",
        value: 96,
        unit: "px",
        onValueChange: () => {},
        presets: [
          { value: 0, label: "0px" },
          { value: 24, label: "24px" },
          { value: 96, label: "96px" },
        ],
      }),
    )
    expect(html).toContain("Canvas Padding")
    expect(html).toContain("96px")
    expect(html).toContain("0px")
    expect(html).toContain("24px")
  })
})
