import { describe, expect, it, vi } from "vitest"

// Bare-IPC shape regressions: `list_shares` returns a bare array and
// `renew_share` a bare i64 — the wrappers must not reach into `.shares` or
// `.expiresAtMs`, and the validation schemas must accept the raw payloads.

const mocks = vi.hoisted(() => ({ invokeValidated: vi.fn() }))
vi.mock("./ipc", () => ({ invokeValidated: mocks.invokeValidated }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }))

const { listShares, renewShare } = await import("./share")

const sampleShare = {
  shareId: "share-1",
  url: "https://watch.example.com/abc",
  title: "Demo",
  status: "live",
  bytes: 4_096,
  views: 3,
  hasPassword: false,
  expiresAtMs: 1_702_592_000_000,
  createdAtMs: 1_700_000_000_000,
}

describe("share IPC wrappers", () => {
  it("listShares accepts the bare array the command returns", async () => {
    mocks.invokeValidated.mockResolvedValueOnce([sampleShare])
    const shares = await listShares()
    expect(shares).toHaveLength(1)
    expect(shares[0]?.shareId).toBe("share-1")
    expect(mocks.invokeValidated).toHaveBeenCalledWith("list_shares", undefined, expect.anything())
  })

  it("renewShare accepts the bare epoch-ms number the command returns", async () => {
    mocks.invokeValidated.mockResolvedValueOnce(1_702_592_000_000)
    await expect(renewShare("share-1")).resolves.toBe(1_702_592_000_000)
    expect(mocks.invokeValidated).toHaveBeenCalledWith(
      "renew_share",
      { shareId: "share-1" },
      expect.anything(),
    )
  })
})
