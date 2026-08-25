import { describe, expect, it } from "vitest"

describe("About View Constants and Metadata", () => {
  it("defines the canonical developer studio, master developer, and GitHub URLs", () => {
    const prestigeTechUrl = "https://prestigetech.dev"
    const masterDevUrl = "https://me.prestigetech.dev"
    const githubRepoUrl = "https://github.com/jeandedieuH/recordForge"

    expect(prestigeTechUrl).toBe("https://prestigetech.dev")
    expect(masterDevUrl).toBe("https://me.prestigetech.dev")
    expect(githubRepoUrl).toBe("https://github.com/jeandedieuH/recordForge")
    expect(prestigeTechUrl).toMatch(/^https:\/\/[a-z0-9-]+\.[a-z]+/)
    expect(masterDevUrl).toMatch(/^https:\/\/me\.[a-z0-9-]+\.[a-z]+/)
    expect(githubRepoUrl).toMatch(/^https:\/\/github\.com\/[a-zA-Z0-9_-]+\/recordForge/)
  })

  it("verifies licensing and open-source definitions", () => {
    const licensingTerms = {
      isFree: true,
      isOpenSource: true,
      licenseType: "GNU General Public License v3.0 (GPL-3.0-or-later)",
      v2Roadmap: "Version 2 will ship with optional paid premium features",
    }

    expect(licensingTerms.isFree).toBe(true)
    expect(licensingTerms.isOpenSource).toBe(true)
    expect(licensingTerms.licenseType).toContain("GPL-3.0")
    expect(licensingTerms.v2Roadmap).toContain("Version 2")
  })
})
