import { describe, expect, it } from "vitest"
import { resolveShortcut, type ShortcutEvent, type ShortcutTarget } from "./teleprompter-shortcuts"

function event(overrides: Partial<ShortcutEvent>): ShortcutEvent {
  return {
    key: "",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    repeat: false,
    defaultPrevented: false,
    ...overrides,
  }
}

function target(tagName: string, overrides: Partial<ShortcutTarget> = {}): ShortcutTarget {
  return { tagName, ...overrides }
}

describe("resolveShortcut", () => {
  it("maps the documented keys to actions in prompt mode", () => {
    const cases: Array<[string, string]> = [
      [" ", "toggle-play"],
      ["ArrowUp", "speed-up"],
      ["ArrowDown", "speed-down"],
      ["+", "size-up"],
      ["=", "size-up"],
      ["-", "size-down"],
      ["_", "size-down"],
      ["r", "restart"],
      ["R", "restart"],
      ["m", "toggle-mirror"],
      ["e", "edit"],
      ["Escape", "escape"],
    ]
    for (const [key, expected] of cases) {
      expect(resolveShortcut(event({ key }), target("div"), "prompt"), key).toBe(expected)
    }
  })

  it("ignores plain keys coming from text entry", () => {
    for (const tagName of ["input", "textarea", "select"]) {
      expect(resolveShortcut(event({ key: " " }), target(tagName), "edit")).toBeNull()
      expect(resolveShortcut(event({ key: "r" }), target(tagName), "edit")).toBeNull()
      expect(resolveShortcut(event({ key: "ArrowUp" }), target(tagName), "edit")).toBeNull()
    }
    expect(
      resolveShortcut(event({ key: "e" }), target("div", { isContentEditable: true }), "prompt"),
    ).toBeNull()
  })

  it("lets Escape through text entry, and Ctrl+Enter starts from the editor", () => {
    const textarea = target("textarea")
    expect(resolveShortcut(event({ key: "Escape" }), textarea, "edit")).toBe("escape")
    expect(resolveShortcut(event({ key: "Enter", ctrlKey: true }), textarea, "edit")).toBe("start")
    expect(resolveShortcut(event({ key: "Enter", metaKey: true }), textarea, "edit")).toBe("start")
    // Already prompting — nothing to start.
    expect(resolveShortcut(event({ key: "Enter", ctrlKey: true }), textarea, "prompt")).toBeNull()
    // Plain Enter or Alt+Enter is not a shortcut.
    expect(resolveShortcut(event({ key: "Enter" }), textarea, "edit")).toBeNull()
    expect(resolveShortcut(event({ key: "Enter", altKey: true }), textarea, "edit")).toBeNull()
  })

  it("ignores Space on buttons but accepts it on sliders", () => {
    expect(resolveShortcut(event({ key: " " }), target("button"), "prompt")).toBeNull()
    expect(
      resolveShortcut(event({ key: " " }), target("div", { role: "button" }), "prompt"),
    ).toBeNull()
    expect(resolveShortcut(event({ key: " " }), target("span", { role: "slider" }), "prompt")).toBe(
      "toggle-play",
    )
  })

  it("leaves Arrow keys to focused sliders", () => {
    const slider = target("span", { role: "slider" })
    expect(resolveShortcut(event({ key: "ArrowUp" }), slider, "prompt")).toBeNull()
    expect(resolveShortcut(event({ key: "ArrowDown" }), slider, "prompt")).toBeNull()
  })

  it("ignores modified keys (OS/browser chords)", () => {
    expect(resolveShortcut(event({ key: "r", ctrlKey: true }), target("div"), "prompt")).toBeNull()
    expect(resolveShortcut(event({ key: "r", metaKey: true }), target("div"), "prompt")).toBeNull()
    expect(resolveShortcut(event({ key: "m", altKey: true }), target("div"), "prompt")).toBeNull()
    expect(resolveShortcut(event({ key: " ", ctrlKey: true }), target("div"), "prompt")).toBeNull()
  })

  it("ignores already-handled events", () => {
    expect(
      resolveShortcut(event({ key: " ", defaultPrevented: true }), target("div"), "prompt"),
    ).toBeNull()
  })

  it("ignores auto-repeat except for the continuous adjustments", () => {
    expect(resolveShortcut(event({ key: " ", repeat: true }), target("div"), "prompt")).toBeNull()
    expect(resolveShortcut(event({ key: "r", repeat: true }), target("div"), "prompt")).toBeNull()
    expect(resolveShortcut(event({ key: "m", repeat: true }), target("div"), "prompt")).toBeNull()
    expect(resolveShortcut(event({ key: "ArrowUp", repeat: true }), target("div"), "prompt")).toBe(
      "speed-up",
    )
    expect(
      resolveShortcut(event({ key: "ArrowDown", repeat: true }), target("div"), "prompt"),
    ).toBe("speed-down")
    expect(resolveShortcut(event({ key: "=", repeat: true }), target("div"), "prompt")).toBe(
      "size-up",
    )
    expect(resolveShortcut(event({ key: "-", repeat: true }), target("div"), "prompt")).toBe(
      "size-down",
    )
  })

  it("only offers edit while prompting and only start while editing", () => {
    expect(resolveShortcut(event({ key: "e" }), target("div"), "prompt")).toBe("edit")
    expect(resolveShortcut(event({ key: "e" }), target("div"), "edit")).toBeNull()
    expect(resolveShortcut(event({ key: "Escape" }), target("div"), "prompt")).toBe("escape")
    expect(resolveShortcut(event({ key: "Escape" }), target("div"), "edit")).toBe("escape")
  })

  it("returns null for unbound keys and null targets", () => {
    expect(resolveShortcut(event({ key: "q" }), target("div"), "prompt")).toBeNull()
    expect(resolveShortcut(event({ key: "Tab" }), target("div"), "prompt")).toBeNull()
    expect(resolveShortcut(event({ key: " " }), null, "prompt")).toBe("toggle-play")
  })
})
