import {
  keystrokeFileSchema,
  type KeystrokeEvent,
  type KeystrokeModifier,
  type KeystrokePlatform,
} from "@recordforge/contracts"
import { invokeValidated } from "./ipc"

export interface KeystrokeData {
  platform: KeystrokePlatform
  events: KeystrokeEvent[]
}

const MODIFIER_TOKENS = new Map<string, KeystrokeModifier>([
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

/**
 * Split a v1 `"Ctrl+Shift+S"` label into the v2 structured shape — the last
 * `+`-separated token is the key, the rest are modifiers. Returns null when
 * no modifier is present (the privacy rule means it should never happen).
 */
export function normalizeV1Event(event: { tMs: number; label: string }): KeystrokeEvent | null {
  const tokens = event.label.split("+").filter((token) => token.length > 0)
  if (tokens.length < 2) return null
  const modifiers = new Set<KeystrokeModifier>()
  for (const token of tokens.slice(0, -1)) {
    const modifier = MODIFIER_TOKENS.get(token.toLowerCase())
    if (modifier) modifiers.add(modifier)
  }
  if (modifiers.size === 0) return null
  return { tMs: event.tMs, key: tokens[tokens.length - 1]!, modifiers: [...modifiers] }
}

/** Normalize a keystroke file of either version into v2 events. */
export function normalizeKeystrokeFile(input: unknown): KeystrokeData | null {
  const file = keystrokeFileSchema.parse(input)
  const events: KeystrokeEvent[] = []
  for (const event of file.events) {
    if ("key" in event) {
      events.push(event)
      continue
    }
    const normalized = normalizeV1Event(event)
    if (normalized) events.push(normalized)
  }
  events.sort((a, b) => a.tMs - b.tMs)
  return { platform: file.platform, events }
}

export async function getKeystrokeEvents(recordingId: string): Promise<KeystrokeData | null> {
  const raw = await invokeValidated<unknown>("get_keystroke_events", { recordingId })
  return raw === null ? null : normalizeKeystrokeFile(raw)
}
