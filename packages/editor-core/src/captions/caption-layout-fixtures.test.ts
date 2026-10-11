import { describe, expect, it } from "vitest"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { CanvasAspectRatio } from "@recordforge/contracts"
import { DEFAULT_CAPTION_DESIGN, type CaptionDesign } from "@recordforge/contracts"
import { canvasSizeForAspectRatio } from "../composition"
import { CAPTION_LOOK_LIST } from "./caption-looks"
import { resolveCaptionLayout } from "./caption-layout"

// Shared TS ↔ Rust contract fixture. The committed JSON is consumed by the
// Rust serde/layout tests in src-tauri, so ANY engine change that alters the
// output must regenerate it: run this file with UPDATE_CAPTION_FIXTURES=1.

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../apps/desktop/src-tauri/src/testdata/caption-layouts.json",
)

const RATIOS: CanvasAspectRatio[] = ["16:9", "5:4", "1:1", "4:5", "9:16"]

const CUES: {
  id: string
  text: string
  startMs: number
  endMs: number
  words?: { text: string; startMs: number; endMs: number }[]
}[] = [
  { id: "short", text: "Welcome back to the studio", startMs: 1_000, endMs: 4_000 },
  {
    id: "two-line",
    text: "First we drag the playhead across the entire timeline to check sync",
    startMs: 1_000,
    endMs: 4_000,
    // Cue-relative word timings — exercised by the pop-16:9 case so the JSON
    // covers the real-window path, not only proportional weighting.
    words: [
      { text: "First", startMs: 0, endMs: 320 },
      { text: "we", startMs: 340, endMs: 480 },
      { text: "drag", startMs: 520, endMs: 760 },
      { text: "the", startMs: 780, endMs: 900 },
      { text: "playhead", startMs: 940, endMs: 1_300 },
      { text: "across", startMs: 1_330, endMs: 1_600 },
      { text: "the", startMs: 1_620, endMs: 1_740 },
      { text: "entire", startMs: 1_780, endMs: 2_060 },
      { text: "timeline", startMs: 2_090, endMs: 2_400 },
      { text: "to", startMs: 2_420, endMs: 2_520 },
      { text: "check", startMs: 2_560, endMs: 2_780 },
      { text: "sync", startMs: 2_800, endMs: 3_000 },
    ],
  },
  {
    id: "long",
    text: "When the demo reaches the chapter marker we pause, zoom into the toolbar, and let the highlight carry the narration through the whole section",
    startMs: 1_000,
    endMs: 4_000,
  },
]

function buildFixture() {
  return {
    version: 1,
    cases: CAPTION_LOOK_LIST.flatMap((look) =>
      RATIOS.map((ratio) => {
        const size = canvasSizeForAspectRatio(ratio, undefined, "1080p")
        const canvas = { ...size, aspectRatio: ratio }
        const design: CaptionDesign = {
          ...DEFAULT_CAPTION_DESIGN,
          preset: look.id,
          // One look pins an accent so the resolved non-default color is
          // covered by the contract.
          ...(look.id === "pop" ? { accentColor: "#22D3EE" } : {}),
        }
        return {
          id: `${look.id}-${ratio}`,
          canvas,
          design,
          cues: CUES.map((cue) => {
            // Only the pop-16:9 case carries stored word timings so the
            // contract covers the real-window path without bloating every
            // fixture.
            const words =
              cue.id === "two-line" && look.id === "pop" && ratio === "16:9" ? cue.words : undefined
            return {
              input: {
                id: cue.id,
                text: cue.text,
                startMs: cue.startMs,
                endMs: cue.endMs,
                ...(words ? { words } : {}),
              },
              layout: resolveCaptionLayout({
                text: cue.text,
                startMs: cue.startMs,
                endMs: cue.endMs,
                words,
                design,
                canvas,
              }),
            }
          }),
        }
      }),
    ),
  }
}

describe("caption layout fixtures (TS ↔ Rust contract)", () => {
  it("matches the committed caption-layouts.json", () => {
    const generated = `${JSON.stringify(buildFixture(), null, 2)}\n`
    if (process.env.UPDATE_CAPTION_FIXTURES === "1") {
      writeFileSync(FIXTURE_PATH, generated)
    }
    expect(
      existsSync(FIXTURE_PATH),
      "fixture file missing — run with UPDATE_CAPTION_FIXTURES=1",
    ).toBe(true)
    expect(readFileSync(FIXTURE_PATH, "utf8")).toBe(generated)
  })
})
