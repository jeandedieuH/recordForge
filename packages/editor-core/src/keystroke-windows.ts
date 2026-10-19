import type { TimelineClipBase } from "@recordforge/contracts"

// Live badge windows for the editor canvas — the TypeScript mirror of the
// Rust `build_keystroke_windows` in exports/keystrokes.rs. Keep the two in
// lockstep: same mapping, same truncation semantics, same label allowlist.
export interface KeystrokeEventInput {
  readonly tMs: number
  readonly label: string
}

export interface KeystrokeBadgeWindow {
  readonly startMs: number
  readonly endMs: number
  readonly label: string
}

export interface BuildKeystrokeWindowsInput {
  readonly events: readonly KeystrokeEventInput[]
  // Primary screen track clips — carries the full source↔output mapping.
  readonly segments: readonly TimelineClipBase[]
  // Asset IDs belonging to the original recording — inserted b-roll and
  // other imports never produce badges.
  readonly recordingAssetIds: readonly string[]
  // Timeline duration clamp for the final badge tail.
  readonly durationMs: number
  readonly settings: { readonly enabled: boolean; readonly durationMs: number }
}

const SAFE_LABEL = /^[A-Za-z0-9+ ]{1,64}$/

/**
 * Map captured source-time events onto output-time badge windows.
 *
 * An event inside a segment's half-open `[sourceIn, sourceOut)` maps to
 * `outputStart + (t - sourceIn) / speed`. The badge holds for
 * `settings.durationMs`, clipped to its own segment's output extent, and a
 * NEWER badge truncates an earlier badge's tail at its start — the earlier
 * badge keeps the portion before the newer one appears. Duplicate uses of
 * the same source region yield a window per use.
 */
export function buildKeystrokeWindows(input: BuildKeystrokeWindowsInput): KeystrokeBadgeWindow[] {
  if (!input.settings.enabled || input.events.length === 0) {
    return []
  }
  const hold = Math.max(0, Math.round(input.settings.durationMs))
  const timelineEnd = Math.max(0, input.durationMs)
  const assets = new Set(input.recordingAssetIds)
  // Mirror the Rust mapper exactly: stable-sort by timestamp, then drop only
  // ADJACENT exact (t, label) repeats. Equal-timestamp different-label
  // events are all retained — the later captured one wins by tail-
  // truncating the earlier windows to zero below.
  const sorted = input.events
    .filter((e) => Number.isFinite(e.tMs) && e.tMs >= 0 && SAFE_LABEL.test(e.label))
    .sort((a, b) => a.tMs - b.tMs)
  const events = sorted.filter(
    (e, i) => i === 0 || e.tMs !== sorted[i - 1].tMs || e.label !== sorted[i - 1].label,
  )

  const windows: KeystrokeBadgeWindow[] = []
  for (const clip of input.segments) {
    if (!assets.has(clip.assetId) || !Number.isFinite(clip.speed) || clip.speed <= 0) continue
    const clipOutEnd = Math.min(clip.startMs + clip.durationMs, timelineEnd)
    if (clipOutEnd <= clip.startMs) continue
    const sourceOut =
      clip.sourceOutMs > clip.sourceInMs
        ? clip.sourceOutMs
        : clip.sourceInMs + clip.durationMs * clip.speed
    for (const event of events) {
      if (event.tMs < clip.sourceInMs || event.tMs >= sourceOut) continue
      const outputStart = Math.max(
        clip.startMs,
        Math.round(clip.startMs + (event.tMs - clip.sourceInMs) / clip.speed),
      )
      if (outputStart >= clipOutEnd) continue
      windows.push({
        startMs: outputStart,
        endMs: Math.min(outputStart + hold, clipOutEnd),
        label: event.label,
      })
    }
  }

  // Output-time order is a STABLE sort on startMs — equal starts keep input
  // order so the later captured event lands later and its badge truncates
  // the earlier one to zero (then drops below).
  windows.sort((a, b) => a.startMs - b.startMs)
  const out = windows.map((w) => ({ ...w }))
  for (let i = 1; i < out.length; i += 1) {
    if (out[i].startMs < out[i - 1].endMs) {
      out[i - 1] = { ...out[i - 1], endMs: out[i].startMs }
    }
  }
  // Zero-length windows (fully covered by the next badge) never render.
  return out.filter((w) => w.endMs > w.startMs)
}

/** Binary search for the window containing `timeMs` (half-open intervals). */
export function activeKeystrokeWindow(
  windows: readonly KeystrokeBadgeWindow[],
  timeMs: number,
): KeystrokeBadgeWindow | null {
  let lo = 0
  let hi = windows.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (windows[mid].startMs <= timeMs) lo = mid + 1
    else hi = mid
  }
  if (lo === 0) return null
  const candidate = windows[lo - 1]
  return timeMs < candidate.endMs ? candidate : null
}
