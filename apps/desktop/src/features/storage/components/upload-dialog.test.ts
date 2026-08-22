import { describe, expect, it } from "vitest"
import { toErrorMessage } from "../../../lib/errors"

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
