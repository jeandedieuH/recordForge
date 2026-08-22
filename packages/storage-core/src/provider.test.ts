import { describe, expect, test } from "vitest"
import {
  LocalStorageProvider,
  calculateProgress,
  formatBytes,
  formatEta,
  formatSpeed,
  isProfileReadyForUpload,
  isUploadActive,
  isUploadTerminal,
} from "./provider"

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

  test("formatting utilities format bytes, speed and ETA correctly", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(1024)).toBe("1 KB")
    expect(formatBytes(1024 * 1024 * 5)).toBe("5 MB")
    expect(formatBytes(1024 * 1024 * 1024 * 2.5)).toBe("2.5 GB")

    expect(formatSpeed(0)).toBe("0 KB/s")
    expect(formatSpeed(1024 * 1024 * 2.5)).toBe("2.5 MB/s")

    expect(formatEta(0)).toBe("--")
    expect(formatEta(-5)).toBe("--")
    expect(formatEta(45)).toBe("45s")
    expect(formatEta(125)).toBe("2m 5s")
  })

  test("calculateProgress computes progress and ETA properly", () => {
    const p1 = calculateProgress(50 * 1024 * 1024, 100 * 1024 * 1024, 10 * 1024 * 1024)
    expect(p1.percentage).toBe(50)
    expect(p1.speedBps).toBe(10 * 1024 * 1024)
    expect(p1.etaSeconds).toBe(5)

    const pZero = calculateProgress(0, 0, 0)
    expect(pZero.percentage).toBe(0)
    expect(pZero.etaSeconds).toBe(0)
  })

  test("state predicates identify active vs terminal states", () => {
    expect(isUploadActive("pending")).toBe(true)
    expect(isUploadActive("uploading")).toBe(true)
    expect(isUploadActive("completed")).toBe(false)
    expect(isUploadActive("failed")).toBe(false)

    expect(isUploadTerminal("completed")).toBe(true)
    expect(isUploadTerminal("failed")).toBe(true)
    expect(isUploadTerminal("cancelled")).toBe(true)
    expect(isUploadTerminal("uploading")).toBe(false)
  })

  test("isProfileReadyForUpload checks profile completeness", () => {
    expect(
      isProfileReadyForUpload({
        id: "p1",
        name: "Local",
        kind: "local",
        isDefault: true,
        localConfig: { destinationPath: "C:\\Videos" },
        hasCredentials: true,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      }),
    ).toBe(true)

    expect(
      isProfileReadyForUpload({
        id: "p2",
        name: "S3",
        kind: "s3",
        isDefault: false,
        s3Config: {
          endpoint: "https://s3.amazonaws.com",
          bucket: "my-bucket",
          region: "us-east-1",
          prefix: "",
          partSizeBytes: 8388608,
          forcePathStyle: false,
        },
        hasCredentials: false, // missing secrets
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      }),
    ).toBe(false)

    expect(
      isProfileReadyForUpload({
        id: "p2",
        name: "S3",
        kind: "s3",
        isDefault: false,
        s3Config: {
          endpoint: "https://s3.amazonaws.com",
          bucket: "my-bucket",
          region: "us-east-1",
          prefix: "",
          partSizeBytes: 8388608,
          forcePathStyle: false,
        },
        hasCredentials: true,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      }),
    ).toBe(true)
  })
})
