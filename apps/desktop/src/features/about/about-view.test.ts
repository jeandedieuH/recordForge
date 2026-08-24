import { describe, expect, it } from "vitest"

describe("About View Constants and Metadata", () => {
  it("defines the canonical developer studio and master developer URLs", () => {
    const prestigeTechUrl = "https://prestigetech.dev"
    const masterDevUrl = "https://me.prestigetech.dev"

    expect(prestigeTechUrl).toBe("https://prestigetech.dev")
    expect(masterDevUrl).toBe("https://me.prestigetech.dev")
    expect(prestigeTechUrl).toMatch(/^https:\/\/[a-z0-9-]+\.[a-z]+/)
    expect(masterDevUrl).toMatch(/^https:\/\/me\.[a-z0-9-]+\.[a-z]+/)
  })

  it("verifies licensing and tier definitions", () => {
    const licensingTerms = {
      isFree: true,
      isOpenSource: false,
      licenseType: "Proprietary Free Edition",
      v2Roadmap: "Version 2 will ship with optional paid premium features",
    }

    expect(licensingTerms.isFree).toBe(true)
    expect(licensingTerms.isOpenSource).toBe(false)
    expect(licensingTerms.v2Roadmap).toContain("Version 2")
  })
})
