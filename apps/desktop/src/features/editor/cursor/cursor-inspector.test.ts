import { describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { defaultCursorSettings, recommendedCursorSettings } from "@recordforge/contracts"
import { AdvancedCursorSettings, CURSOR_THEMES } from "./cursor-inspector"

interface SliderNode {
  props: {
    "aria-label"?: string
    value?: number[]
    onValueCommit?: (value: number[]) => void
    children?: ReactNode
  }
}

function collectText(node: unknown): string[] {
  if (typeof node === "string" || typeof node === "number") return [String(node)]
  if (Array.isArray(node)) return node.flatMap(collectText)
  if (node && typeof node === "object" && "props" in node) {
    return collectText((node as { props?: { children?: unknown } }).props?.children)
  }
  return []
}

function findSliderByLabel(node: unknown, label: string): SliderNode | null {
  if (!node || typeof node !== "object") return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findSliderByLabel(child, label)
      if (hit) return hit
    }
    return null
  }
  if ("props" in node) {
    const el = node as SliderNode
    if (el.props["aria-label"] === label && typeof el.props.onValueCommit === "function") {
      return el
    }
    return findSliderByLabel(el.props.children, label)
  }
  return null
}

describe("CURSOR_THEMES", () => {
  it("caps every cursor look stroke width at 1.5px", () => {
    expect(CURSOR_THEMES.length).toBeGreaterThan(0)
    for (const theme of CURSOR_THEMES) {
      expect(theme.strokeWidth).toBeLessThanOrEqual(1.5)
    }
  })

  it("defaults cursor stroke width to 1.0px", () => {
    expect(defaultCursorSettings.strokeWidth).toBe(1.0)
    expect(recommendedCursorSettings.strokeWidth).toBe(1.0)
  })
})

describe("AdvancedCursorSettings stroke & opacity", () => {
  it("displays 1.0px default stroke width and updates stroke and cursor opacity cleanly", () => {
    const onChange = vi.fn()
    const tree = AdvancedCursorSettings({
      settings: defaultCursorSettings,
      onChange,
    })

    const text = collectText(tree).join("")
    expect(text).toContain("1.0px")
    expect(text).toContain("Stroke opacity")
    expect(text).toContain("Cursor opacity")

    const strokeWidthSlider = findSliderByLabel(tree, "Stroke width")
    expect(strokeWidthSlider?.props.value).toEqual([1.0])
    strokeWidthSlider?.props.onValueCommit?.([1.5])
    expect(onChange).toHaveBeenLastCalledWith({ strokeWidth: 1.5 })

    const strokeOpacitySlider = findSliderByLabel(tree, "Stroke opacity")
    expect(strokeOpacitySlider?.props.value).toEqual([1])
    strokeOpacitySlider?.props.onValueCommit?.([0.4])
    expect(onChange).toHaveBeenLastCalledWith({ strokeOpacity: 0.4 })

    const cursorOpacitySlider = findSliderByLabel(tree, "Cursor opacity")
    expect(cursorOpacitySlider?.props.value).toEqual([1])
    cursorOpacitySlider?.props.onValueCommit?.([0.5])
    expect(onChange).toHaveBeenLastCalledWith({ fillOpacity: 0.5, strokeOpacity: 0.5 })
  })
})
