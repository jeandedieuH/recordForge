import { describe, expect, test } from "vitest"
import { LocalStorageProvider } from "./provider"

describe("Storage Core Provider", () => {
  test("local storage provider completes upload", async () => {
    const provider = new LocalStorageProvider()
    let reported = false

    const result = await provider.upload({
      localPath: "/tmp/export.mp4",
      destinationName: "export.mp4",
      onProgress: (p) => {
        reported = p.percentage === 100
      },
    })

    expect(result.ok).toBe(true)
    expect(result.url).toBe("/tmp/export.mp4")
    expect(reported).toBe(true)
  })
})
