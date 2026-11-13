import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { Button } from "./button"

const glyph = createElement("svg", { "data-testid": "glyph" })

describe("Button loading state", () => {
  it("replaces an icon button's glyph with the spinner instead of rendering both", () => {
    const html = renderToString(
      createElement(Button, { size: "icon", loading: true, "aria-label": "Pause" }, glyph),
    )
    expect(html).toContain("animate-spin")
    expect(html).not.toContain("data-testid")
    expect(html).toContain('aria-busy="true"')
  })

  it("keeps a text button's label beside the spinner", () => {
    const html = renderToString(createElement(Button, { loading: true }, "Delete"))
    expect(html).toContain("animate-spin")
    expect(html).toContain("Delete")
  })

  it("renders the glyph when not loading", () => {
    const html = renderToString(
      createElement(Button, { size: "icon", "aria-label": "Pause" }, glyph),
    )
    expect(html).toContain("data-testid")
    expect(html).not.toContain("animate-spin")
  })
})
