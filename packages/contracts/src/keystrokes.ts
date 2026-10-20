import { z } from "zod"

// Keystroke overlay contracts — the captured modifier-combo event log and the
// display settings shared by the editor preview and the Rust export renderer.

/**
 * Normalized modifier identity. `meta` is Cmd on macOS, Win on Windows and
 * Super on Linux — the platform-aware glyph is chosen at display time.
 */
export const keystrokeModifierSchema = z.enum(["ctrl", "alt", "shift", "meta"])
export type KeystrokeModifier = z.infer<typeof keystrokeModifierSchema>

export const keystrokePlatformSchema = z.enum(["windows", "macos", "linux", "unknown"])
export type KeystrokePlatform = z.infer<typeof keystrokePlatformSchema>

/**
 * V2 structured event: one modifier-combination key press timestamped on the
 * recording (source) timeline. Privacy rule: a press only produces an event
 * while at least one modifier is held — plain typing is never recorded.
 */
export const keystrokeEventSchema = z.object({
  tMs: z.number().int().min(0),
  key: z.string().min(1),
  modifiers: z.array(keystrokeModifierSchema).min(1),
})
export type KeystrokeEvent = z.infer<typeof keystrokeEventSchema>

/**
 * V1 event shape (`{tMs, label: "Ctrl+Shift+S"}`). Accepted on load and
 * normalized into the v2 shape — `key` is the last `+`-separated token, the
 * rest become modifiers (`Win`/`Cmd`/`Super` → `meta`).
 */
export const keystrokeEventV1Schema = z.object({
  tMs: z.number().int().min(0),
  label: z.string().min(1),
})
export type KeystrokeEventV1 = z.infer<typeof keystrokeEventV1Schema>

export const keystrokeFileSchema = z.object({
  version: z.number().int().min(1).max(2),
  platform: keystrokePlatformSchema.catch("unknown").default("unknown"),
  events: z.array(z.union([keystrokeEventSchema, keystrokeEventV1Schema])).default([]),
})
export type KeystrokeFile = z.infer<typeof keystrokeFileSchema>

/** Positions the badge stack can be anchored to on the canvas. */
export const keystrokePositionSchema = z.enum([
  "bottom-center",
  "bottom-left",
  "bottom-right",
  "top-center",
  "top-left",
  "top-right",
])
export type KeystrokePosition = z.infer<typeof keystrokePositionSchema>

export const keystrokeThemeSchema = z.enum(["dark", "light", "contrast"])
export type KeystrokeTheme = z.infer<typeof keystrokeThemeSchema>

/** `symbols` renders platform glyphs (⌘ ⇧ ⌥ ⌃ ⊞); `text` renders names. */
export const keystrokeModifierStyleSchema = z.enum(["symbols", "text"])
export type KeystrokeModifierStyle = z.infer<typeof keystrokeModifierStyleSchema>

/**
 * Keystroke badge style + behavior settings. Persisted in
 * `project.exportSettings.keystrokeOverlay`; the editor preview and the Rust
 * export renderer read the same object (WYSIWYG).
 */
export const keystrokeOverlaySettingsSchema = z.object({
  enabled: z.boolean().default(false),
  position: keystrokePositionSchema.default("bottom-center"),
  theme: keystrokeThemeSchema.default("dark"),
  /** Badge size relative to the canvas-height baseline. */
  scale: z.number().min(0.5).max(2).default(1),
  /** History depth — how many recent combos stay visible in the stack. */
  maxStack: z.number().int().min(1).max(5).default(3),
  /** How long a combo stays on screen before fading out. */
  holdMs: z.number().int().min(800).max(5000).default(2200),
  modifierStyle: keystrokeModifierStyleSchema.default("symbols"),
})
export type KeystrokeOverlaySettings = z.infer<typeof keystrokeOverlaySettingsSchema>

export const defaultKeystrokeOverlaySettings: KeystrokeOverlaySettings =
  keystrokeOverlaySettingsSchema.parse({})
