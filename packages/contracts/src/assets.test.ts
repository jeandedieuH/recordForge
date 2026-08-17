import { describe, expect, it } from "vitest"
import {
  assetDerivativeJobRequestSchema,
  assetImportRequestSchema,
  assetImportSkippedSchema,
  projectAssetPathMapSchema,
} from "./assets"

describe("project asset IPC contracts", () => {
  it("defaults imports to copying selected files", () => {
    expect(
      assetImportRequestSchema.parse({
        recordingId: "recording-1",
        paths: ["C:/Media/logo.svg"],
      }),
    ).toMatchObject({
      recordingId: "recording-1",
      strategy: "copy",
    })
  })

  it("validates derivative requests and asset-bin skip records", () => {
    expect(
      assetDerivativeJobRequestSchema.parse({
        recordingId: "recording-1",
        assetId: "asset-logo",
      }),
    ).toMatchObject({ force: false })
    expect(
      assetImportSkippedSchema.parse({
        sourceName: "notes.txt",
        reason: "unsupported media format",
      }).sourceName,
    ).toBe("notes.txt")
  })

  it("keeps resolved asset paths keyed by durable asset id", () => {
    expect(projectAssetPathMapSchema.parse({ "asset-logo": "C:/Project/assets/logo.svg" })).toEqual(
      {
        "asset-logo": "C:/Project/assets/logo.svg",
      },
    )
  })
})
