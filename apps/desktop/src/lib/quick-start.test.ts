import { describe, expect, it, vi } from "vitest"
import { DEVICE_RELEASE_DELAY_MS, runQuickStart } from "./quick-start"

function harness(overrides: Partial<Parameters<typeof runQuickStart>[0]> = {}) {
  const closeSetup = vi.fn()
  const start = vi.fn(async () => {})
  const onError = vi.fn()
  const wait = vi.fn(async () => {})
  const deps = {
    isStartPending: false,
    needsDeviceRelease: false,
    closeSetup,
    start,
    onError,
    wait,
    ...overrides,
  }
  return { deps, closeSetup, start, onError, wait }
}

describe("runQuickStart", () => {
  it("runs the same start path as the setup dialog's Start button", async () => {
    const { deps, closeSetup, start, onError, wait } = harness()

    await runQuickStart(deps)

    expect(closeSetup).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
    expect(wait).not.toHaveBeenCalled()
  })

  it("ignores a repeated press while a start is already in flight", async () => {
    const { deps, closeSetup, start } = harness({ isStartPending: true })

    await runQuickStart(deps)

    expect(closeSetup).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it("releases the camera before starting, after closing the dialog", async () => {
    const { deps, closeSetup, start, wait } = harness({ needsDeviceRelease: true })

    await runQuickStart(deps)

    expect(wait).toHaveBeenCalledWith(DEVICE_RELEASE_DELAY_MS)
    expect(closeSetup.mock.invocationCallOrder[0]).toBeLessThan(wait.mock.invocationCallOrder[0]!)
    expect(wait.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0]!)
  })

  it("routes guard failures to onError instead of rejecting", async () => {
    const failure = new Error("Save the current editor changes before recording.")
    const { deps, onError } = harness({
      start: vi.fn().mockRejectedValue(failure),
    })

    await expect(runQuickStart(deps)).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledWith(failure)
  })
})
