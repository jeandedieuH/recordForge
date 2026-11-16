import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { NumberInput, NumberInputField, resolveNumberInputBlurCommit } from "./number-input"

describe("resolveNumberInputBlurCommit", () => {
  it("commits a typed value", () => {
    expect(resolveNumberInputBlurCommit({ draft: "250", edited: true, value: 100 })).toBe(250)
  })

  it("does not re-commit an untouched field whose model moved", () => {
    // The field showed 100 when it gained focus, the title was dragged to 250,
    // and the click that blurred the field must not push 100 back.
    expect(resolveNumberInputBlurCommit({ draft: "100", edited: false, value: 250 })).toBeNull()
  })

  it("repairs an unreadable entry only when the user typed it", () => {
    expect(resolveNumberInputBlurCommit({ draft: "abc", edited: true, value: 42 })).toBe(42)
    expect(resolveNumberInputBlurCommit({ draft: "abc", edited: false, value: 42 })).toBeNull()
  })

  it("skips a commit that normalizes to the current value", () => {
    expect(
      resolveNumberInputBlurCommit({ draft: "12.7", edited: true, value: 13, step: 1 }),
    ).toBeNull()
    expect(resolveNumberInputBlurCommit({ draft: "12", edited: true, value: 13, step: 1 })).toBe(12)
  })

  it("respects min/max when deciding", () => {
    expect(resolveNumberInputBlurCommit({ draft: "500", edited: true, value: 100, max: 200 })).toBe(
      200,
    )
    expect(
      resolveNumberInputBlurCommit({ draft: "200", edited: true, value: 200, max: 200 }),
    ).toBeNull()
  })
})

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
