import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CaptureSource } from "@recordforge/contracts"

vi.mock("../../../lib/recorder", () => ({
  captureSourcePreviews: vi.fn(),
}))

import { captureSourcePreviews } from "../../../lib/recorder"
import {
  peekSourcePreview,
  prefetchSourcePreviews,
  rememberSourcePreview,
  settleSourcePreviews,
  sourcePreviewKey,
} from "./source-preview-cache"

// Unique ids per test keep the module-level cache from leaking between cases.
function display(id: string, x = 0): CaptureSource {
  return {
    kind: "display",
    id,
    name: id,
    bounds: { x, y: 0, width: 1920, height: 1080 },
  }
}

describe("source preview cache", () => {
  beforeEach(() => {
    vi.mocked(captureSourcePreviews).mockReset()
  })

  it("keys a target by kind, id and rectangle", () => {
    expect(sourcePreviewKey(display("display-a", 1920))).toBe("display:display-a:1920,0,1920x1080")
  })

  it("prefetches every distinct source in one native call", async () => {
    const first = display("display-b", 0)
    const second = display("display-c", 1920)
    vi.mocked(captureSourcePreviews).mockResolvedValue(["/tmp/a.jpg", "/tmp/b.jpg"])

    await prefetchSourcePreviews([first, second, first])

    expect(captureSourcePreviews).toHaveBeenCalledTimes(1)
    expect(captureSourcePreviews).toHaveBeenCalledWith([first, second])
    expect(peekSourcePreview(first)).toBe("/tmp/a.jpg")
    expect(peekSourcePreview(second)).toBe("/tmp/b.jpg")
  })

  it("leaves unavailable sources uncached so the next open retries", async () => {
    const source = display("display-d")
    vi.mocked(captureSourcePreviews).mockResolvedValue([null])

    await prefetchSourcePreviews([source])

    expect(peekSourcePreview(source)).toBeUndefined()
  })

  it("forgets a source whose still disappeared", () => {
    const source = display("display-e")
    rememberSourcePreview(source, "/tmp/stale.jpg")
    rememberSourcePreview(source, null)
    expect(peekSourcePreview(source)).toBeUndefined()
  })

  it("settles immediately when no prefetch is running", async () => {
    await expect(settleSourcePreviews()).resolves.toBeUndefined()
  })

  it("lets a card wait for the running prefetch instead of grabbing twice", async () => {
    const source = display("display-f")
    let resolveFetch: (paths: (string | null)[]) => void = () => {}
    vi.mocked(captureSourcePreviews).mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve
      }),
    )

    const prefetch = prefetchSourcePreviews([source])
    let settled = false
    const waiting = settleSourcePreviews().then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)

    resolveFetch(["/tmp/f.jpg"])
    await Promise.all([prefetch, waiting])

    expect(settled).toBe(true)
    expect(peekSourcePreview(source)).toBe("/tmp/f.jpg")
  })
})
