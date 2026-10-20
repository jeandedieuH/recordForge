import type {
  KeystrokeEvent,
  KeystrokeEventV1,
  KeystrokeModifier,
  KeystrokeModifierStyle,
  KeystrokePlatform,
} from "@recordforge/contracts"

/**
 * One rendered unit inside a combo row — either an icon glyph (drawn from the
 * shared `key-glyphs.json` path table) or a short text label in JetBrains Mono.
 */
export interface KeystrokeCap {
  glyphId: string | null
  text: string | null
  isModifier: boolean
}

/** Ordered token list for one event: modifiers first, then the key. */
export interface KeystrokeTokens {
  modifiers: KeystrokeModifier[]
  key: string
}

/** Canonical display order — matches the capture label order on both platforms. */
const MODIFIER_ORDER: readonly KeystrokeModifier[] = ["ctrl", "alt", "shift", "meta"]

const V1_MODIFIERS = new Map<string, KeystrokeModifier>([
  ["ctrl", "ctrl"],
  ["control", "ctrl"],
  ["alt", "alt"],
  ["option", "alt"],
  ["shift", "shift"],
  ["win", "meta"],
  ["cmd", "meta"],
  ["command", "meta"],
  ["meta", "meta"],
  ["super", "meta"],
])

/** Split a v1 `"Ctrl+Shift+S"` label into the v2 structured shape. */
export function normalizeV1Event(event: KeystrokeEventV1): KeystrokeEvent | null {
  const tokens = event.label.split("+").filter((token) => token.length > 0)
  if (tokens.length < 2) return null
  const modifiers = new Set<KeystrokeModifier>()
  for (const token of tokens.slice(0, -1)) {
    const modifier = V1_MODIFIERS.get(token.toLowerCase())
    if (modifier) modifiers.add(modifier)
  }
  if (modifiers.size === 0) return null
  const key = tokens[tokens.length - 1]
  if (!key) return null
  return { tMs: event.tMs, key, modifiers: MODIFIER_ORDER.filter((m) => modifiers.has(m)) }
}

/** Normalize a mixed v1/v2 event list into sorted v2 events. */
export function normalizeKeystrokeEvents(
  events: (KeystrokeEvent | KeystrokeEventV1)[],
): KeystrokeEvent[] {
  const out: KeystrokeEvent[] = []
  for (const event of events) {
    if ("key" in event) {
      out.push({
        ...event,
        modifiers: MODIFIER_ORDER.filter((m) => event.modifiers.includes(m)),
      })
      continue
    }
    const normalized = normalizeV1Event(event)
    if (normalized) out.push(normalized)
  }
  out.sort((a, b) => a.tMs - b.tMs)
  return out
}

const MODIFIER_TEXT: Record<KeystrokeModifier, Record<KeystrokePlatform, string>> = {
  ctrl: { windows: "Ctrl", macos: "Ctrl", linux: "Ctrl", unknown: "Ctrl" },
  alt: { windows: "Alt", macos: "Opt", linux: "Alt", unknown: "Alt" },
  shift: { windows: "Shift", macos: "Shift", linux: "Shift", unknown: "Shift" },
  meta: { windows: "Win", macos: "Cmd", linux: "Super", unknown: "Meta" },
}

const MODIFIER_GLYPH: Record<KeystrokeModifier, Record<KeystrokePlatform, string>> = {
  ctrl: { windows: "mod-ctrl", macos: "mod-ctrl", linux: "mod-ctrl", unknown: "mod-ctrl" },
  alt: { windows: "mod-alt", macos: "mod-alt", linux: "mod-alt", unknown: "mod-alt" },
  shift: { windows: "mod-shift", macos: "mod-shift", linux: "mod-shift", unknown: "mod-shift" },
  meta: {
    windows: "mod-meta-win",
    macos: "mod-meta-cmd",
    linux: "mod-meta-super",
    unknown: "mod-meta-super",
  },
}

/**
 * On macOS modifiers always render as glyphs (⌃⌥⇧⌘ is the native convention).
 * Elsewhere "symbols" still uses text for Ctrl/Alt/Shift (Windows users read
 * names) and reserves glyphs for the meta logo — `text` forces names on all
 * platforms.
 */
const MAC_GLYPH_MODIFIERS = new Set(["mod-ctrl", "mod-alt", "mod-shift", "mod-meta-cmd"])

/** Special-key names captured by the native samplers → icon glyphs. */
const KEY_GLYPHS = new Map<string, string>([
  ["enter", "enter"],
  ["return", "enter"],
  ["tab", "tab"],
  ["backspace", "backspace"],
  ["delete", "delete"],
  ["del", "delete"],
  ["space", "space"],
  ["up", "arrow-up"],
  ["down", "arrow-down"],
  ["left", "arrow-left"],
  ["right", "arrow-right"],
])

/** Friendly text for named keys that read better than their capture name. */
const KEY_TEXT = new Map<string, string>([
  ["esc", "Esc"],
  ["escape", "Esc"],
  ["pageup", "PgUp"],
  ["pagedown", "PgDn"],
  ["capslock", "Caps"],
])

export interface TokenizeOptions {
  platform: KeystrokePlatform
  modifierStyle: KeystrokeModifierStyle
}

/** Map one event to its rendered cap list (modifier caps then the key cap). */
export function eventCaps(event: KeystrokeEvent, opts: TokenizeOptions): KeystrokeCap[] {
  const caps: KeystrokeCap[] = []
  for (const modifier of MODIFIER_ORDER.filter((m) => event.modifiers.includes(m))) {
    const glyphId = MODIFIER_GLYPH[modifier][opts.platform]
    const useGlyph =
      opts.modifierStyle === "symbols" &&
      (opts.platform === "macos" ? MAC_GLYPH_MODIFIERS.has(glyphId) : modifier === "meta")
    caps.push(
      useGlyph
        ? { glyphId, text: null, isModifier: true }
        : {
            glyphId: null,
            text: MODIFIER_TEXT[modifier][opts.platform],
            isModifier: true,
          },
    )
  }
  const lower = event.key.toLowerCase()
  const keyGlyph = KEY_GLYPHS.get(lower)
  if (keyGlyph) {
    caps.push({ glyphId: keyGlyph, text: null, isModifier: false })
  } else {
    caps.push({
      glyphId: null,
      text: KEY_TEXT.get(lower) ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key),
      isModifier: false,
    })
  }
  return caps
}

/** Stable identity for a row — two presses of the same combo share a shape. */
export function capsKey(caps: KeystrokeCap[]): string {
  return caps.map((cap) => cap.glyphId ?? `t:${cap.text}`).join("|")
}
