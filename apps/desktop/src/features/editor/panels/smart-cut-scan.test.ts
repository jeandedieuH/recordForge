import { describe, expect, it, vi } from "vitest"
import type { RenderPlan } from "@recordforge/contracts"
import {
  createSmartCutScanRunner,
  runSmartCutScan,
  startPauseAudition,
  SMART_CUT_AUDITION_LEAD_MS,
  type SmartCutScanDeps,
} from "./smart-cut-scan"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function deps(overrides: Partial<SmartCutScanDeps> = {}): SmartCutScanDeps {
  return {
    save: vi.fn(async () => {}),
    saveFailed: () => false,
    buildPlan: () => ({ ok: true, value: { durationMs: 10_000 } as RenderPlan }),
    detect: vi.fn(async () => ({
      ranges: [{ startMs: 1_000, endMs: 2_000 }],
      thresholdDb: -35,
      noiseFloorDb: -49,
      calibration: "manual" as const,
    })),
    isStale: () => false,
    durationMs: 10_000,
    paddingMs: 120,
    ...overrides,
  }
}

describe("runSmartCutScan", () => {
  it("saves, scans, and returns padded ranges", async () => {
    const save = vi.fn(async () => {})
    const outcome = await runSmartCutScan(deps({ save }))
    expect(save).toHaveBeenCalledOnce()
    expect(outcome).toEqual({
      status: "success",
      ranges: [{ startMs: 1_120, endMs: 1_880 }],
      wholeTimeline: false,
      thresholdDb: -35,
      noiseFloorDb: -49,
      calibration: "manual",
    })
  })

  it("aborts with an error when the save fails", async () => {
    const detect = vi.fn()
    const outcome = await runSmartCutScan(deps({ saveFailed: () => true, detect }))
    expect(detect).not.toHaveBeenCalled()
    expect(outcome.status).toBe("error")
  })

  it("returns stale when an edit lands while detection is pending", async () => {
    const pending = deferred<import("@recordforge/contracts").SilenceScanResult>()
    let edited = false
    const outcome = runSmartCutScan(deps({ detect: () => pending.promise, isStale: () => edited }))
    edited = true // user committed an edit mid-scan
    pending.resolve({
      ranges: [{ startMs: 1_000, endMs: 2_000 }],
      thresholdDb: -23.9,
      noiseFloorDb: -29.3,
      calibration: "adaptive",
    })
    expect(await outcome).toEqual({ status: "stale" })
  })

  it("returns stale when the scan is stale before detection even starts", async () => {
    const detect = vi.fn()
    expect(await runSmartCutScan(deps({ detect, isStale: () => true }))).toEqual({
      status: "stale",
    })
    expect(detect).not.toHaveBeenCalled()
  })

  it("surfaces a rejected AppError object's message", async () => {
    const outcome = await runSmartCutScan(
      deps({
        detect: () =>
          Promise.reject({
            category: "media",
            code: "internal",
            message:
              "The edited timeline has no audible audio — unmute a track or add audio, then scan again.",
          }),
      }),
    )
    expect(outcome).toEqual({
      status: "error",
      message:
        "The edited timeline has no audible audio — unmute a track or add audio, then scan again.",
    })
  })

  it("maps a rejected AppError to stale when the scan was superseded", async () => {
    const outcome = await runSmartCutScan(
      deps({
        detect: () => Promise.reject({ code: "smart_cut_cancelled", message: "cancelled" }),
        isStale: () => true,
      }),
    )
    expect(outcome).toEqual({ status: "stale" })
  })
})

describe("createSmartCutScanRunner", () => {
  it("admits a single scan — a rapid second call returns null", async () => {
    const runner = createSmartCutScanRunner()
    const pending = deferred<import("@recordforge/contracts").SilenceScanResult>()
    const first = runner.start(deps({ detect: () => pending.promise }))
    expect(first).not.toBeNull()
    expect(runner.start(deps())).toBeNull()
    pending.resolve({ ranges: [], thresholdDb: -40, noiseFloorDb: null, calibration: "adaptive" })
    await first
    expect(runner.isRunning()).toBe(false)
  })

  it("cancel invalidates the in-flight scan and admits the next one", async () => {
    const runner = createSmartCutScanRunner()
    const pending = deferred<import("@recordforge/contracts").SilenceScanResult>()
    const first = runner.start(deps({ detect: () => pending.promise }))
    runner.cancel()
    pending.resolve({ ranges: [], thresholdDb: -40, noiseFloorDb: null, calibration: "adaptive" })
    expect(await first).toEqual({ status: "stale" })
    const next = runner.start(deps())
    expect(next).not.toBeNull()
    expect((await next)?.status).toBe("success")
  })
})

describe("startPauseAudition", () => {
  function fakeStore() {
    const calls: string[] = []
    const listeners = new Set<(ms: number) => void>()
    return {
      calls,
      fire: (ms: number) => listeners.forEach((listener) => listener(ms)),
      pause: () => calls.push("pause"),
      play: () => calls.push("play"),
      seek: (ms: number) => calls.push(`seek:${ms}`),
      subscribePlayhead: (listener: (ms: number) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      listenerCount: () => listeners.size,
    }
  }

  it("pauses, seeks with lead, plays, then stops at end+tail", () => {
    const store = fakeStore()
    startPauseAudition(store, { startMs: 1_000, endMs: 2_000 }, 10_000)
    expect(store.calls).toEqual(["pause", `seek:${1_000 - SMART_CUT_AUDITION_LEAD_MS}`, "play"])

    store.fire(2_000) // still inside the audition window — no new calls
    expect(store.calls).toHaveLength(3)

    store.fire(2_250) // end + 250ms tail
    expect(store.calls[store.calls.length - 1]).toBe("pause")
    expect(store.listenerCount()).toBe(0)
  })

  it("clamps the seek lead and the stop point to the timeline", () => {
    const store = fakeStore()
    startPauseAudition(store, { startMs: 100, endMs: 9_900 }, 10_000)
    expect(store.calls[1]).toBe("seek:0")
    store.fire(10_001)
    expect(store.calls[store.calls.length - 1]).toBe("pause")
  })

  it("stop handle unsubscribes and pauses immediately", () => {
    const store = fakeStore()
    const stop = startPauseAudition(store, { startMs: 1_000, endMs: 2_000 }, 10_000)
    store.calls.length = 0
    stop()
    expect(store.calls).toEqual(["pause"])
    expect(store.listenerCount()).toBe(0)
    stop() // idempotent
    expect(store.calls).toEqual(["pause"])
  })
})
