import { describe, expect, it } from "vitest"
import type { TimelineClipBase } from "@recordforge/contracts"
import {
  activeKeystrokeWindow,
  buildKeystrokeWindows,
  type BuildKeystrokeWindowsInput,
} from "./keystroke-windows"

// TypeScript parity twin of the Rust keystroke-window tests — keep fixture
// inputs and expected windows identical to exports/keystrokes.rs.

function clip(partial: Partial<TimelineClipBase>): TimelineClipBase {
  return {
    id: partial.id ?? "c1",
    assetId: partial.assetId ?? "primary",
    startMs: partial.startMs ?? 0,
    durationMs: partial.durationMs ?? 0,
    sourceInMs: partial.sourceInMs ?? 0,
    sourceOutMs: partial.sourceOutMs ?? 0,
    speed: partial.speed ?? 1,
    ...partial,
  }
}

function input(partial: Partial<BuildKeystrokeWindowsInput>): BuildKeystrokeWindowsInput {
  return {
    events: [],
    segments: [],
    recordingAssetIds: ["primary"],
    durationMs: 10_000,
    settings: { enabled: true, durationMs: 1_400 },
    ...partial,
  }
}

describe("buildKeystrokeWindows", () => {
  it("holds for the configured duration and truncates at the next event", () => {
    const windows = buildKeystrokeWindows(
      input({
        events: [
          { tMs: 1_000, label: "Ctrl+C" },
          { tMs: 1_500, label: "Ctrl+V" },
        ],
        segments: [clip({ durationMs: 4_000, sourceOutMs: 4_000 })],
        durationMs: 4_000,
      }),
    )
    expect(windows).toEqual([
      { startMs: 1_000, endMs: 1_500, label: "Ctrl+C" },
      { startMs: 1_500, endMs: 2_900, label: "Ctrl+V" },
    ])
  })

  it("maps source time through speed and clip offset, clipping at output end", () => {
    const windows = buildKeystrokeWindows(
      input({
        events: [
          { tMs: 3_000, label: "Ctrl+Z" },
          { tMs: 5_500, label: "Ctrl+X" },
        ],
        segments: [
          clip({
            startMs: 500,
            durationMs: 2_000,
            sourceInMs: 2_000,
            sourceOutMs: 6_000,
            speed: 2,
          }),
        ],
        durationMs: 10_000,
      }),
    )
    expect(windows).toEqual([
      { startMs: 1_000, endMs: 2_250, label: "Ctrl+Z" },
      { startMs: 2_250, endMs: 2_500, label: "Ctrl+X" },
    ])
  })

  it("ignores events outside the half-open source window", () => {
    const windows = buildKeystrokeWindows(
      input({
        events: [
          { tMs: 1_999, label: "Ctrl+A" },
          { tMs: 6_000, label: "Ctrl+B" },
          { tMs: 3_000, label: "Ctrl+C" },
        ],
        segments: [
          clip({
            startMs: 500,
            durationMs: 2_000,
            sourceInMs: 2_000,
            sourceOutMs: 6_000,
            speed: 2,
          }),
        ],
      }),
    )
    expect(windows).toEqual([{ startMs: 1_000, endMs: 2_400, label: "Ctrl+C" }])
  })

  it("emits a window per use when one source clip is duplicated", () => {
    const windows = buildKeystrokeWindows(
      input({
        events: [{ tMs: 1_000, label: "Ctrl+C" }],
        segments: [
          clip({ id: "a", startMs: 0, durationMs: 4_000, sourceOutMs: 4_000 }),
          clip({ id: "b", startMs: 5_000, durationMs: 4_000, sourceOutMs: 4_000 }),
        ],
      }),
    )
    expect(windows.map((w) => w.startMs)).toEqual([1_000, 6_000])
  })

  it("rejects b-roll assets and disabled settings", () => {
    const events = [{ tMs: 100, label: "Ctrl+S" }]
    const segments = [clip({ assetId: "b-roll", durationMs: 1_000, sourceOutMs: 1_000 })]
    expect(buildKeystrokeWindows(input({ events, segments }))).toEqual([])
    expect(
      buildKeystrokeWindows(
        input({
          events,
          segments: [clip({ durationMs: 1_000, sourceOutMs: 1_000 })],
          settings: { enabled: false, durationMs: 1_400 },
        }),
      ),
    ).toEqual([])
  })

  it("rejects malformed labels and non-finite timestamps", () => {
    const windows = buildKeystrokeWindows(
      input({
        events: [
          { tMs: 100, label: "Ctrl+;drawtext" },
          { tMs: Number.NaN, label: "Ctrl+C" },
          { tMs: -5, label: "Ctrl+C" },
          { tMs: 200, label: "Ctrl+C" },
        ],
        segments: [clip({ durationMs: 4_000, sourceOutMs: 4_000 })],
      }),
    )
    expect(windows).toEqual([{ startMs: 200, endMs: 1_600, label: "Ctrl+C" }])
  })

  it("equal-time events keep input order — the later badge wins", () => {
    // B then A at the same timestamp: stable input order maps A's window
    // over B's, B's tail truncates to zero and is dropped (Rust fixture:
    // reverse-alphabetical equal-time input → only A).
    const windows = buildKeystrokeWindows(
      input({
        events: [
          { tMs: 1_000, label: "Ctrl+B" },
          { tMs: 1_000, label: "Ctrl+A" },
        ],
        segments: [clip({ durationMs: 4_000, sourceOutMs: 4_000 })],
      }),
    )
    expect(windows.map((w) => w.label)).toEqual(["Ctrl+A"])
  })

  it("C,V,C at the same timestamp — the later identical label wins (Rust parity)", () => {
    // A global dedupe on (t,label) would drop the second C and let V win;
    // parity requires retaining it so the LAST captured entry truncates
    // both earlier windows to zero.
    const windows = buildKeystrokeWindows(
      input({
        events: [
          { tMs: 1_000, label: "Ctrl+C" },
          { tMs: 1_000, label: "Ctrl+V" },
          { tMs: 1_000, label: "Ctrl+C" },
        ],
        segments: [clip({ durationMs: 4_000, sourceOutMs: 4_000 })],
      }),
    )
    expect(windows).toEqual([{ startMs: 1_000, endMs: 2_400, label: "Ctrl+C" }])
  })

  it("rejects non-finite speeds like the Rust mapper", () => {
    const windows = buildKeystrokeWindows(
      input({
        events: [{ tMs: 1_000, label: "Ctrl+C" }],
        segments: [
          clip({ id: "nan", durationMs: 4_000, sourceOutMs: 4_000, speed: Number.NaN }),
          clip({
            id: "inf",
            durationMs: 4_000,
            sourceOutMs: 4_000,
            speed: Number.POSITIVE_INFINITY,
          }),
          clip({ id: "ok", durationMs: 4_000, sourceOutMs: 4_000 }),
        ],
      }),
    )
    expect(windows).toEqual([{ startMs: 1_000, endMs: 2_400, label: "Ctrl+C" }])
  })
})

describe("activeKeystrokeWindow", () => {
  const windows = [
    { startMs: 1_000, endMs: 1_500, label: "Ctrl+C" },
    { startMs: 1_500, endMs: 2_900, label: "Ctrl+V" },
  ]

  it("finds the containing half-open window", () => {
    expect(activeKeystrokeWindow(windows, 1_000)?.label).toBe("Ctrl+C")
    expect(activeKeystrokeWindow(windows, 1_499)?.label).toBe("Ctrl+C")
    expect(activeKeystrokeWindow(windows, 1_500)?.label).toBe("Ctrl+V")
    expect(activeKeystrokeWindow(windows, 2_899)?.label).toBe("Ctrl+V")
    expect(activeKeystrokeWindow(windows, 2_900)).toBeNull()
    expect(activeKeystrokeWindow(windows, 500)).toBeNull()
  })
})
