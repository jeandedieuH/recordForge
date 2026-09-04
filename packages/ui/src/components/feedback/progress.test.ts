import { describe, expect, it } from "vitest"

describe("Progress value normalization logic", () => {
  it("normalizes 0..1 fractions to 0..100 percentage range", () => {
    const normalize = (value: number) => {
      const normalized = value > 1 ? value : value * 100
      return Math.min(100, Math.max(0, Number.isFinite(normalized) ? normalized : 0))
    }

    expect(normalize(0)).toBe(0)
    expect(normalize(0.15)).toBe(15)
    expect(normalize(0.64)).toBe(64)
    expect(normalize(0.8)).toBe(80)
    expect(normalize(1.0)).toBe(100)
  })

  it("normalizes pre-scaled 0..100 percentages without double multiplying", () => {
    const normalize = (value: number) => {
      const normalized = value > 1 ? value : value * 100
      return Math.min(100, Math.max(0, Number.isFinite(normalized) ? normalized : 0))
    }

    expect(normalize(64)).toBe(64)
    expect(normalize(80)).toBe(80)
    expect(normalize(100)).toBe(100)
  })

  it("clamps negative values and values exceeding 100", () => {
    const normalize = (value: number) => {
      const normalized = value > 1 ? value : value * 100
      return Math.min(100, Math.max(0, Number.isFinite(normalized) ? normalized : 0))
    }

    expect(normalize(-0.5)).toBe(0)
    expect(normalize(-10)).toBe(0)
    expect(normalize(150)).toBe(100)
    expect(normalize(NaN)).toBe(0)
  })
})
