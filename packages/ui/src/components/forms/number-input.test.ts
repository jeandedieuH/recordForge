import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { NumberInput, NumberInputField } from "./number-input"

describe("NumberInput component", () => {
  it("renders with defaultValue and unit suffix", () => {
    const html = renderToString(
      createElement(NumberInput, {
        defaultValue: 42,
        unit: "ms",
      }),
    )
    expect(html).toContain("42")
    expect(html).toContain("ms")
    expect(html).toContain("Increment")
    expect(html).toContain("Decrement")
  })

  it("renders NumberInputField with label and hint", () => {
    const html = renderToString(
      createElement(NumberInputField, {
        label: "Fade in duration",
        hint: "in milliseconds",
        defaultValue: 100,
        unit: "ms",
      }),
    )
    expect(html).toContain("Fade in duration")
    expect(html).toContain("in milliseconds")
    expect(html).toContain("100")
  })

  it("renders disabled state without stepper buttons", () => {
    const html = renderToString(
      createElement(NumberInput, {
        defaultValue: 10,
        disabled: true,
      }),
    )
    expect(html).not.toContain("Increment")
    expect(html).toContain("disabled")
  })
})
