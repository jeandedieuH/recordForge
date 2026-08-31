import { describe, expect, it } from "vitest"
import { updateDownloadEventSchema, updateMetadataSchema, updateReadinessSchema } from "./updates"

describe("Update contracts", () => {
  it("parses signed update metadata with nullable release notes", () => {
    const metadata = updateMetadataSchema.parse({
      version: "1.0.1",
      currentVersion: "1.2.3",
      body: null,
      pubDate: "2026-08-25T12:00:00Z",
    })

    expect(metadata.version).toBe("1.0.1")
    expect(metadata.body).toBeNull()
  })

  it("parses native readiness blockers", () => {
    const readiness = updateReadinessSchema.parse({
      canInstall: false,
      blockers: ["media-job-active", "upload-active"],
    })

    expect(readiness.blockers).toEqual(["media-job-active", "upload-active"])
  })

  it("parses compact download progress events", () => {
    expect(
      updateDownloadEventSchema.parse({
        event: "Progress",
        data: { chunkLength: 4096 },
      }),
    ).toEqual({
      event: "Progress",
      data: { chunkLength: 4096 },
    })
  })
})
