import type {
  KeystrokeEvent,
  KeystrokeOverlaySettings,
  KeystrokePlatform,
} from "@recordforge/contracts"
import {
  capsKey,
  eventCaps,
  type KeystrokeCap,
} from "./keystroke-model"
import {
  KEYSTROKE_THEMES,
  keystrokeMetrics,
  type KeystrokeMetrics,
} from "./keystroke-geometry"
import { keystrokeRowSvg } from "./keystroke-row-svg"

/**
 * Timing model — deterministic functions of `sourceMs` so the preview (DOM,
 * scrubbed by the playhead) and the export rasterizer (frame PTS) compute the
 * exact same badge state. Mirrors the Rust implementation in
 * `apps/desktop/src-tauri/src/exports/keystrokes.rs`; the committed
 * `keystroke-layouts.json` fixture locks parity.
 */

export const KEYSTROKE_ENTER_MS = 160
export const KEYSTROKE_EXIT_MS = 220
/** Quicker fade when a row is evicted by a newer combo at max stack depth. */
export const KEYSTROKE_EVICT_MS = 180
/** Identical combos re-pressed within this window bump the row's ×n count. */
export const KEYSTROKE_REPEAT_MERGE_MS = 900

interface MergedRow {
  caps: KeystrokeCap[]
  /** First press timestamp — the row's entrance. */
  startMs: number
  /** Most recent press — extends the hold window on repeats. */
  lastPressMs: number
  repeat: number
}

/** Collapse consecutive identical combos pressed in quick succession. */
export function mergeKeystrokeRows(
  events: KeystrokeEvent[],
  opts: { platform: KeystrokePlatform; modifierStyle: KeystrokeOverlaySettings["modifierStyle"] },
): MergedRow[] {
  const rows: MergedRow[] = []
  for (const event of events) {
    const caps = eventCaps(event, opts)
    const last = rows[rows.length - 1]
    if (
      last &&
      capsKey(last.caps) === capsKey(caps) &&
      event.tMs - last.lastPressMs <= KEYSTROKE_REPEAT_MERGE_MS
    ) {
      last.repeat += 1
      last.lastPressMs = event.tMs
      continue
    }
    rows.push({ caps, startMs: event.tMs, lastPressMs: event.tMs, repeat: 1 })
  }
  return rows
}

interface RowWindow {
  row: MergedRow
  /** Window end — natural hold expiry or an early stack eviction. */
  endMs: number
  /** Fade-out duration for this window (quick on eviction). */
  exitMs: number
}

/**
 * Row visibility windows. A row shows until `lastPressMs + holdMs`, unless a
 * later row would push the visible set past `maxStack` — then it is evicted
 * at the later row's arrival and plays a quicker exit. Because merge rows are
 * time-sorted, at most `maxStack` rows are ever active simultaneously.
 */
export function keystrokeRowWindows(
  rows: MergedRow[],
  settings: Pick<KeystrokeOverlaySettings, "maxStack" | "holdMs">,
): RowWindow[] {
  return rows.map((row, i) => {
    const naturalEnd = row.lastPressMs + settings.holdMs
    const evictAt = rows[i + settings.maxStack]?.startMs ?? Number.POSITIVE_INFINITY
    if (evictAt <= naturalEnd) {
      return { row, endMs: evictAt + KEYSTROKE_EVICT_MS, exitMs: KEYSTROKE_EVICT_MS }
    }
    return { row, endMs: naturalEnd, exitMs: KEYSTROKE_EXIT_MS }
  })
}

/** Coarse activity windows in source time — used for export enable-gating. */
export function keystrokeDisplayWindows(
  events: KeystrokeEvent[],
  settings: Pick<KeystrokeOverlaySettings, "maxStack" | "holdMs">,
  opts: { platform: KeystrokePlatform; modifierStyle: KeystrokeOverlaySettings["modifierStyle"] },
): { startMs: number; endMs: number }[] {
  const rows = mergeKeystrokeRows(events, opts)
  const windows = keystrokeRowWindows(rows, settings)
  return windows.map((w, i) => ({ startMs: rows[i]!.startMs, endMs: w.endMs }))
}

function easeOutCubic(t: number): number {
  const u = 1 - Math.min(1, Math.max(0, t))
  return 1 - u * u * u
}

export interface KeystrokeDisplayRow {
  /** Row artwork — identical string to what the export rasterizer builds. */
  svg: string
  /** svg viewBox size (pill + shadow bleed), canvas px. */
  widthPx: number
  heightPx: number
  /** svg top-left on the canvas. */
  x: number
  y: number
  alpha: number
  /** Pop-in scale around the pill's own center. */
  scale: number
  /** Stable key — `${startMs}` distinguishes same-shape rows. */
  key: string
}

export interface KeystrokeDisplay {
  rows: KeystrokeDisplayRow[]
  metrics: KeystrokeMetrics
}

export interface ResolveKeystrokeDisplayInput {
  events: KeystrokeEvent[]
  settings: KeystrokeOverlaySettings
  platform: KeystrokePlatform
  /** Timestamp in recording-source space (post trim/speed mapping). */
  sourceMs: number
  canvas: { width: number; height: number }
}

export function resolveKeystrokeDisplay(input: ResolveKeystrokeDisplayInput): KeystrokeDisplay {
  const { events, settings, platform, sourceMs, canvas } = input
  const metrics = keystrokeMetrics(canvas.height, settings.scale)
  const empty: KeystrokeDisplay = { rows: [], metrics }
  if (!settings.enabled || events.length === 0) return empty

  const merged = mergeKeystrokeRows(events, { platform, modifierStyle: settings.modifierStyle })
  const windows = keystrokeRowWindows(merged, settings)

  const theme = KEYSTROKE_THEMES[settings.theme]
  const isTop = settings.position.startsWith("top")
  const anchorY = isTop ? metrics.marginPx : canvas.height - metrics.marginPx
  // Rows arrive drifting toward the anchored edge, then settle into place.
  const nudgePx = metrics.capHeightPx * 0.18 * (isTop ? -1 : 1)

  // Gather the active suffix (newest rows first for offset accumulation).
  const active = windows
    .map((w, i) => ({ ...w, startMs: merged[i]!.startMs }))
    .filter((w) => sourceMs >= w.startMs && sourceMs < w.endMs)
  if (active.length === 0) return empty

  const rows: KeystrokeDisplayRow[] = []
  // offset accumulated from the anchor edge — each newer row's contribution
  // glides older rows outward as it enters/exits (smooth stack motion).
  let stackOffset = 0
  const step = metrics.capHeightPx + metrics.pillPadYPx * 2 + metrics.rowGapPx
  for (let i = active.length - 1; i >= 0; i--) {
    const w = active[i]!
    const enterP = easeOutCubic((sourceMs - w.startMs) / KEYSTROKE_ENTER_MS)
    const exitP = Math.min(1, Math.max(0, (w.endMs - sourceMs) / w.exitMs))
    const alpha = Math.min(enterP, exitP)
    if (alpha <= 0) continue

    const spec = keystrokeRowSvg({
      caps: w.row.caps,
      repeat: w.row.repeat,
      metrics,
      theme,
    })
    const pad = metrics.shadowBlurPx * 2
    const pillW = spec.widthPx - pad * 2
    const pillH = spec.heightPx - pad * 2

    const x = (() => {
      switch (settings.position) {
        case "bottom-left":
        case "top-left":
          return metrics.marginPx - pad
        case "bottom-right":
        case "top-right":
          return canvas.width - metrics.marginPx - pillW - pad
        default:
          return (canvas.width - pillW) / 2 - pad
      }
    })()
    const pillEdge = stackOffset
    const y = isTop
      ? anchorY + pillEdge - pad + (1 - enterP) * nudgePx
      : anchorY - pillH - pillEdge - pad + (1 - enterP) * nudgePx

    rows.push({
      svg: spec.svg,
      widthPx: spec.widthPx,
      heightPx: spec.heightPx,
      x,
      y,
      alpha,
      scale: 0.85 + 0.15 * enterP,
      key: `${w.startMs}`,
    })

    // This row's stack contribution glides with its enter/exit progress so
    // siblings slide instead of jumping.
    stackOffset += step * enterP * exitP
  }

  return { rows, metrics }
}
