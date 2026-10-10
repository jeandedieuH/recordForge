import { clamp } from "./teleprompter-math"

export type TeleprompterMode = "edit" | "prompt"

export interface TeleprompterSettings {
  /** Reading speed in words per minute. */
  wpm: number
  /** Prompt text size in px. */
  fontSize: number
  /** Card background opacity as a percentage (40-100). */
  opacity: number
  /** Horizontal flip for mirrored-glass prompter rigs. */
  mirror: boolean
}

export interface SettingLimit {
  min: number
  max: number
  step: number
}

export const WPM_LIMIT: SettingLimit = { min: 60, max: 300, step: 5 }
export const FONT_SIZE_LIMIT: SettingLimit = { min: 20, max: 80, step: 2 }
export const OPACITY_LIMIT: SettingLimit = { min: 40, max: 100, step: 5 }

export const DEFAULT_TELEPROMPTER_SETTINGS: TeleprompterSettings = {
  wpm: 140,
  fontSize: 36,
  opacity: 90,
  mirror: false,
}

function sanitizeNumber(raw: unknown, fallback: number, limit: SettingLimit): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback
  return clamp(raw, limit.min, limit.max)
}

/** Normalizes a persisted settings blob; the legacy `speed` (px/s) field is
 *  ignored now that speed is wpm-derived. Values are clamped, not snapped. */
export function sanitizeSettings(raw: unknown): TeleprompterSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ...DEFAULT_TELEPROMPTER_SETTINGS }
  }
  const record = raw as Record<string, unknown>
  return {
    wpm: sanitizeNumber(record.wpm, DEFAULT_TELEPROMPTER_SETTINGS.wpm, WPM_LIMIT),
    fontSize: sanitizeNumber(
      record.fontSize,
      DEFAULT_TELEPROMPTER_SETTINGS.fontSize,
      FONT_SIZE_LIMIT,
    ),
    opacity: sanitizeNumber(record.opacity, DEFAULT_TELEPROMPTER_SETTINGS.opacity, OPACITY_LIMIT),
    mirror:
      typeof record.mirror === "boolean" ? record.mirror : DEFAULT_TELEPROMPTER_SETTINGS.mirror,
  }
}
