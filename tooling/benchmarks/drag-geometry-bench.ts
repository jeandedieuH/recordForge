/**
 * Compares the two overlay-preview update paths for an interactive drag:
 *
 *   1. rebuild the retained WASM scene from a full plan every frame
 *      (pre-follow-up behavior), and
 *   2. patch item geometry in place with `update_geometry` (current path).
 *
 *   bun run tooling/benchmarks/drag-geometry-bench.ts [items] [iterations]
 *
 * The fixture is synthetic and deterministic; run it on the target low-end
 * machine to see the absolute numbers. The ratio is the useful signal.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join, resolve } from "node:path"
import { initSync, WasmOverlayEngine } from "../../packages/overlay-core/wasm/overlay_engine.js"

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)))
const wasmPath = join(scriptDir, "../../packages/overlay-core/wasm/overlay_engine_bg.wasm")
initSync({ module: readFileSync(wasmPath) })

const itemCount = Math.max(1, Number(process.argv[2] ?? 40))
const iterations = Math.max(1, Number(process.argv[3] ?? 300))

function transform(x: number, zIndex: number) {
  return {
    x,
    y: 100 + (zIndex % 10) * 60,
    width: 220,
    height: 90,
    rotation: 0,
    anchorX: 0.5,
    anchorY: 0.5,
    zIndex,
    opacity: 1,
  }
}

function makePlan() {
  return {
    version: 1,
    canvas: { width: 1920, height: 1080 },
    items: Array.from({ length: itemCount }, (_, index) => ({
      kind: "annotation",
      id: `ann-${index}`,
      startMs: 0,
      endMs: 60_000,
      transform: transform(60 + index * 8, index),
      animation: { inType: "none", outType: "none", inDurationMs: 0, outDurationMs: 0 },
      annotationType: index % 2 === 0 ? "rounded-rect" : "arrow",
      endX: 300 + index * 8,
      endY: 240,
      strokeColor: "#38bdf8",
      strokeWidth: 4,
      strokeStyle: "solid",
      fillColor: "#38bdf8",
      fillOpacity: 0.12,
      cornerRadius: 8,
      arrowStartHead: "none",
      arrowEndHead: "arrow",
      arrowStyle: "straight",
      shadowEnabled: true,
      shadowColor: "#000000",
      shadowBlur: 10,
      textColor: "#ffffff",
      fontSize: 14,
    })),
    assets: [],
    fonts: [],
  }
}

const plan = makePlan()
const initialTransforms = plan.items.map((item) => item.transform)

function patchJson(frame: number): string {
  return JSON.stringify(
    plan.items.map((item, index) => ({
      id: item.id,
      transform: {
        ...initialTransforms[index]!,
        x: initialTransforms[index]!.x + ((frame + index) % 17),
      },
      ...(item.kind === "annotation"
        ? { endX: (item as { endX: number }).endX + ((frame + index) % 17) }
        : {}),
    })),
  )
}

function time(label: string, run: () => void): number {
  // Warm-up: JIT, WASM pages and the allocator.
  for (let i = 0; i < 10; i++) run()
  const started = performance.now()
  for (let i = 0; i < iterations; i++) run()
  const elapsed = performance.now() - started
  console.log(
    `${label.padEnd(28)} ${(elapsed / iterations).toFixed(3)} ms/frame  (${elapsed.toFixed(1)} ms total)`,
  )
  return elapsed / iterations
}

const rebuildMs = time("full scene rebuild", () => {
  // The preview rebuilds the plan object and re-serializes it every frame, so
  // keep stringify inside the measured path for a like-for-like comparison.
  const engine = new WasmOverlayEngine(JSON.stringify(plan))
  engine.evaluate(16)
  engine.free()
})

const patched = new WasmOverlayEngine(JSON.stringify(plan))
patched.evaluate(16)
const patchMs = time("in-place geometry patch", () => {
  patched.update_geometry(patchJson(Math.floor(Math.random() * 17)))
  patched.evaluate(16)
})
patched.free()

console.log(
  `\n${itemCount} items: geometry patch is ${(rebuildMs / patchMs).toFixed(1)}x faster ` +
    `(${rebuildMs.toFixed(3)} ms → ${patchMs.toFixed(3)} ms per drag frame).`,
)
