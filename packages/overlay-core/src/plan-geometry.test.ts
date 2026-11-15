import { overlayRenderPlanSchema, type OverlayRenderPlan } from "@recordforge/contracts"
import { describe, expect, it } from "vitest"
import { diffOverlayPlanGeometry } from "./plan-geometry"

function plan(overrides: {
  x?: number
  endX?: number
  text?: string
  zIndex?: number
}): OverlayRenderPlan {
  return overlayRenderPlanSchema.parse({
    canvas: { width: 1920, height: 1080 },
    items: [
      {
        kind: "annotation",
        id: "arrow",
        startMs: 0,
        endMs: 5_000,
        transform: {
          x: overrides.x ?? 100,
          y: 100,
          width: 200,
          height: 100,
          zIndex: overrides.zIndex ?? 1,
        },
        animation: { inType: "none", outType: "none" },
        annotationType: "arrow",
        endX: overrides.endX ?? 300,
        endY: 200,
        strokeColor: "#ffffff",
        strokeWidth: 4,
        strokeStyle: "solid",
        fillColor: "#ffffff",
        fillOpacity: 0,
        cornerRadius: 0,
        arrowEndHead: "arrow",
        arrowStartHead: "none",
        shadowEnabled: false,
        shadowColor: "#000000",
        shadowBlur: 0,
        textColor: "#ffffff",
        fontSize: 16,
      },
      {
        kind: "text",
        id: "title",
        startMs: 0,
        endMs: 5_000,
        transform: { x: 0, y: 0, width: 500, height: 160, zIndex: 2 },
        animation: { inType: "none", outType: "none" },
        presetId: "text-clean",
        category: "title",
        primaryText: overrides.text ?? "Hello",
        alignment: "left",
        fontFamily: "sans",
        fontSize: 32,
        fontWeight: "700",
        textColor: "#ffffff",
        secondaryTextColor: "#94a3b8",
        accentColor: "#38bdf8",
        backdropStyle: "none",
        backdropColor: "#0f172a",
        backdropOpacity: 1,
        backdropBlur: 0,
        backdropBorderRadius: 0,
        backdropPaddingX: 24,
        backdropPaddingY: 18,
        shadowEnabled: false,
        shadowColor: "#000000",
        shadowBlur: 0,
      },
    ],
    assets: [],
    fonts: [],
  })
}

describe("diffOverlayPlanGeometry", () => {
  it("returns no patches for an identical plan", () => {
    expect(diffOverlayPlanGeometry(plan({}), plan({}))).toEqual([])
  })

  it("patches a moved item without rebuilding", () => {
    const patches = diffOverlayPlanGeometry(plan({}), plan({ x: 140 }))
    expect(patches).toHaveLength(1)
    expect(patches?.[0]).toMatchObject({ id: "arrow", transform: { x: 140 } })
  })

  it("patches a connector endpoint change", () => {
    const patches = diffOverlayPlanGeometry(plan({}), plan({ endX: 420 }))
    expect(patches).toHaveLength(1)
    expect(patches?.[0]).toMatchObject({ id: "arrow", endX: 420 })
  })

  it("rebuilds when a connector endpoint is added or cleared", () => {
    const withTarget = plan({})
    const withoutTarget = plan({})
    const item = withoutTarget.items[0]!
    if (item.kind === "annotation") {
      delete item.endX
      delete item.endY
    }
    expect(diffOverlayPlanGeometry(withTarget, withoutTarget)).toBeNull()
    expect(diffOverlayPlanGeometry(withoutTarget, withTarget)).toBeNull()
  })

  it("rejects text edits, z-order changes and canvas changes", () => {
    expect(diffOverlayPlanGeometry(plan({}), plan({ text: "Changed" }))).toBeNull()
    expect(diffOverlayPlanGeometry(plan({}), plan({ zIndex: 9 }))).toBeNull()
    const resizedCanvas = plan({})
    resizedCanvas.canvas = { width: 3840, height: 2160 }
    expect(diffOverlayPlanGeometry(plan({}), resizedCanvas)).toBeNull()
  })
})
