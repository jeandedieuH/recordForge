import { describe, expect, it, vi } from "vitest"
import {
  createVirtualBackgroundController,
  type VirtualBackgroundControllerDeps,
} from "./virtual-background-controller"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface Harness {
  deps: VirtualBackgroundControllerDeps
  hooks: {
    modelReady: ReturnType<typeof vi.fn>
    statusError: ReturnType<typeof vi.fn>
    downloadRatio: ReturnType<typeof vi.fn>
  }
  status: ReturnType<typeof vi.fn>
  download: ReturnType<typeof vi.fn>
  onProgress: ReturnType<typeof vi.fn>
  toast: ReturnType<typeof vi.fn>
}

function harness(): Harness {
  const hooks = { modelReady: vi.fn(), statusError: vi.fn(), downloadRatio: vi.fn() }
  const status = vi.fn(async () => ({ modelReady: true }))
  const download = vi.fn(async () => {})
  const onProgress = vi.fn(async () => () => {})
  const toast = vi.fn()
  return {
    hooks,
    status,
    download,
    onProgress,
    toast,
    deps: {
      getStatus: status,
      download,
      onProgress,
      toast,
      hooks,
    },
  }
}

describe("virtual-background controller", () => {
  it("a rapid double start runs ONE native download", async () => {
    const h = harness()
    const controller = createVirtualBackgroundController(h.deps)
    controller.mount()
    const progressGate = deferred<() => void>()
    const downloadGate = deferred<void>()
    h.onProgress.mockReturnValueOnce(progressGate.promise)
    h.download.mockReturnValueOnce(downloadGate.promise)

    const first = controller.startDownload()
    const second = controller.startDownload() // clicks before first await
    progressGate.resolve(() => {})
    downloadGate.resolve()
    await Promise.all([first, second])

    expect(h.onProgress).toHaveBeenCalledTimes(1)
    expect(h.download).toHaveBeenCalledTimes(1)
    expect(h.hooks.modelReady).toHaveBeenLastCalledWith(true)
  })

  it("unknown totalBytes reports indeterminate progress", async () => {
    const h = harness()
    const controller = createVirtualBackgroundController(h.deps)
    controller.mount()
    let emit: ((p: { downloadedBytes: number; totalBytes: number }) => void) | undefined
    h.onProgress.mockImplementationOnce((listener) => {
      emit = listener
      return Promise.resolve(() => {})
    })

    const run = controller.startDownload()
    await vi.waitFor(() => expect(h.download).toHaveBeenCalledTimes(1))
    emit?.({ downloadedBytes: 12_000, totalBytes: 0 })
    expect(h.hooks.downloadRatio).toHaveBeenCalledWith("indeterminate")
    await run
    // Idle again afterwards.
    expect(h.hooks.downloadRatio).toHaveBeenCalledWith(null)
  })

  it("listen rejection surfaces a toast and releases the in-flight guard", async () => {
    const h = harness()
    const controller = createVirtualBackgroundController(h.deps)
    controller.mount()
    h.onProgress.mockRejectedValueOnce(new Error("listener unavailable"))

    await controller.startDownload()
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "error", title: "Model download failed" }),
    )
    // The guard must reset — a second attempt starts fresh.
    await controller.startDownload()
    expect(h.download).toHaveBeenCalledTimes(1)
  })

  it("status failure → retry shows skeleton then content", async () => {
    const h = harness()
    h.status.mockRejectedValueOnce(new Error("probe failed"))
    const controller = createVirtualBackgroundController(h.deps)
    controller.mount()
    await vi.waitFor(() =>
      expect(h.hooks.statusError).toHaveBeenLastCalledWith(expect.stringContaining("probe failed")),
    )

    controller.retryStatus()
    // Retry first clears to loading (skeleton), then resolves the model state.
    expect(h.hooks.modelReady).toHaveBeenLastCalledWith(null)
    await vi.waitFor(() => expect(h.hooks.modelReady).toHaveBeenLastCalledWith(true))
  })

  it("completion after unmount writes nothing and leaves the listener stopped", async () => {
    const h = harness()
    const controller = createVirtualBackgroundController(h.deps)
    controller.mount()
    const unlisten = vi.fn()
    const downloadGate = deferred<void>()
    h.onProgress.mockResolvedValueOnce(unlisten)
    h.download.mockReturnValueOnce(downloadGate.promise)

    const run = controller.startDownload()
    await vi.waitFor(() => expect(h.download).toHaveBeenCalledTimes(1))
    controller.unmount()
    h.hooks.modelReady.mockClear()
    downloadGate.resolve()
    await run

    expect(h.hooks.modelReady).not.toHaveBeenCalled()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it("a remount re-arms writes (StrictMode setup→cleanup→setup)", async () => {
    const h = harness()
    const controller = createVirtualBackgroundController(h.deps)
    controller.mount()
    controller.unmount()
    controller.mount()
    await vi.waitFor(() => expect(h.hooks.modelReady).toHaveBeenLastCalledWith(true))
  })

  it("a late pre-download `false` status can't overwrite the post-download `true`", async () => {
    const h = harness()
    const controller = createVirtualBackgroundController(h.deps)
    // Mount probe is still in flight when the download starts.
    const probeGate = deferred<{ modelReady: boolean }>()
    h.status.mockReturnValueOnce(probeGate.promise)
    controller.mount()
    await controller.startDownload()
    expect(h.hooks.modelReady).toHaveBeenLastCalledWith(true)

    h.hooks.modelReady.mockClear()
    probeGate.resolve({ modelReady: false })
    await vi.waitFor(() => Promise.resolve())
    await Promise.resolve()
    // The stale probe was invalidated by the successful download.
    expect(h.hooks.modelReady).not.toHaveBeenCalled()
  })

  it("unmount during pending listener registration releases the fresh listener", async () => {
    const h = harness()
    const controller = createVirtualBackgroundController(h.deps)
    controller.mount()
    const registrationGate = deferred<() => void>()
    const unlisten = vi.fn()
    h.onProgress.mockReturnValueOnce(registrationGate.promise)

    const run = controller.startDownload()
    await vi.waitFor(() => expect(h.onProgress).toHaveBeenCalledTimes(1))
    controller.unmount()
    registrationGate.resolve(unlisten)
    await run

    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it("two controllers share ONE native provision through the seam", async () => {
    // The native model_provision mutex guarantees this in production; the
    // test proves both controller instances funnel through the same
    // provision operation rather than each opening a second download.
    const nativeCalls: string[] = []
    let inFlightProvision: Promise<void> | null = null
    const provision = () => {
      if (inFlightProvision) return inFlightProvision
      inFlightProvision = (async () => {
        nativeCalls.push("download")
        await Promise.resolve()
      })().finally(() => {
        inFlightProvision = null
      })
      return inFlightProvision
    }

    const hooks = () => ({
      modelReady: vi.fn(),
      statusError: vi.fn(),
      downloadRatio: vi.fn(),
    })
    const makeDeps = (): VirtualBackgroundControllerDeps => ({
      getStatus: vi.fn(async () => ({ modelReady: false })),
      download: provision,
      onProgress: vi.fn(async () => () => {}),
      toast: vi.fn(),
      hooks: hooks(),
    })
    const controllerA = createVirtualBackgroundController(makeDeps())
    const controllerB = createVirtualBackgroundController(makeDeps())
    controllerA.mount()
    controllerB.mount()

    await Promise.all([controllerA.startDownload(), controllerB.startDownload()])
    expect(nativeCalls).toEqual(["download"])
  })
})
