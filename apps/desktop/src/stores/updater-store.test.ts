import { beforeEach, describe, expect, it } from "vitest"
import { useUpdaterStore } from "./updater-store"

beforeEach(() => {
  useUpdaterStore.setState({
    status: "idle",
    update: null,
    readiness: null,
    errorMessage: null,
    downloadedBytes: 0,
    contentLength: null,
    isDownloaded: false,
    notifiedVersion: null,
  })
})

describe("updater store", () => {
  it("does not perform a network check outside a packaged Tauri application", async () => {
    await useUpdaterStore.getState().checkForUpdate()

    expect(useUpdaterStore.getState().status).toBe("up-to-date")
    expect(useUpdaterStore.getState().update).toBeNull()
  })

  it("reports an actionable error when installation starts without an update", async () => {
    await useUpdaterStore.getState().installUpdate()

    expect(useUpdaterStore.getState().status).toBe("error")
    expect(useUpdaterStore.getState().errorMessage).toBe("No update is available.")
  })
})
