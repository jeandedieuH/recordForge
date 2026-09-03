import { describe, expect, it } from "vitest"
import {
  CURSOR_ASSET_MANIFEST,
  SHAPE_ID_TO_ASSET,
  cursorRangeOverrideLabels,
  findCursorEventAtTime,
  fitCursorPoint,
  mapCursorPointThroughZoom,
  isCursorButtonEnabled,
  isCursorIdle,
  normalizeCursorTelemetry,
  renderCursorAssetSvg,
  resolveCursorAsset,
  timelineToCursorSourceTime,
  zoomSegmentBadges,
  type CursorAssetId,
} from "./index"
import {
  defaultCursorSettings,
  type CursorEffectClip,
  type ManualZoomSegment,
  type TimelineState,
} from "@recordforge/contracts"

const buttons = (left: boolean, right = false, middle = false) => ({
  left,
  right,
  middle,
  x1: false,
  x2: false,
})

const v2Event = (
  tMs: number,
  x: number,
  y: number,
  buttonEvent: string,
  isLeft = false,
  isRight = false,
  isMiddle = false,
) => ({
  tMs,
  rawX: x,
  rawY: y,
  sourceX: x,
  sourceY: y,
  buttons: buttons(isLeft, isRight, isMiddle),
  buttonEvent,
  visible: true,
  shapeId: "arrow",
  shapeChanged: false,
})

const telemetry = normalizeCursorTelemetry({
  recordingId: "recording",
  sourceWidth: 1024,
  sourceHeight: 768,
  events: [
    v2Event(0, 10, 20, "none"),
    v2Event(100, 20, 30, "left-down", true),
    v2Event(200, 20, 30, "left-held", true),
  ],
})

describe("cursor-core", () => {
  it("normalizes v2 telemetry with stable metadata", () => {
    expect(telemetry.assetId).toBe("cursor-events:recording")
    expect(telemetry.schemaVersion).toBe(2)
    expect(telemetry.captureBounds.width).toBe(1024)
  })

  it("looks up the nearest event with a deterministic tie break", () => {
    expect(findCursorEventAtTime(telemetry, 150)?.event.tMs).toBe(100)
    expect(findCursorEventAtTime(telemetry, 190)?.event.tMs).toBe(200)
  })

  it("distinguishes a down edge from a held sample", () => {
    expect(isCursorButtonEnabled(telemetry.events[1], defaultCursorSettings)).toBe(true)
    expect(isCursorButtonEnabled(telemetry.events[2], defaultCursorSettings)).toBe(false)
  })

  it("fits non-16:9 sources without stretching", () => {
    const result = fitCursorPoint({ x: 1024, y: 768 }, telemetry, 1920, 1080)
    expect(result.scale).toBe(1.40625)
    expect(result.x).toBeCloseTo(1680)
    expect(result.y).toBeCloseTo(1080)
  })

  it("clamps partially out-of-bounds coordinates to the source edge", () => {
    const result = fitCursorPoint({ x: -20, y: 900 }, telemetry, 1024, 768)
    expect(result.wasClamped).toBe(true)
    expect(result.sourceX).toBe(0)
    expect(result.sourceY).toBe(768)
  })

  it("maps a fitted cursor through the same crop transform as the zoomed video", () => {
    const viewport = { width: 900, height: 506.25 }
    const canvas = { width: 1920, height: 1080 }
    const transform = {
      scale: 2,
      crop: { x: 480, y: 270, width: 960, height: 540 },
    }

    const mapped = mapCursorPointThroughZoom({ x: 225, y: 126.5625 }, viewport, canvas, transform)

    expect(mapped.x).toBeCloseTo(0)
    expect(mapped.y).toBeCloseTo(0)
    expect(mapped.scale).toBeCloseTo(2)
  })

  it("keeps the cursor centered when a padded viewport is zoomed around the canvas center", () => {
    const viewport = { width: 900, height: 506.25 }
    const canvas = { width: 1920, height: 1080 }
    const transform = {
      scale: 2,
      crop: { x: 480, y: 270, width: 960, height: 540 },
    }

    const mapped = mapCursorPointThroughZoom(
      { x: viewport.width / 2, y: viewport.height / 2 },
      viewport,
      canvas,
      transform,
    )

    expect(mapped.x).toBeCloseTo(viewport.width / 2)
    expect(mapped.y).toBeCloseTo(viewport.height / 2)
  })

  it("labels cursor range overrides against the project profile", () => {
    const base = defaultCursorSettings
    const range = {
      id: "range",
      kind: "cursor-effect" as const,
      assetId: "cursor",
      startMs: 0,
      durationMs: 1000,
      sourceInMs: 0,
      sourceOutMs: 0,
      speed: 1,
      enabled: false,
      locked: true,
      presetId: "recorded-system",
      scale: 1.5,
      smoothing: "off" as const,
      settings: { clickFeedback: "spotlight" as const },
    } satisfies CursorEffectClip
    const labels = cursorRangeOverrideLabels(range, base)
    const keys = labels.map((label) => label.key)
    expect(keys).toContain("locked")
    expect(keys).toContain("hidden")
    expect(keys).toContain("scale")
    expect(keys).toContain("smoothing")
    expect(keys).toContain("click")
  })

  it("returns empty cursor range labels when the range inherits the project profile", () => {
    const range = {
      id: "range",
      kind: "cursor-effect" as const,
      assetId: "cursor",
      startMs: 0,
      durationMs: 1000,
      sourceInMs: 0,
      sourceOutMs: 0,
      speed: 1,
      enabled: true,
      locked: false,
      presetId: defaultCursorSettings.preset,
      scale: defaultCursorSettings.scale,
      smoothing: defaultCursorSettings.smoothMovement ? "smooth" : ("off" as const),
      settings: {},
    } satisfies CursorEffectClip
    expect(cursorRangeOverrideLabels(range, defaultCursorSettings)).toHaveLength(0)
  })

  it("maps a known recorded shape id to the generic shape asset", () => {
    const asset = resolveCursorAsset("hand", "recorded-system", { shapeMode: "optimized" })
    expect(asset.id).toBe("shape-hand")
    expect(asset.effectiveId).toBe("shape-hand")
  })

  it("stores cursor hotspots at the rendered SVG geometry point", () => {
    const arrow = resolveCursorAsset("arrow", "recorded-system", { shapeMode: "optimized" })
    const hand = resolveCursorAsset("hand", "recorded-system", { shapeMode: "optimized" })

    expect(arrow.hotspotX).toBeCloseTo(3.5)
    expect(arrow.hotspotY).toBeCloseTo(3.5)
    expect(hand.hotspotX).toBeCloseTo(9)
    expect(hand.hotspotY).toBeCloseTo(2.5)
  })

  it("falls back to the recorded system arrow for unknown shape ids", () => {
    const asset = resolveCursorAsset("unknown-shape", "recorded-system", { shapeMode: "optimized" })
    expect(asset.id).toBe("recorded-system")
    expect(asset.effectiveId).toBe("recorded-system")
  })

  it("honors literal manifest ids in recorded shape mode", () => {
    const asset = resolveCursorAsset("shape-arrow", "recorded-system", { shapeMode: "recorded" })
    expect(asset.id).toBe("shape-arrow")
    expect(asset.effectiveId).toBe("shape-arrow")

    const fallback = resolveCursorAsset("hand", "recorded-system", { shapeMode: "recorded" })
    expect(fallback.id).toBe("shape-hand")
  })

  it("uses the recorded system preset asset when shape mode is preset", () => {
    const asset = resolveCursorAsset("hand", "recorded-system", { shapeMode: "preset" })
    expect(asset.id).toBe("recorded-system")
    expect(asset.effectiveId).toBe("recorded-system")
  })

  it("resolves the recorded system style to a shape-specific asset", () => {
    const asset = resolveCursorAsset("hand-32", "recorded-system", {
      shapes: [
        {
          shapeId: "hand-32",
          hotspotX: 0,
          hotspotY: 0,
          width: 32,
          height: 32,
          kind: "hand",
        },
      ],
    })
    expect(asset.id).toBe("shape-hand:hand-32")
    expect(asset.effectiveId).toBe("hand-32")
    expect(asset.width).toBe(64)
    expect(asset.height).toBe(64)
  })

  it("produces zoom segment source and lock badges", () => {
    const segment = {
      id: "zoom",
      startMs: 0,
      durationMs: 1000,
      target: { x: 0, y: 0, width: 100, height: 100 },
      scale: 1,
      easing: "ease-in-out" as const,
      transitionInMs: 400,
      transitionOutMs: 400,
      enabled: true,
      locked: true,
      mode: "auto" as const,
      source: "click" as const,
      preset: "product-demo" as const,
    } satisfies ManualZoomSegment
    const labels = zoomSegmentBadges(segment)
    const keys = labels.map((label) => label.key)
    expect(keys).toContain("locked")
    expect(keys).toContain("source")
    expect(keys).toContain("preset")
  })

  it("supports idle hiding and source mapping through a sped-up clip", () => {
    expect(isCursorIdle(telemetry, 2, 800, 500)).toBe(true)
    const state = {
      version: 1,
      id: "project",
      name: "Project",
      recordingId: "recording",
      canvas: {
        width: 1024,
        height: 768,
        fps: 30,
        background: "#000000",
        padding: 0,
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
              id: "clip",
              kind: "screen",
              assetId: "recording",
              startMs: 1000,
              durationMs: 500,
              sourceInMs: 200,
              sourceOutMs: 450,
              speed: 0.5,
            },
          ],
        },
      ],
      markers: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    } satisfies TimelineState
    expect(timelineToCursorSourceTime(state, 1250)).toBe(325)
  })

  it("manifest contains valid modern vector geometries for all cursor types", () => {
    const ids = Object.keys(CURSOR_ASSET_MANIFEST) as CursorAssetId[]
    expect(ids.length).toBeGreaterThanOrEqual(22)

    for (const id of ids) {
      const asset = CURSOR_ASSET_MANIFEST[id]
      expect(asset.id).toBe(id)
      expect(asset.label.length).toBeGreaterThan(0)
      expect(asset.viewBox).toBe("0 0 24 24")
      expect(asset.width).toBeGreaterThan(0)
      expect(asset.height).toBeGreaterThan(0)
      expect(asset.hotspotX).toBeGreaterThanOrEqual(0)
      expect(asset.hotspotX).toBeLessThanOrEqual(24)
      expect(asset.hotspotY).toBeGreaterThanOrEqual(0)
      expect(asset.hotspotY).toBeLessThanOrEqual(24)

      // Test token substitution produces complete SVG markup
      const rendered = renderCursorAssetSvg(asset, {
        fill: "#ff0000",
        fillOpacity: 0.9,
        stroke: "#000000",
        strokeWidth: 2,
        strokeOpacity: 0.8,
      })
      expect(rendered).not.toContain("{fill}")
      expect(rendered).not.toContain("{stroke}")
      expect(rendered).toContain("#ff0000")
      expect(rendered).toContain("#000000")
      // Ensure no raw text nodes that break headless usvg rasterizers
      expect(rendered).not.toContain("<text")
    }
  })

  it("maps modern cursor kind aliases to canonical shape assets", () => {
    const mappings: [string, CursorAssetId][] = [
      ["arrow", "shape-arrow"],
      ["default", "shape-arrow"],
      ["pointer", "shape-hand"],
      ["hand", "shape-hand"],
      ["text", "shape-ibeam"],
      ["ibeam", "shape-ibeam"],
      ["crosshair", "shape-crosshair"],
      ["cross", "shape-crosshair"],
      ["wait", "shape-wait"],
      ["help", "shape-help"],
      ["move", "shape-move"],
      ["all-scroll", "shape-move"],
      ["resize-diagonal-1", "shape-resize-diagonal-1"],
      ["nwse-resize", "shape-resize-diagonal-1"],
      ["resize-diagonal-2", "shape-resize-diagonal-2"],
      ["nesw-resize", "shape-resize-diagonal-2"],
      ["resize-horizontal", "shape-resize-horizontal"],
      ["ew-resize", "shape-resize-horizontal"],
      ["col-resize", "shape-col-resize"],
      ["resize-vertical", "shape-resize-vertical"],
      ["ns-resize", "shape-resize-vertical"],
      ["row-resize", "shape-row-resize"],
      ["unavailable", "shape-unavailable"],
      ["not-allowed", "shape-unavailable"],
      ["no-drop", "shape-unavailable"],
      ["grab", "shape-grab"],
      ["grabbing", "shape-grabbing"],
      ["zoom-in", "shape-zoom-in"],
      ["zoom-out", "shape-zoom-out"],
      ["copy", "shape-copy"],
      ["progress", "shape-progress"],
      ["cell", "shape-cell"],
    ]

    for (const [kind, expectedAssetId] of mappings) {
      expect(SHAPE_ID_TO_ASSET[kind]).toBe(expectedAssetId)
      const resolved = resolveCursorAsset(kind, "recorded-system", { shapeMode: "optimized" })
      expect(resolved.id).toBe(expectedAssetId)
    }
  })
})
