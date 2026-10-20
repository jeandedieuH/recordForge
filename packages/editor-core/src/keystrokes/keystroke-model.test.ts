import { describe, expect, it } from "vitest"
import {
  capsKey,
  eventCaps,
  normalizeKeystrokeEvents,
  normalizeV1Event,
} from "./keystroke-model"

describe("normalizeV1Event", () => {
  it("splits modifier labels into structured events", () => {
    expect(normalizeV1Event({ tMs: 100, label: "Ctrl+Shift+S" })).toEqual({
      tMs: 100,
      key: "S",
      modifiers: ["ctrl", "shift"],
    })
  })

  it("maps Win and Cmd to meta in canonical order", () => {
    expect(normalizeV1Event({ tMs: 0, label: "Ctrl+Alt+Shift+Cmd+P" })).toEqual({
      tMs: 0,
      key: "P",
      modifiers: ["ctrl", "alt", "shift", "meta"],
    })
    expect(normalizeV1Event({ tMs: 0, label: "Win+D" })).toEqual({
      tMs: 0,
      key: "D",
      modifiers: ["meta"],
    })
  })

  it("rejects labels without a modifier (privacy rule)", () => {
    expect(normalizeV1Event({ tMs: 0, label: "S" })).toBeNull()
    expect(normalizeV1Event({ tMs: 0, label: "" })).toBeNull()
  })
})

describe("normalizeKeystrokeEvents", () => {
  it("sorts and normalizes mixed v1/v2 input", () => {
    const events = normalizeKeystrokeEvents([
      { tMs: 500, label: "Ctrl+V" },
      { tMs: 100, key: "C", modifiers: ["ctrl"] },
    ])
    expect(events.map((e) => e.tMs)).toEqual([100, 500])
    expect(events[1]).toEqual({ tMs: 500, key: "V", modifiers: ["ctrl"] })
  })
})

describe("eventCaps", () => {
  it("renders macOS modifiers as glyphs in symbol mode", () => {
    const caps = eventCaps(
      { tMs: 0, key: "P", modifiers: ["meta", "shift"] },
      { platform: "macos", modifierStyle: "symbols" },
    )
    expect(caps).toEqual([
      { glyphId: "mod-shift", text: null, isModifier: true },
      { glyphId: "mod-meta-cmd", text: null, isModifier: true },
      { glyphId: null, text: "P", isModifier: false },
    ])
  })

  it("renders Windows modifiers as text, meta as the logo glyph", () => {
    const caps = eventCaps(
      { tMs: 0, key: "S", modifiers: ["ctrl", "meta"] },
      { platform: "windows", modifierStyle: "symbols" },
    )
    expect(caps).toEqual([
      { glyphId: null, text: "Ctrl", isModifier: true },
      { glyphId: "mod-meta-win", text: null, isModifier: true },
      { glyphId: null, text: "S", isModifier: false },
    ])
  })

  it("text mode forces names on every platform", () => {
    const caps = eventCaps(
      { tMs: 0, key: "Z", modifiers: ["meta"] },
      { platform: "macos", modifierStyle: "text" },
    )
    expect(caps[0]).toEqual({ glyphId: null, text: "Cmd", isModifier: true })
  })

  it("maps named keys to icon glyphs and keeps Esc as text", () => {
    const caps = eventCaps(
      { tMs: 0, key: "Enter", modifiers: ["ctrl"] },
      { platform: "windows", modifierStyle: "symbols" },
    )
    expect(caps[1]).toEqual({ glyphId: "enter", text: null, isModifier: false })
    const esc = eventCaps(
      { tMs: 0, key: "Esc", modifiers: ["ctrl"] },
      { platform: "windows", modifierStyle: "symbols" },
    )
    expect(esc[1]).toEqual({ glyphId: null, text: "Esc", isModifier: false })
  })

  it("capsKey distinguishes shapes for repeat merging", () => {
    const a = eventCaps(
      { tMs: 0, key: "C", modifiers: ["ctrl"] },
      { platform: "windows", modifierStyle: "symbols" },
    )
    const b = eventCaps(
      { tMs: 0, key: "V", modifiers: ["ctrl"] },
      { platform: "windows", modifierStyle: "symbols" },
    )
    const a2 = eventCaps(
      { tMs: 0, key: "C", modifiers: ["ctrl"] },
      { platform: "windows", modifierStyle: "symbols" },
    )
    expect(capsKey(a)).not.toBe(capsKey(b))
    expect(capsKey(a)).toBe(capsKey(a2))
  })
})
