import { describe, expect, it, vi } from "vitest"
import { toErrorMessage } from "../../../lib/errors"
import { loadProfilesForUploadDialog } from "./upload-dialog"

describe("upload dialog profile loading", () => {
  it("loads storage profiles when the dialog is opened", () => {
    const fetchProfiles = vi.fn().mockResolvedValue(undefined)

    loadProfilesForUploadDialog(true, fetchProfiles)

    expect(fetchProfiles).toHaveBeenCalledOnce()
  })

  it("does not load storage profiles while the dialog is closed", () => {
    const fetchProfiles = vi.fn().mockResolvedValue(undefined)

    loadProfilesForUploadDialog(false, fetchProfiles)

    expect(fetchProfiles).not.toHaveBeenCalled()
  })
})

describe("upload error handling", () => {
  it("preserves serialized Tauri AppError messages", () => {
    expect(
      toErrorMessage({
        category: "storage",
        code: "storage_failed",
        message: "failed to insert upload job: NOT NULL constraint failed",
      }),
    ).toBe("failed to insert upload job: NOT NULL constraint failed")
  })

  it("preserves native Error messages", () => {
    expect(toErrorMessage(new Error("S3 upload request failed"))).toBe("S3 upload request failed")
  })
})
