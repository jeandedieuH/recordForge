import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { overlayDisplayListSchema, overlayRenderPlanSchema } from "@recordforge/contracts"
import { beforeAll, describe, expect, it } from "vitest"
import { initSync, WasmOverlayEngine } from "../wasm/overlay_engine.js"
import { createOverlayWasmEngine } from "./wasm-engine"

const emptyPlan = overlayRenderPlanSchema.parse({
  canvas: { width: 1920, height: 1080 },
})
const wasmPath = fileURLToPath(new URL("../wasm/overlay_engine_bg.wasm", import.meta.url))
const phase2Plan = overlayRenderPlanSchema.parse({
  canvas: { width: 1920, height: 1080 },
  items: [
    {
      kind: "annotation",
      id: "first",
      startMs: 0,
      endMs: 1_000,
      transform: { x: 100, y: 100, width: 200, height: 100, zIndex: 4 },
      animation: {
        inType: "slide-up",
        outType: "none",
        inDurationMs: 100,
        outDurationMs: 0,
        easing: "linear",
      },
      annotationType: "rectangle",
      strokeColor: "#ffffff",
      strokeWidth: 2,
      strokeStyle: "solid",
      fillColor: "#ffffff",
      fillOpacity: 0.2,
      cornerRadius: 4,
      arrowEndHead: "none",
      arrowStartHead: "none",
      shadowEnabled: false,
      shadowColor: "#000000",
      shadowBlur: 0,
      textColor: "#ffffff",
      fontSize: 16,
    },
    {
      kind: "annotation",
      id: "second",
      startMs: 0,
      endMs: 1_000,
      transform: { x: 0, y: 0, width: 50, height: 50, zIndex: 4 },
      animation: { inType: "none", outType: "none", inDurationMs: 0, outDurationMs: 0 },
      annotationType: "circle",
      strokeColor: "#38bdf8",
      strokeWidth: 1,
      strokeStyle: "solid",
      fillColor: "#38bdf8",
      fillOpacity: 0.1,
      cornerRadius: 0,
      arrowEndHead: "none",
      arrowStartHead: "none",
      shadowEnabled: false,
      shadowColor: "#000000",
      shadowBlur: 0,
      textColor: "#ffffff",
      fontSize: 16,
    },
  ],
})

beforeAll(() => {
  initSync({ module: readFileSync(wasmPath) })
})

describe("overlay WASM adapter", () => {
  it("evaluates the shared plan shape through the generated Rust module", () => {
    const wasm = new WasmOverlayEngine(JSON.stringify(emptyPlan))
    const displayList = overlayDisplayListSchema.parse(JSON.parse(wasm.evaluate(0)))
    wasm.free()

    expect(displayList).toEqual({ timeMs: 0, items: [] })
  })

  it("evaluates animation transforms and preserves stable z-order through WASM", () => {
    const wasm = new WasmOverlayEngine(JSON.stringify(phase2Plan))
    const displayList = overlayDisplayListSchema.parse(JSON.parse(wasm.evaluate(50)))
    wasm.free()

    expect(displayList.items.map((item) => item.id)).toEqual(["first", "second"])
    expect(displayList.items[0]).toMatchObject({
      kind: "annotation",
      animationProgress: 0.5,
      drawProgress: 1,
      transform: {
        x: 100,
        y: 150,
        width: 200,
        height: 100,
        zIndex: 4,
      },
    })
  })

  it("keeps browser-only initialization out of the node test environment", async () => {
    await expect(createOverlayWasmEngine(emptyPlan)).rejects.toThrow(
      "WASM overlay engine is only available in the browser",
    )
  })
})
