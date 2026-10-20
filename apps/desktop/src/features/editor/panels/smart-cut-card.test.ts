import { describe, expect, it, vi } from "vitest"
import type {
  ProjectExportSettings,
  recordForgeProject,
  RenderPlan,
  SilenceScanResult,
  TimelineState,
} from "@recordforge/contracts"
import {
  formatSilenceClock,
  isSmartCutResultStale,
  isSmartCutRunStale,
  selectedSmartCutRanges,
  smartCutConfigEquals,
  smartCutDetectionSettings,
  type SmartCutResult,
  type SmartCutRunContext,
} from "./smart-cut-model"
import {
  createSmartCutSession,
  type SmartCutSessionDeps,
  type SmartCutSessionState,
} from "./smart-cut-scan"

const config = { thresholdDb: -35 as number | null, minDurationMs: 500, paddingMs: 120 }

function result(overrides: Partial<SmartCutResult> = {}): SmartCutResult {
  return {
    ranges: [{ startMs: 1_000, endMs: 2_000 }],
    wholeTimeline: false,
    thresholdDb: -35,
    noiseFloorDb: -49,
    calibration: "manual",
    config,
    // The staleness check compares identity — a distinct object is enough.
    present: {} as unknown as TimelineState,
    projectRevision: 7,
    recordingId: "rec-1",
    durationMs: 10_000,
    ...overrides,
  }
}

function run(overrides: Partial<SmartCutRunContext> = {}): SmartCutRunContext {
  return {
    scanId: "scan-1",
    recordingId: "rec-1",
    present: {} as unknown as TimelineState,
    projectRevision: 7,
    config,
    ...overrides,
  }
}

describe("smartCutConfigEquals", () => {
  it("matches identical configs and detects any field change", () => {
    expect(smartCutConfigEquals(config, { ...config })).toBe(true)
    expect(smartCutConfigEquals(config, { ...config, thresholdDb: -25 })).toBe(false)
    expect(smartCutConfigEquals(config, { ...config, minDurationMs: 300 })).toBe(false)
    expect(smartCutConfigEquals(config, { ...config, paddingMs: 200 })).toBe(false)
  })
})

describe("isSmartCutRunStale", () => {
  it("is fresh while all captured inputs still match", () => {
    const r = run()
    expect(
      isSmartCutRunStale(r, {
        present: r.present,
        recordingId: "rec-1",
        projectRevision: 7,
      }),
    ).toBe(false)
  })

  it("goes stale on timeline, recording, or revision changes", () => {
    const r = run()
    expect(
      isSmartCutRunStale(r, {
        present: {} as unknown as TimelineState,
        recordingId: "rec-1",
        projectRevision: 7,
      }),
    ).toBe(true)
    expect(
      isSmartCutRunStale(r, { present: r.present, recordingId: "rec-2", projectRevision: 7 }),
    ).toBe(true)
    expect(
      isSmartCutRunStale(r, { present: r.present, recordingId: "rec-1", projectRevision: 8 }),
    ).toBe(true)
  })
})

describe("isSmartCutResultStale", () => {
  it("is never stale without a result", () => {
    expect(
      isSmartCutResultStale({
        result: null,
        present: null,
        recordingId: "rec-1",
        config,
      }),
    ).toBe(false)
  })

  it("is fresh while the captured timeline object is still current", () => {
    const captured = result()
    expect(
      isSmartCutResultStale({
        result: captured,
        present: captured.present,
        recordingId: "rec-1",
        projectRevision: captured.projectRevision,
        config,
      }),
    ).toBe(false)
  })

  it("goes stale when the committed timeline changes", () => {
    const captured = result()
    expect(
      isSmartCutResultStale({
        result: captured,
        present: {} as unknown as TimelineState,
        recordingId: "rec-1",
        config,
      }),
    ).toBe(true)
  })

  it("goes stale when the recording, revision, or scan config changes", () => {
    const captured = result()
    expect(
      isSmartCutResultStale({
        result: captured,
        present: captured.present,
        recordingId: "rec-2",
        config,
      }),
    ).toBe(true)
    expect(
      isSmartCutResultStale({
        result: captured,
        present: captured.present,
        recordingId: "rec-1",
        projectRevision: 9,
        config,
      }),
    ).toBe(true)
    expect(
      isSmartCutResultStale({
        result: captured,
        present: captured.present,
        recordingId: "rec-1",
        config: { ...config, paddingMs: 80 },
      }),
    ).toBe(true)
  })
})

describe("selectedSmartCutRanges", () => {
  const ranges = [
    { startMs: 0, endMs: 100 },
    { startMs: 200, endMs: 400 },
    { startMs: 500, endMs: 900 },
  ]

  it("returns only the selected ranges in order", () => {
    expect(selectedSmartCutRanges(ranges, new Set([0, 2]))).toEqual([ranges[0], ranges[2]])
    expect(selectedSmartCutRanges(ranges, new Set())).toEqual([])
  })
})

describe("smartCutDetectionSettings", () => {
  it("clears a persisted selected-range preset and range", () => {
    const settings = {
      preset: "selected-range",
      range: { startMs: 0, endMs: 1_000 },
      keystrokeOverlay: { enabled: true },
    } as ProjectExportSettings
    const detection = smartCutDetectionSettings(settings)
    expect(detection.preset).toBe("default-mp4")
    expect(detection.range).toBeUndefined()
    expect(detection.keystrokeOverlay.enabled).toBe(true)
  })

  it("keeps other presets untouched while dropping any range", () => {
    const settings = {
      preset: "high-quality",
      range: { startMs: 0, endMs: 1_000 },
    } as ProjectExportSettings
    expect(smartCutDetectionSettings(settings).preset).toBe("high-quality")
  })
})

describe("formatSilenceClock", () => {
  it("formats minute:second.millisecond positions", () => {
    expect(formatSilenceClock(0)).toBe("0:00.000")
    expect(formatSilenceClock(83_000)).toBe("1:23.000")
    expect(formatSilenceClock(1_120)).toBe("0:01.120")
    expect(formatSilenceClock(300)).toBe("0:00.300")
    expect(formatSilenceClock(3_600_000)).toBe("60:00.000")
  })
})

// ---------------------------------------------------------------------------
// Caller seam: createSmartCutSession ownership protocol — StrictMode cycles,
// superseded runs, invalidation, stale apply, and audition/unmount cleanup.
// ---------------------------------------------------------------------------

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function scanOutcome(overrides: Partial<SilenceScanResult> = {}): SilenceScanResult {
  return {
    ranges: [{ startMs: 1_000, endMs: 2_000 }],
    thresholdDb: -35,
    noiseFloorDb: -49,
    calibration: "manual",
    ...overrides,
  } as SilenceScanResult
}

interface SessionHarness {
  deps: SmartCutSessionDeps
  hooks: {
    phase: ReturnType<typeof vi.fn>
    scanError: ReturnType<typeof vi.fn>
    result: ReturnType<typeof vi.fn>
    selected: ReturnType<typeof vi.fn>
    toast: ReturnType<typeof vi.fn>
  }
  state: SmartCutSessionState
  detect: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  audition: {
    pause: ReturnType<typeof vi.fn>
    play: ReturnType<typeof vi.fn>
    seek: ReturnType<typeof vi.fn>
  }
  playheadListeners: Set<(ms: number) => void>
}

function sessionHarness(overrides: Partial<SmartCutSessionState> = {}): SessionHarness {
  const present = { tracks: [], markers: [] } as unknown as TimelineState
  const state: SmartCutSessionState = {
    engine: { history: { present } } as unknown as SmartCutSessionState["engine"],
    project: {
      id: "proj-1",
      assets: [] as unknown as recordForgeProject["assets"],
      exportSettings: {} as ProjectExportSettings,
    },
    recording: { id: "rec-1" },
    projectRevision: 7,
    ...overrides,
  }
  const hooks = {
    phase: vi.fn(),
    scanError: vi.fn(),
    result: vi.fn(),
    selected: vi.fn(),
    toast: vi.fn(),
  }
  const detect = vi.fn()
  const save = vi.fn(async () => {})
  const cancel = vi.fn(async () => {})
  const playheadListeners = new Set<(ms: number) => void>()
  const audition = {
    pause: vi.fn(),
    play: vi.fn(),
    seek: vi.fn(),
    subscribePlayhead: (listener: (ms: number) => void) => {
      playheadListeners.add(listener)
      return () => playheadListeners.delete(listener)
    },
  }
  let next = 0
  const deps: SmartCutSessionDeps = {
    getState: () => state,
    getTier: () => "pro",
    saveFailed: () => false,
    save,
    execute: vi.fn(() => true),
    buildPlan: () => ({ ok: true, value: { durationMs: 10_000 } as RenderPlan }),
    detect,
    cancel,
    openUpgrade: vi.fn(),
    audition,
    hooks,
    newScanId: () => `scan-${++next}`,
  }
  return { deps, hooks, state, detect, save, cancel, audition, playheadListeners }
}

describe("createSmartCutSession", () => {
  it("survives a StrictMode setup → cleanup → setup cycle and still scans", async () => {
    const h = sessionHarness()
    const session = createSmartCutSession(h.deps)

    session.mount()
    session.unmount() // StrictMode cleanup — must not poison future runs
    session.mount()

    h.detect.mockResolvedValue(scanOutcome())
    await session.scan(config)
    expect(h.hooks.phase).toHaveBeenLastCalledWith("review")
    expect(h.hooks.result).toHaveBeenCalled()
  })

  it("cancel A → start B: late A success cannot disturb B", async () => {
    const h = sessionHarness()
    const session = createSmartCutSession(h.deps)
    session.mount()

    const a = deferred<SilenceScanResult>()
    h.detect.mockReturnValueOnce(a.promise)
    const scanA = session.scan(config)
    expect(h.hooks.phase).toHaveBeenLastCalledWith("scanning")
    // Wait until A is actually awaiting its native detect before cancelling —
    // otherwise it goes stale post-save and never models "in-flight".
    await vi.waitFor(() => expect(h.detect).toHaveBeenCalledTimes(1))

    session.cancelScan() // invalidates A, frees admission
    const b = deferred<SilenceScanResult>()
    h.detect.mockReturnValueOnce(b.promise)
    const scanB = session.scan(config)

    a.resolve(scanOutcome()) // late A success arrives during B
    await scanA
    expect(h.hooks.result).not.toHaveBeenCalled()

    b.resolve(scanOutcome())
    await scanB
    expect(h.hooks.result).toHaveBeenCalled()
    expect(h.hooks.phase).toHaveBeenLastCalledWith("review")
    // Native cancel targeted A's scan id — never B's.
    expect(h.cancel).toHaveBeenCalledWith("rec-1", "scan-1")
  })

  it("cancel A → start B: late A rejection cannot error B", async () => {
    const h = sessionHarness()
    const session = createSmartCutSession(h.deps)
    session.mount()

    const a = deferred<SilenceScanResult>()
    h.detect.mockReturnValueOnce(a.promise)
    const scanA = session.scan(config)
    await vi.waitFor(() => expect(h.detect).toHaveBeenCalledTimes(1))
    session.cancelScan()
    const b = deferred<SilenceScanResult>()
    h.detect.mockReturnValueOnce(b.promise)
    const scanB = session.scan(config)

    a.reject(new Error("native boom")) // late A failure
    await scanA
    expect(h.hooks.scanError).not.toHaveBeenCalledWith(expect.stringContaining("boom"))

    b.resolve(scanOutcome())
    await scanB
    expect(h.hooks.phase).toHaveBeenLastCalledWith("review")
  })

  it("input change while scanning cancels the owned native run", async () => {
    const h = sessionHarness()
    const session = createSmartCutSession(h.deps)
    session.mount()

    const a = deferred<SilenceScanResult>()
    h.detect.mockReturnValueOnce(a.promise)
    const scanA = session.scan(config)
    expect(h.hooks.phase).toHaveBeenLastCalledWith("scanning")
    await vi.waitFor(() => expect(h.detect).toHaveBeenCalledTimes(1))

    // Threshold control changes mid-scan — must invalidate + cancel natively.
    session.checkInvalidation({ ...config, thresholdDb: -25 }, null)
    expect(h.cancel).toHaveBeenCalledWith("rec-1", "scan-1")
    expect(h.hooks.phase).toHaveBeenLastCalledWith("idle")

    a.resolve(scanOutcome())
    await scanA
    expect(h.hooks.result).not.toHaveBeenCalled()
  })

  it("timeline edit while scanning invalidates the run without a config change", async () => {
    const h = sessionHarness()
    const session = createSmartCutSession(h.deps)
    session.mount()
    const a = deferred<SilenceScanResult>()
    h.detect.mockReturnValueOnce(a.promise)
    const scanA = session.scan(config)

    // A committed edit replaces `present`.
    h.state.engine = {
      history: { present: { tracks: ["changed"] } as unknown as TimelineState },
    } as unknown as SmartCutSessionState["engine"]
    session.checkInvalidation(config, null)
    expect(h.cancel).toHaveBeenCalledWith("rec-1", "scan-1")

    a.resolve(scanOutcome())
    await scanA
    expect(h.hooks.result).not.toHaveBeenCalled()
  })

  it("seek alone does not invalidate (playhead is view state)", async () => {
    const h = sessionHarness()
    const session = createSmartCutSession(h.deps)
    session.mount()
    const a = deferred<SilenceScanResult>()
    h.detect.mockReturnValueOnce(a.promise)
    const scanA = session.scan(config)

    // checkInvalidation only fires on edit/config deps — calling it with
    // identical inputs proves a seek-shaped effect run is a no-op.
    session.checkInvalidation(config, null)
    expect(h.cancel).not.toHaveBeenCalled()
    a.resolve(scanOutcome())
    await scanA
    expect(h.hooks.phase).toHaveBeenLastCalledWith("review")
  })

  it("stale apply is rejected synchronously — no execute, result cleared", () => {
    const h = sessionHarness()
    const session = createSmartCutSession(h.deps)
    session.mount()
    const stale = result()

    session.apply(stale, new Set([0]), config)
    expect(h.deps.execute).not.toHaveBeenCalled()
    expect(h.hooks.result).toHaveBeenCalledWith(null)
    expect(h.hooks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Scan is out of date" }),
    )
  })

  it("fresh apply executes one ripple delete and clears to idle", () => {
    const h = sessionHarness()
    const session = createSmartCutSession(h.deps)
    session.mount()
    const present = h.state.engine!.history.present
    const fresh = result({ present, projectRevision: 7 })

    session.apply(fresh, new Set([0]), config)
    expect(h.deps.execute).toHaveBeenCalled()
    expect(h.hooks.phase).toHaveBeenLastCalledWith("idle")
  })

  it("a config change immediately before apply is rejected without any invalidation pass", () => {
    // The effect may not have run yet — apply rechecks the LIVE config
    // against the result's, not result.config against itself.
    const h = sessionHarness()
    const session = createSmartCutSession(h.deps)
    session.mount()
    const present = h.state.engine!.history.present
    const fresh = result({ present, projectRevision: 7 })

    session.apply(fresh, new Set([0]), { ...config, thresholdDb: -25 })
    expect(h.deps.execute).not.toHaveBeenCalled()
    expect(h.hooks.result).toHaveBeenCalledWith(null)
    expect(h.hooks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Scan is out of date" }),
    )
  })

  it("unmount stops audition and cancels only the owned native scan", async () => {
    const h = sessionHarness()
    const session = createSmartCutSession(h.deps)
    session.mount()

    const a = deferred<SilenceScanResult>()
    h.detect.mockReturnValueOnce(a.promise)
    const scanA = session.scan(config)
    session.previewPause({ startMs: 100, endMs: 300 }, result())
    expect(h.playheadListeners.size).toBe(1)

    session.unmount()
    expect(h.playheadListeners.size).toBe(0)
    expect(h.cancel).toHaveBeenCalledWith("rec-1", "scan-1")

    // A second mount doesn't re-cancel (the owned run is already gone).
    session.mount()
    a.resolve(scanOutcome())
    await scanA
    expect(h.hooks.result).not.toHaveBeenCalled()
  })
})
