import { describe, expect, it, beforeAll } from "vitest"
import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { initSync, WasmCursorEngine } from "../wasm/cursor_engine.js"
import { createCursorEngine, fitCursorPoint, normalizeCursorTelemetry } from "./index"
import {
  defaultCursorSettings,
  type CursorSettings,
  type CursorTelemetryFile,
} from "@recordforge/contracts"

const __dirname = dirname(fileURLToPath(import.meta.url))

beforeAll(() => {
  const wasmPath = resolve(__dirname, "../wasm/cursor_engine_bg.wasm")
  initSync({ module: readFileSync(wasmPath) })
})

function loadFixture(name: string): CursorTelemetryFile {
  const path = resolve(__dirname, "../../../tooling/fixtures/cursor-fixtures", name)
  return normalizeCursorTelemetry(JSON.parse(readFileSync(path, "utf-8")))
}

interface WasmEngine {
  evaluate: (
    timeMs: number,
    settings: CursorSettings,
  ) => ReturnType<ReturnType<typeof createCursorEngine>["evaluate"]>
  fit: (
    sourceX: number,
    sourceY: number,
    targetWidth: number,
    targetHeight: number,
    padding: number,
  ) => { x: number; y: number }
}

function createWasmEngine(telemetry: CursorTelemetryFile): WasmEngine {
  const raw = new WasmCursorEngine(JSON.stringify(telemetry), JSON.stringify({}))
  return {
    evaluate: (timeMs, settings) => JSON.parse(raw.evaluate(timeMs, JSON.stringify(settings))),
    fit: (sourceX, sourceY, targetWidth, targetHeight, padding) =>
      JSON.parse(raw.fit(sourceX, sourceY, targetWidth, targetHeight, padding)),
  }
}

function framesAreEqual(
  wasm: ReturnType<WasmEngine["evaluate"]>,
  ts: ReturnType<ReturnType<typeof createCursorEngine>["evaluate"]>,
) {
  expect(wasm.sourceX).toBeCloseTo(ts.sourceX, 1)
  expect(wasm.sourceY).toBeCloseTo(ts.sourceY, 1)
  expect(wasm.visible).toBe(ts.visible)
  expect(wasm.opacity).toBeCloseTo(ts.opacity, 2)
  expect(wasm.activeClicks.length).toBe(ts.activeClicks.length)
  for (let i = 0; i < wasm.activeClicks.length; i++) {
    expect(wasm.activeClicks[i].sourceX).toBeCloseTo(ts.activeClicks[i].sourceX, 1)
    expect(wasm.activeClicks[i].sourceY).toBeCloseTo(ts.activeClicks[i].sourceY, 1)
    expect(wasm.activeClicks[i].progress).toBeCloseTo(ts.activeClicks[i].progress, 2)
    expect(wasm.activeClicks[i].intensity).toBeCloseTo(ts.activeClicks[i].intensity, 2)
  }
}

describe("cursor engine cross-language parity", () => {
  it("wasm and typescript produce identical source positions for the 100dpi fixture", () => {
    const telemetry = loadFixture("cursor-v1-100dpi-10s.json")
    const tsEngine = createCursorEngine(telemetry)
    const wasmEngine = createWasmEngine(telemetry)

    const times = [0, 33, 123, 1000, 2501, 5000, 9999]
    for (const timeMs of times) {
      framesAreEqual(
        wasmEngine.evaluate(timeMs, defaultCursorSettings),
        tsEngine.evaluate(timeMs, defaultCursorSettings),
      )
    }
  })

  it("wasm and typescript produce identical source positions for the left-clicks fixture", () => {
    const telemetry = loadFixture("cursor-v1-left-clicks-10s.json")
    const tsEngine = createCursorEngine(telemetry)
    const wasmEngine = createWasmEngine(telemetry)

    const times = [0, 50, 250, 800, 1500, 5000]
    for (const timeMs of times) {
      framesAreEqual(
        wasmEngine.evaluate(timeMs, defaultCursorSettings),
        tsEngine.evaluate(timeMs, defaultCursorSettings),
      )
    }
  })

  it("wasm and typescript produce identical source positions for the recovery-gap fixture", () => {
    const telemetry = loadFixture("cursor-v1-recovery-gap-10s.json")
    const tsEngine = createCursorEngine(telemetry)
    const wasmEngine = createWasmEngine(telemetry)

    const times = [0, 100, 500, 1500, 3000, 9999]
    for (const timeMs of times) {
      framesAreEqual(
        wasmEngine.evaluate(timeMs, defaultCursorSettings),
        tsEngine.evaluate(timeMs, defaultCursorSettings),
      )
    }
  })

  it("fit transforms are identical between wasm and typescript", () => {
    const telemetry = loadFixture("cursor-v1-100dpi-10s.json")
    const wasmEngine = createWasmEngine(telemetry)

    const points = [
      { x: 0, y: 0 },
      { x: 960, y: 540 },
      { x: 1920, y: 1080 },
    ]
    for (const point of points) {
      const wasm = wasmEngine.fit(point.x, point.y, 1920, 1080, 0)
      const ts = fitCursorPoint(point, telemetry, 1920, 1080, { clampToSource: true })
      expect(wasm.x).toBeCloseTo(ts.x, 1)
      expect(wasm.y).toBeCloseTo(ts.y, 1)
    }
  })
})
