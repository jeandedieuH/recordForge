import { describe, expect, it } from "vitest"
import { defaultCursorSettings, type TimelineState } from "@recordforge/domain"
import {
  createEngine,
  createRegenerateZoomSuggestionsCommand,
  createUpdateZoomSegmentCommand,
  executeCommand,
} from "./index"

function makeState(): TimelineState {
  const now = "2026-08-10T00:00:00.000Z"
  return {
    version: 1,
    id: "phase9-project",
    name: "Phase 9",
    recordingId: "recording",
    canvas: {
      width: 1920,
      height: 1080,
      fps: 30,
      background: "#000000",
      padding: 48,
      borderRadius: 0,
      shadow: false,
      cursorSettings: defaultCursorSettings,
    },
    tracks: [
      {
        id: "screen",
        kind: "screen",
        name: "Screen",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "screen-clip",
            kind: "screen",
            assetId: "recording",
            startMs: 0,
            durationMs: 10_000,
            sourceInMs: 0,
            sourceOutMs: 10_000,
            speed: 1,
          },
        ],
      },
    ],
    markers: [],
    zoomSegments: [
      {
        id: "manual",
        startMs: 0,
        durationMs: 500,
        target: { x: 48, y: 48, width: 960, height: 540 },
        scale: 1,
        easing: "ease-in-out",
        enabled: true,
        locked: false,
        mode: "manual",
        source: "manual",
        preset: "manual-only",
      },
      {
        id: "locked-auto",
        startMs: 2_000,
        durationMs: 500,
        target: { x: 100, y: 100, width: 960, height: 540 },
        scale: 1,
        easing: "ease-in-out",
        enabled: true,
        locked: true,
        mode: "auto",
        source: "click",
        preset: "product-demo",
      },
      {
        id: "old-auto",
        startMs: 4_000,
        durationMs: 500,
        target: { x: 100, y: 100, width: 960, height: 540 },
        scale: 1,
        easing: "ease-in-out",
        enabled: true,
        locked: false,
        mode: "auto",
        source: "dwell",
        preset: "product-demo",
      },
    ],
    createdAt: now,
    updatedAt: now,
  }
}

describe("Phase 9 smart zoom regeneration", () => {
  it("replaces unlocked auto suggestions without overwriting manual or locked segments", () => {
    const result = executeCommand(
      createEngine(makeState()),
      createRegenerateZoomSuggestionsCommand([
        {
          id: "new-auto",
          startMs: 6_000,
          durationMs: 800,
          target: { x: 400, y: 200, width: 960, height: 540 },
          scale: 1,
          easing: "smooth",
          enabled: true,
          locked: false,
          mode: "auto",
          source: "click",
          preset: "product-demo",
        },
      ]),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.history.present.zoomSegments).toEqual([
      expect.objectContaining({ id: "manual", mode: "manual" }),
      expect.objectContaining({ id: "locked-auto", locked: true }),
      expect.objectContaining({ id: "new-auto", source: "click" }),
    ])
  })

  it("promotes an edited auto suggestion to a manual segment", () => {
    const edited = executeCommand(
      createEngine(makeState()),
      createUpdateZoomSegmentCommand("old-auto", { target: { x: 600 } }),
    )

    expect(edited.ok).toBe(true)
    if (!edited.ok) return
    expect(
      edited.value.history.present.zoomSegments?.find((segment) => segment.id === "old-auto"),
    ).toMatchObject({ mode: "manual", source: "manual", preset: "manual-only" })

    const regenerated = executeCommand(
      edited.value,
      createRegenerateZoomSuggestionsCommand([
        {
          id: "new-auto",
          startMs: 6_000,
          durationMs: 800,
          target: { x: 400, y: 200, width: 960, height: 540 },
          scale: 1,
          easing: "smooth",
          enabled: true,
          locked: false,
          mode: "auto",
          source: "click",
          preset: "product-demo",
        },
      ]),
    )

    expect(regenerated.ok).toBe(true)
    if (regenerated.ok) {
      expect(regenerated.value.history.present.zoomSegments).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "old-auto", mode: "manual" })]),
      )
    }
  })
})
