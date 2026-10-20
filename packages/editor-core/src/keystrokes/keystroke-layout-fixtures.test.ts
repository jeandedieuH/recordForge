import { describe, expect, it } from "vitest"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { KeystrokeEvent, KeystrokePlatform } from "@recordforge/contracts"
import { defaultKeystrokeOverlaySettings } from "@recordforge/contracts"
import { resolveKeystrokeDisplay } from "./keystroke-layout"

// Shared TS ↔ Rust contract fixture. The committed JSON is consumed by the
// Rust renderer tests in src-tauri, so ANY display-model change that alters
// output must regenerate it: run this file with UPDATE_KEYSTROKE_FIXTURES=1.

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../apps/desktop/src-tauri/src/testdata/keystroke-layouts.json",
)

const EVENTS: KeystrokeEvent[] = [
  { tMs: 1_000, key: "S", modifiers: ["ctrl", "shift"] },
  { tMs: 1_600, key: "Enter", modifiers: ["meta"] },
  { tMs: 2_200, key: "Z", modifiers: ["meta"] },
  { tMs: 2_500, key: "Z", modifiers: ["meta"] },
  { tMs: 3_400, key: "P", modifiers: ["ctrl"] },
  { tMs: 3_700, key: "Q", modifiers: ["alt", "shift"] },
  { tMs: 4_000, key: "R", modifiers: ["meta", "shift"] },
]

const CASES: { id: string; platform: KeystrokePlatform; settings: object }[] = [
  {
    id: "windows-dark-symbols",
    platform: "windows",
    settings: { ...defaultKeystrokeOverlaySettings, enabled: true },
  },
  {
    id: "macos-light-symbols",
    platform: "macos",
    settings: {
      ...defaultKeystrokeOverlaySettings,
      enabled: true,
      theme: "light",
      position: "bottom-left",
    },
  },
  {
    id: "linux-contrast-text",
    platform: "linux",
    settings: {
      ...defaultKeystrokeOverlaySettings,
      enabled: true,
      theme: "contrast",
      modifierStyle: "text",
      position: "top-right",
      scale: 1.5,
      maxStack: 2,
      holdMs: 1500,
    },
  },
]

// Sample inside entrance, at steady state, mid stack, during the evict fade,
// mid natural exit, and after everything is gone.
const SAMPLES = [1_020, 1_300, 2_550, 3_750, 4_150, 8_000]

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function buildFixture() {
  return {
    version: 1,
    cases: CASES.map((testCase) => ({
      id: testCase.id,
      platform: testCase.platform,
      settings: testCase.settings,
      canvas: { width: 1920, height: 1080 },
      events: EVENTS,
      samples: SAMPLES.map((sourceMs) => {
        const display = resolveKeystrokeDisplay({
          events: EVENTS,
          settings: testCase.settings as typeof defaultKeystrokeOverlaySettings,
          platform: testCase.platform,
          sourceMs,
          canvas: { width: 1920, height: 1080 },
        })
        return {
          sourceMs,
          rows: display.rows.map((row) => ({
            key: row.key,
            x: round(row.x),
            y: round(row.y),
            widthPx: round(row.widthPx),
            heightPx: round(row.heightPx),
            alpha: round(row.alpha),
            scale: round(row.scale),
            svg: row.svg,
          })),
        }
      }),
    })),
  }
}

describe("keystroke layout fixtures (TS ↔ Rust contract)", () => {
  it("matches the committed keystroke-layouts.json", () => {
    const generated = `${JSON.stringify(buildFixture(), null, 2)}\n`
    if (process.env.UPDATE_KEYSTROKE_FIXTURES === "1") {
      writeFileSync(FIXTURE_PATH, generated)
    }
    expect(
      existsSync(FIXTURE_PATH),
      "fixture file missing — run with UPDATE_KEYSTROKE_FIXTURES=1",
    ).toBe(true)
    expect(readFileSync(FIXTURE_PATH, "utf8")).toBe(generated)
  })
})
