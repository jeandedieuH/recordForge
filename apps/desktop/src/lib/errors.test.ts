import { describe, expect, it } from "vitest"
import { toErrorMessage } from "./errors"

describe("toErrorMessage", () => {
  it("translates error decoding response body into a human-friendly network error message", () => {
    expect(toErrorMessage(new Error("error decoding response body"))).toBe(
      "The update download was interrupted by a network timeout or connection reset. Please check your internet connection and try again.",
    )

    expect(
      toErrorMessage("error decoding response body: connection closed before message completed"),
    ).toBe(
      "The update download was interrupted by a network timeout or connection reset. Please check your internet connection and try again.",
    )
  })

  it("translates timeout errors into human-friendly messages", () => {
    expect(toErrorMessage(new Error("operation timed out"))).toBe(
      "The network request timed out. Please check your internet connection and try again.",
    )
  })

  it("preserves standard business and app error messages", () => {
    expect(toErrorMessage(new Error("No update is available."))).toBe("No update is available.")
    expect(
      toErrorMessage({
        category: "storage",
        code: "storage_failed",
        message: "failed to insert upload job: NOT NULL constraint failed",
      }),
    ).toBe("failed to insert upload job: NOT NULL constraint failed")
  })
})
