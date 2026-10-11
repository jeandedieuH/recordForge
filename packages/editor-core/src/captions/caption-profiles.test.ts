import { describe, expect, it } from "vitest"
import { profileForCanvas } from "./caption-profiles"

describe("caption aspect profiles", () => {
  it("selects the profile for explicit aspect ratios", () => {
    expect(profileForCanvas({ width: 1920, height: 1080, aspectRatio: "9:16" }).ratio).toBe("9:16")
  })

  it("matches standard canvases by dimensions", () => {
    expect(profileForCanvas({ width: 1920, height: 1080 }).ratio).toBe("16:9")
    expect(profileForCanvas({ width: 1080, height: 1920 }).ratio).toBe("9:16")
    expect(profileForCanvas({ width: 1080, height: 1080 }).ratio).toBe("1:1")
    expect(profileForCanvas({ width: 1350, height: 1080 }).ratio).toBe("5:4")
    expect(profileForCanvas({ width: 1080, height: 1350 }).ratio).toBe("4:5")
    expect(profileForCanvas({ width: 3840, height: 2160 }).ratio).toBe("16:9")
  })

  it("free-form canvases snap to the nearest ratio", () => {
    expect(profileForCanvas({ width: 1800, height: 1000 }).ratio).toBe("16:9")
    expect(profileForCanvas({ width: 1000, height: 1800 }).ratio).toBe("9:16")
    expect(profileForCanvas({ width: 1200, height: 1000 }).ratio).toBe("5:4")
  })
})
