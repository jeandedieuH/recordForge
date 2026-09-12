import { describe, expect, it } from "vitest"
import {
  calloutAttachPoint,
  connectorHeadTrim,
  connectorLength,
  connectorPathFor,
  trimConnectorPath,
} from "./connectors"

describe("connectorPathFor", () => {
  it("returns a straight line for the straight style", () => {
    expect(connectorPathFor("straight", { x: 0, y: 0 }, { x: 100, y: 50 })).toEqual({
      start: { x: 0, y: 0 },
      end: { x: 100, y: 50 },
    })
  })

  it("bends along the dominant axis first", () => {
    expect(connectorPathFor("elbow", { x: 0, y: 0 }, { x: 100, y: 50 })).toEqual({
      start: { x: 0, y: 0 },
      corner: { x: 100, y: 0 },
      end: { x: 100, y: 50 },
    })

    expect(connectorPathFor("elbow", { x: 0, y: 0 }, { x: 50, y: 100 })).toEqual({
      start: { x: 0, y: 0 },
      corner: { x: 0, y: 100 },
      end: { x: 50, y: 100 },
    })
  })

  it("honors a preferred first axis for callout leaders", () => {
    const path = connectorPathFor("elbow", { x: 0, y: 0 }, { x: 100, y: 50 }, "vertical")
    expect(path.corner).toEqual({ x: 0, y: 50 })
  })

  it("uses the elbow corner as the curved control point", () => {
    expect(connectorPathFor("curved", { x: 0, y: 0 }, { x: 100, y: 50 })).toEqual({
      start: { x: 0, y: 0 },
      control: { x: 100, y: 0 },
      end: { x: 100, y: 50 },
    })
  })

  it("degenerates routed styles to a line when the connector is axis-aligned", () => {
    for (const style of ["elbow", "curved"] as const) {
      const path = connectorPathFor(style, { x: 10, y: 10 }, { x: 10, y: 90 })
      expect(path.corner).toBeUndefined()
      expect(path.control).toBeUndefined()
    }
  })
})

describe("connectorLength", () => {
  it("measures straight distance for lines", () => {
    expect(
      connectorLength(connectorPathFor("straight", { x: 0, y: 0 }, { x: 3, y: 4 })),
    ).toBe(5)
  })

  it("sums both segments for elbows", () => {
    expect(connectorLength(connectorPathFor("elbow", { x: 0, y: 0 }, { x: 30, y: 40 }))).toBe(
      70,
    )
  })

  it("approximates the arc length for curves (longer than the chord)", () => {
    const curve = connectorPathFor("curved", { x: 0, y: 0 }, { x: 100, y: 100 })
    const length = connectorLength(curve)
    expect(length).toBeGreaterThan(Math.hypot(100, 100))
    // The corner path (via 100,0) is an upper bound for the quadratic arc.
    expect(length).toBeLessThan(200)
  })
})

describe("trimConnectorPath", () => {
  it("shortens a line from both ends", () => {
    const line = connectorPathFor("straight", { x: 0, y: 0 }, { x: 100, y: 0 })
    expect(trimConnectorPath(line, 10, 20)).toEqual({
      start: { x: 10, y: 0 },
      end: { x: 80, y: 0 },
    })
  })

  it("caps each trim at 45% of the total length", () => {
    const line = connectorPathFor("straight", { x: 0, y: 0 }, { x: 100, y: 0 })
    expect(trimConnectorPath(line, 90, 0).start.x).toBe(45)
  })

  it("collapses an elbow to a line when the trim consumes the corner", () => {
    // Horizontal-first elbow: (0,0) → (10,0) → (10,100).
    const elbow = connectorPathFor("elbow", { x: 0, y: 0 }, { x: 10, y: 100 }, "horizontal")
    // Start trim 25 eats the 10px first segment plus 15px of the second.
    const trimmed = trimConnectorPath(elbow, 25, 0)
    expect(trimmed.corner).toBeUndefined()
    expect(trimmed.start.x).toBeCloseTo(10, 3)
    expect(trimmed.start.y).toBeCloseTo(15, 3)
    expect(trimmed.end).toEqual({ x: 10, y: 100 })
  })

  it("keeps a trimmed curve quadratic and moves both endpoints", () => {
    const curve = connectorPathFor("curved", { x: 0, y: 0 }, { x: 100, y: 100 })
    const total = connectorLength(curve)
    const trimmed = trimConnectorPath(curve, total * 0.2, total * 0.2)
    expect(trimmed.control).toBeDefined()
    expect(trimmed.start.x).toBeGreaterThan(0)
    expect(trimmed.end.x).toBeLessThan(100)
    expect(trimmed.end.y).toBeLessThan(100)
  })

  it("leaves the path untouched when both trims are zero", () => {
    const elbow = connectorPathFor("elbow", { x: 0, y: 0 }, { x: 10, y: 20 })
    expect(trimConnectorPath(elbow, 0, 0)).toEqual(elbow)
  })
})

describe("connectorHeadTrim", () => {
  it("matches the head offsets used by the renderers", () => {
    expect(connectorHeadTrim("none", 14)).toBe(0)
    expect(connectorHeadTrim("circle", 14)).toBe(7)
    expect(connectorHeadTrim("arrow", 14)).toBeCloseTo(9.8)
    expect(connectorHeadTrim("diamond", 14)).toBeCloseTo(9.8)
  })
})

describe("calloutAttachPoint", () => {
  it("exits through the nearest border along the center ray", () => {
    // Target below a 100x50 box at origin → bottom edge, vertical exit.
    const below = calloutAttachPoint({ x: 0, y: 0, width: 100, height: 50 }, { x: 75, y: 150 })
    expect(below.point.y).toBe(50)
    expect(below.axis).toBe("vertical")

    // Target straight right → right edge, horizontal exit.
    const right = calloutAttachPoint({ x: 0, y: 0, width: 100, height: 50 }, { x: 300, y: 25 })
    expect(right.point).toEqual({ x: 100, y: 25 })
    expect(right.axis).toBe("horizontal")
  })

  it("anchors at the bottom center when the target is inside the box", () => {
    const attach = calloutAttachPoint({ x: 0, y: 0, width: 100, height: 50 }, { x: 50, y: 25 })
    expect(attach.point).toEqual({ x: 50, y: 50 })
  })
})
