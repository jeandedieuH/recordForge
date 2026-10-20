import { describe, expect, it } from "vitest"
import { defaultKeystrokeOverlaySettings } from "@recordforge/contracts"
import {
  keystrokeDisplayWindows,
  keystrokeRowWindows,
  mergeKeystrokeRows,
  resolveKeystrokeDisplay,
  KEYSTROKE_EVICT_MS,
  KEYSTROKE_EXIT_MS,
  KEYSTROKE_REPEAT_MERGE_MS,
} from "./keystroke-layout"

const OPTS = { platform: "windows" as const, modifierStyle: "symbols" as const }

function settings(patch: Partial<typeof defaultKeystrokeOverlaySettings> = {}) {
  return { ...defaultKeystrokeOverlaySettings, enabled: true, ...patch }
}

describe("mergeKeystrokeRows", () => {
  it("merges identical combos pressed in quick succession", () => {
    const rows = mergeKeystrokeRows(
      [
        { tMs: 1000, key: "Z", modifiers: ["ctrl"] },
        { tMs: 1400, key: "Z", modifiers: ["ctrl"] },
        { tMs: 1800, key: "Z", modifiers: ["ctrl"] },
        { tMs: 5000, key: "Z", modifiers: ["ctrl"] },
      ],
      OPTS,
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ startMs: 1000, lastPressMs: 1800, repeat: 3 })
    expect(rows[1]).toMatchObject({ startMs: 5000, repeat: 1 })
  })

  it("does not merge different combos or distant repeats", () => {
    const rows = mergeKeystrokeRows(
      [
        { tMs: 0, key: "C", modifiers: ["ctrl"] },
        { tMs: 100, key: "V", modifiers: ["ctrl"] },
        { tMs: 100 + KEYSTROKE_REPEAT_MERGE_MS + 1, key: "C", modifiers: ["ctrl"] },
      ],
      OPTS,
    )
    expect(rows).toHaveLength(3)
  })
})

describe("keystrokeRowWindows", () => {
  it("extends hold windows from the last press of a merged row", () => {
    const rows = mergeKeystrokeRows(
      [
        { tMs: 1000, key: "Z", modifiers: ["ctrl"] },
        { tMs: 1300, key: "Z", modifiers: ["ctrl"] },
      ],
      OPTS,
    )
    const [w] = keystrokeRowWindows(rows, { maxStack: 3, holdMs: 2200 })
    expect(w?.endMs).toBe(1300 + 2200)
  })

  it("evicts the oldest row when a new press exceeds maxStack", () => {
    const events = [0, 100, 200, 300, 400].map((tMs, i) => ({
      tMs,
      key: `K${i}`,
      modifiers: ["ctrl" as const],
    }))
    const rows = mergeKeystrokeRows(events, OPTS)
    const windows = keystrokeRowWindows(rows, { maxStack: 3, holdMs: 5000 })
    // Row 0 is evicted when row 3 arrives; row 1 when row 4 arrives.
    expect(windows[0]?.endMs).toBe(300 + KEYSTROKE_EVICT_MS)
    expect(windows[1]?.endMs).toBe(400 + KEYSTROKE_EVICT_MS)
    expect(windows[2]?.endMs).toBe(200 + 5000)
  })
})

describe("resolveKeystrokeDisplay", () => {
  const canvas = { width: 1920, height: 1080 }
  const events = [{ tMs: 1000, key: "S", modifiers: ["ctrl" as const] }]

  it("returns empty when disabled or no events cover the time", () => {
    expect(
      resolveKeystrokeDisplay({
        events,
        settings: settings({ enabled: false }),
        platform: "windows",
        sourceMs: 1500,
        canvas,
      }).rows,
    ).toHaveLength(0)
    expect(
      resolveKeystrokeDisplay({
        events,
        settings: settings(),
        platform: "windows",
        sourceMs: 999,
        canvas,
      }).rows,
    ).toHaveLength(0)
    expect(
      resolveKeystrokeDisplay({
        events,
        settings: settings(),
        platform: "windows",
        sourceMs: 1000 + 2200 + 500,
        canvas,
      }).rows,
    ).toHaveLength(0)
  })

  it("animates in, holds, and fades out", () => {
    const s = settings()
    const enter = resolveKeystrokeDisplay({
      events,
      settings: s,
      platform: "windows",
      sourceMs: 1040,
      canvas,
    }).rows[0]
    const mid = resolveKeystrokeDisplay({
      events,
      settings: s,
      platform: "windows",
      sourceMs: 2000,
      canvas,
    }).rows[0]
    const exit = resolveKeystrokeDisplay({
      events,
      settings: s,
      platform: "windows",
      sourceMs: 3200 - KEYSTROKE_EXIT_MS / 2,
      canvas,
    }).rows[0]
    expect(enter!.alpha).toBeLessThan(1)
    expect(enter!.scale).toBeLessThan(1)
    expect(mid!.alpha).toBe(1)
    expect(mid!.scale).toBe(1)
    expect(exit!.alpha).toBeLessThan(1)
    expect(exit!.alpha).toBeGreaterThan(0)
  })

  it("anchors bottom-center with margins", () => {
    const row = resolveKeystrokeDisplay({
      events,
      settings: settings(),
      platform: "windows",
      sourceMs: 2000,
      canvas,
    }).rows[0]!
    expect(row.y + row.heightPx).toBeLessThanOrEqual(1080)
    expect(row.x).toBeGreaterThan(0)
    expect(row.x + row.widthPx).toBeLessThan(1920)
  })

  it("stacks up to maxStack rows, newest nearest the anchor", () => {
    const evs = [1000, 1200, 1400, 1600, 1800].map((tMs, i) => ({
      tMs,
      key: `K${i}`,
      modifiers: ["ctrl" as const],
    }))
    const s = settings({ maxStack: 3, holdMs: 5000 })
    // During the eviction fade the outgoing row is still visible — 4 rows.
    expect(
      resolveKeystrokeDisplay({
        events: evs,
        settings: s,
        platform: "windows",
        sourceMs: 1850,
        canvas,
      }).rows,
    ).toHaveLength(4)
    const display = resolveKeystrokeDisplay({
      events: evs,
      settings: s,
      platform: "windows",
      sourceMs: 2100,
      canvas,
    })
    expect(display.rows).toHaveLength(3)
    // Newest (1800) is lowest (nearest the bottom anchor).
    const sorted = [...display.rows].sort((a, b) => a.y - b.y)
    expect(sorted[2]!.key).toBe("1800")
  })

  it("emits deterministic SVG artwork per row", () => {
    const a = resolveKeystrokeDisplay({
      events,
      settings: settings(),
      platform: "windows",
      sourceMs: 2000,
      canvas,
    }).rows[0]!
    const b = resolveKeystrokeDisplay({
      events,
      settings: settings(),
      platform: "windows",
      sourceMs: 2500,
      canvas,
    }).rows[0]!
    expect(a.svg).toBe(b.svg)
    expect(a.svg).toContain("<svg")
    expect(a.svg).toContain("</svg>")
  })
})

describe("keystrokeDisplayWindows", () => {
  it("produces coarse activity windows for gating", () => {
    const windows = keystrokeDisplayWindows(
      [{ tMs: 1000, key: "C", modifiers: ["ctrl"] }],
      { maxStack: 3, holdMs: 2000 },
      OPTS,
    )
    expect(windows).toEqual([{ startMs: 1000, endMs: 3000 }])
  })
})
