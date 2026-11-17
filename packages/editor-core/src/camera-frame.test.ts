import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  cameraClipSchema,
  cameraFrameSchema,
  CAMERA_CORNER_RADIUS_FRACTION,
  type CameraClip,
  type CameraLayoutSegment,
  type CanvasAspectRatio,
  type ClipTransform,
} from "@recordforge/contracts"
import { buildCameraPresetTransform } from "@recordforge/domain"
import { buildCameraFrameFixtureDocument } from "../scripts/camera-frame-fixture-cases"
import {
  autoCameraFrame,
  autoPresetForAspectRatio,
  cameraCoverCrop,
  cameraFrameFromLegacyTransform,
  computeSplit,
  getCameraFrame,
  legacyTransformFromFrame,
  resolveCameraFrame,
  type CameraFrameCanvas,
} from "./camera-frame"

const SOURCE_720P = { width: 1280, height: 720 }

const CANVASES: Array<{ name: string; canvas: CameraFrameCanvas }> = [
  { name: "1920x1080@16:9", canvas: { width: 1920, height: 1080, aspectRatio: "16:9" } },
  { name: "1080x1920@9:16", canvas: { width: 1080, height: 1920, aspectRatio: "9:16" } },
  { name: "1080x1080@1:1", canvas: { width: 1080, height: 1080, aspectRatio: "1:1" } },
  { name: "1350x1080@5:4", canvas: { width: 1350, height: 1080, aspectRatio: "5:4" } },
  { name: "1080x1350@4:5", canvas: { width: 1080, height: 1350, aspectRatio: "4:5" } },
  { name: "3840x2160@16:9", canvas: { width: 3840, height: 2160, aspectRatio: "16:9" } },
]

const PRESETS = ["camera-only", "vertical-pip", "circle-pip", "side-by-side"] as const

function expectRectNear(
  actual: { x: number; y: number; width: number; height: number },
  expected: { x: number; y: number; width: number; height: number },
  tolerance = 1,
) {
  expect(Math.abs(actual.x - expected.x)).toBeLessThanOrEqual(tolerance)
  expect(Math.abs(actual.y - expected.y)).toBeLessThanOrEqual(tolerance)
  expect(Math.abs(actual.width - expected.width)).toBeLessThanOrEqual(tolerance)
  expect(Math.abs(actual.height - expected.height)).toBeLessThanOrEqual(tolerance)
}

function laneSegment(
  id: string,
  startMs: number,
  durationMs: number,
  layout: CameraLayoutSegment["layout"],
  overrides: Partial<CameraLayoutSegment> = {},
): CameraLayoutSegment {
  return {
    id,
    startMs,
    durationMs,
    layout,
    transitionInMs: 0,
    transitionOutMs: 0,
    easing: "linear",
    source: "manual",
    enabled: true,
    locked: false,
    ...overrides,
  }
}

describe("cameraFrameSchema", () => {
  it("parses an empty object into the default overlay frame", () => {
    const frame = cameraFrameSchema.parse({})
    expect(frame.placement.mode).toBe("overlay")
    expect(frame.placement.align).toEqual({ x: 1, y: 1 })
    expect(frame.placement.size).toBeCloseTo(0.311)
    expect(frame.placement.margin).toBeCloseTo(0.022)
    expect(frame.placement.anchorTo).toBe("canvas")
    expect(frame.placement.split).toEqual({
      side: "right",
      ratio: 0.76,
      gap: 0.02,
      fit: "frame",
    })
    expect(frame.placement.origin).toBe("auto")
    expect(frame.shape).toBe("rounded")
    expect(frame.aspect).toBe("5:7")
    expect(frame.cornerRadius).toBe(CAMERA_CORNER_RADIUS_FRACTION)
    expect(frame.style.borderWidth).toBe(2)
    expect(frame.style.borderColor).toBe("#ffffff")
    expect(frame.style.shadowEnabled).toBe(true)
    expect(frame.style.shadowBlur).toBe(16)
    expect(frame.style.shadowOffsetY).toBe(6)
    expect(frame.framing).toEqual({ focusX: 0.5, focusY: 0.5, zoom: 1 })
  })

  it("parses camera clips with and without a frame", () => {
    const base = {
      id: "cam-1",
      assetId: "asset-1",
      kind: "camera" as const,
      startMs: 0,
      durationMs: 1_000,
      sourceInMs: 0,
      sourceOutMs: 1_000,
    }
    const without = cameraClipSchema.parse(base)
    expect(without.frame).toBeUndefined()
    expect(without.transform.shape).toBe("rectangle")

    const withFrame = cameraClipSchema.parse({ ...base, frame: { shape: "circle" } })
    expect(withFrame.frame?.shape).toBe("circle")
    expect(withFrame.frame?.placement.mode).toBe("overlay")
  })
})

describe("autoCameraFrame preset mirror", () => {
  for (const preset of PRESETS) {
    for (const { name, canvas } of CANVASES) {
      it(`round-trips ${preset} at ${name} within 1px`, () => {
        const aspectRatio = canvas.aspectRatio as CanvasAspectRatio | undefined
        const frame = autoCameraFrame({ preset, aspectRatio })
        const mirrored = legacyTransformFromFrame(frame, canvas, SOURCE_720P)
        const expected = buildCameraPresetTransform(preset, { canvas, source: SOURCE_720P })
        expectRectNear(mirrored, expected)
        expect(mirrored.preset).toBe(preset)
        expect(mirrored.shape).toBe(expected.shape)
        if (expected.crop) {
          expect(mirrored.crop).toBeDefined()
          expectRectNear(mirrored.crop!, expected.crop)
        }
      })
    }
  }
})

describe("resolveCameraFrame", () => {
  const pinnedFrame = cameraFrameSchema.parse({
    placement: { origin: "pinned", align: { x: 1, y: 1 }, size: 0.311, margin: 0.022 },
    shape: "rounded",
    aspect: "5:7",
  })

  it("scales rect, radius and style with the canvas short edge", () => {
    const at1080 = resolveCameraFrame({
      frame: pinnedFrame,
      canvas: { width: 1920, height: 1080 },
      source: SOURCE_720P,
    })
    const at2160 = resolveCameraFrame({
      frame: pinnedFrame,
      canvas: { width: 3840, height: 2160 },
      source: SOURCE_720P,
    })
    for (const key of ["x", "y", "width", "height"] as const) {
      expect(Math.abs(at2160.rect[key] - at1080.rect[key] * 2)).toBeLessThanOrEqual(1)
    }
    expect(Math.abs(at2160.radius - at1080.radius * 2)).toBeLessThanOrEqual(1)
    expect(at2160.style.borderWidth).toBeCloseTo(at1080.style.borderWidth * 2)
    expect(at2160.style.shadowBlur).toBeCloseTo(at1080.style.shadowBlur * 2)
    expect(at2160.style.shadowOffsetY).toBeCloseTo(at1080.style.shadowOffsetY * 2)
    expect(at2160.crop).toEqual(at1080.crop)
  })

  it("keeps a pinned frame anchored on a ratio change", () => {
    const wide = resolveCameraFrame({
      frame: pinnedFrame,
      canvas: { width: 1920, height: 1080 },
    })
    const tall = resolveCameraFrame({
      frame: pinnedFrame,
      canvas: { width: 1080, height: 1920 },
    })
    for (const rect of [wide.rect, tall.rect]) {
      expect(rect.x).toBeGreaterThanOrEqual(0)
      expect(rect.y).toBeGreaterThanOrEqual(0)
    }
    expect(tall.rect.x + tall.rect.width).toBeLessThanOrEqual(1080)
    expect(tall.rect.y + tall.rect.height).toBeLessThanOrEqual(1920)
    // Bottom-right anchor is preserved relative to the canvas.
    const margin = Math.round(0.022 * 1080)
    expect(tall.rect.x + tall.rect.width).toBe(1080 - margin)
    expect(tall.rect.y + tall.rect.height).toBe(1920 - margin)
    expect(wide.rect.x + wide.rect.width).toBe(1920 - margin)
    expect(wide.rect.y + wide.rect.height).toBe(1080 - margin)
    // Same fractions: identical frame size on the same short edge.
    expect(tall.rect.width).toBe(wide.rect.width)
    expect(tall.rect.height).toBe(wide.rect.height)
  })

  it("rebuilds auto frames per ratio (circle table vs 16:9 fallback)", () => {
    expect(autoPresetForAspectRatio("16:9")).toBe("side-by-side")
    expect(autoPresetForAspectRatio("9:16")).toBe("circle-pip")
    expect(autoPresetForAspectRatio("1:1")).toBe("circle-pip")
    const vertical = autoCameraFrame({ preset: "circle-pip", aspectRatio: "9:16" })
    const wide = autoCameraFrame({ preset: "circle-pip", aspectRatio: "16:9" })
    expect(vertical.placement.size).not.toBe(wide.placement.size)
    const resolvedVertical = resolveCameraFrame({
      frame: vertical,
      canvas: { width: 1080, height: 1920 },
    })
    // The 9:16 table places the 840 px circle at y=950 on a 1080x1920 canvas.
    expectRectNear(resolvedVertical.rect, { x: 120, y: 950, width: 840, height: 840 })
  })
})

describe("computeSplit", () => {
  it("produces the clip-level slot and column like the domain preset", () => {
    const canvas: CameraFrameCanvas = { width: 1920, height: 1080, padding: 24 }
    const area = { x: 24, y: 24, width: 1872, height: 1032 }
    const { screen, column } = computeSplit(
      canvas,
      { side: "right", ratio: 0.76, gap: 0.02, fit: "frame" },
      area,
    )
    // Mirrors Rust video_screen_rect(.., is_side_by_side = true): slot width
    // round(area.width * ratio), slot height slotWidth * canvas aspect,
    // vertically centred in the content area.
    expect(screen).toEqual({ x: 24, y: 140, width: 1423, height: 800 })
    expect(column).toEqual({ x: 1484, y: 24, width: 412, height: 1032 })
  })

  it("produces the exact lane side-by-side geometry", () => {
    const canvas: CameraFrameCanvas = { width: 1920, height: 1080 }
    const { screen, column } = computeSplit(
      canvas,
      { side: "right", ratio: 0.5, gap: 0, fit: "column" },
      { x: 0, y: 0, width: 1920, height: 1080 },
    )
    expect(screen).toEqual({ x: 0, y: 0, width: 960, height: 1080 })
    expect(column).toEqual({ x: 960, y: 0, width: 960, height: 1080 })
  })

  it("mirrors side 'left' and horizontal band splits", () => {
    const canvas: CameraFrameCanvas = { width: 1920, height: 1080 }
    const area = { x: 0, y: 0, width: 1920, height: 1080 }
    const left = computeSplit(canvas, { side: "left", ratio: 0.76, gap: 0.02, fit: "frame" }, area)
    expect(left.column.x).toBe(0)
    expect(left.column.width).toBe(1920 - 1459 - 38)
    expect(left.screen.x).toBe(left.column.width + 38)
    expect(left.screen.width).toBe(1459)

    const top = computeSplit(canvas, { side: "top", ratio: 0.5, gap: 0, fit: "column" }, area)
    expect(top.column).toEqual({ x: 0, y: 0, width: 1920, height: 540 })
    expect(top.screen).toEqual({ x: 0, y: 540, width: 1920, height: 540 })
  })
})

describe("resolveCameraFrame lane overrides", () => {
  const canvas: CameraFrameCanvas = { width: 1920, height: 1080 }
  // Pinned base frame identical to the legacy 480x270 rounded rect at
  // (1400, 640), which lane tests use as the base transform.
  const baseFrame = cameraFrameSchema.parse({
    placement: {
      origin: "pinned",
      align: { x: 1400 / 1440, y: 640 / 810 },
      size: 270 / 1080,
      margin: 0,
    },
    shape: "rounded",
    aspect: "16:9",
  })

  function resolve(segments: CameraLayoutSegment[], timeMs: number) {
    return resolveCameraFrame({ frame: baseFrame, canvas, source: SOURCE_720P, segments, timeMs })
  }

  it("resolves the base frame when the lane is empty or inactive", () => {
    const resolved = resolve([], 500)
    expect(resolved.rect).toEqual({ x: 1400, y: 640, width: 480, height: 270 })
    expect(resolved.layout).toBe("base")
    expect(resolved.segmentId).toBeNull()
    expect(resolved.mode).toBe("overlay")
    expect(resolved.radius).toBe(Math.round(270 * CAMERA_CORNER_RADIUS_FRACTION))
  })

  it("pip overrides the overlay with the legacy lane geometry (new 0.12 radius)", () => {
    const resolved = resolve(
      [
        laneSegment("one", 1_000, 2_000, "pip", {
          pip: { corner: "br", sizeFraction: 0.3, shape: "rounded" },
        }),
      ],
      2_000,
    )
    const height = Math.round(1080 * 0.3)
    const width = Math.round(height * (480 / 270))
    expect(resolved.layout).toBe("pip")
    expect(resolved.segmentId).toBe("one")
    expect(resolved.rect).toEqual({
      x: 1920 - width - Math.round(1080 * 0.04),
      y: 1080 - height - Math.round(1080 * 0.04),
      width,
      height,
    })
    // ADR 023: the lane now uses the canonical 0.12 radius (was 0.08).
    expect(resolved.radius).toBe(Math.round(Math.min(width, height) * 0.12))
    expect(resolved.mode).toBe("overlay")
  })

  it("supports every pip corner plus the custom pin", () => {
    const margin = Math.round(1080 * 0.04)
    const height = Math.round(1080 * 0.24)
    const width = Math.round(height * (480 / 270))
    const corners = [
      { corner: "tl", x: margin, y: margin },
      { corner: "tr", x: 1920 - width - margin, y: margin },
      { corner: "bl", x: margin, y: 1080 - height - margin },
      { corner: "br", x: 1920 - width - margin, y: 1080 - height - margin },
    ] as const
    for (const { corner, x, y } of corners) {
      const resolved = resolve(
        [
          laneSegment("s", 0, 1_000, "pip", {
            pip: { corner, sizeFraction: 0.24, shape: "rounded" },
          }),
        ],
        500,
      )
      expect(resolved.rect.x).toBe(x)
      expect(resolved.rect.y).toBe(y)
    }
    const custom = resolve(
      [
        laneSegment("s", 0, 1_000, "pip", {
          pip: { corner: "custom", sizeFraction: 0.24, shape: "circle", x: 0.5, y: 0.1 },
        }),
      ],
      500,
    )
    expect(custom.rect).toEqual({
      x: Math.round(0.5 * 1920),
      y: Math.round(0.1 * 1080),
      width,
      height,
    })
    expect(custom.radius).toBe(Math.min(width, height) / 2)
  })

  it("fullscreen covers the canvas, hidden fades the base rect", () => {
    const full = resolve([laneSegment("s", 0, 1_000, "fullscreen")], 500)
    expect(full.rect).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
    expect(full.mode).toBe("full")
    expect(full.radius).toBe(0)

    const hidden = resolve([laneSegment("s", 0, 1_000, "hidden")], 500)
    expect(hidden.opacity).toBe(0)
    expect(hidden.rect).toEqual({ x: 1400, y: 640, width: 480, height: 270 })
  })

  it("side-by-side splits via the shared computeSplit lane spec", () => {
    const resolved = resolve([laneSegment("s", 0, 1_000, "side-by-side")], 500)
    expect(resolved.screen).toEqual({ x: 0, y: 0, width: 960, height: 1080 })
    expect(resolved.rect).toEqual({ x: 960, y: 0, width: 960, height: 1080 })
    expect(resolved.mode).toBe("split")
  })
})

describe("legacy transform migration", () => {
  const canvas: CameraFrameCanvas = { width: 1920, height: 1080, aspectRatio: "16:9" }

  it("migrates a matching preset transform to origin auto", () => {
    const transform = buildCameraPresetTransform("vertical-pip", {
      canvas,
      source: SOURCE_720P,
    })
    const frame = cameraFrameFromLegacyTransform(transform, canvas, SOURCE_720P)
    expect(frame.preset).toBe("vertical-pip")
    expect(frame.placement.origin).toBe("auto")
    const mirrored = legacyTransformFromFrame(frame, canvas, SOURCE_720P)
    expectRectNear(mirrored, transform)
  })

  it("pins a preset transform whose geometry no longer matches", () => {
    const transform = {
      ...buildCameraPresetTransform("vertical-pip", { canvas, source: SOURCE_720P }),
      x: 200,
    }
    const frame = cameraFrameFromLegacyTransform(transform, canvas, SOURCE_720P)
    expect(frame.placement.origin).toBe("pinned")
    // The preset name is preserved but cannot trigger an auto rebuild.
    expect(frame.preset).toBe("vertical-pip")
    const resolved = resolveCameraFrame({ frame, canvas })
    expect(resolved.rect.x).toBe(200)
  })

  it("pins a manual transform and resolves back to the same rect", () => {
    const transform: ClipTransform = {
      x: 1400,
      y: 640,
      width: 480,
      height: 270,
      opacity: 1,
      shape: "rounded",
      borderWidth: 4,
      shadowBlur: 32,
    }
    const frame = cameraFrameFromLegacyTransform(transform, canvas, SOURCE_720P)
    expect(frame.placement.origin).toBe("pinned")
    expect(frame.aspect).toBe("16:9")
    expect(frame.placement.size).toBeCloseTo(0.25)
    const resolved = resolveCameraFrame({ frame, canvas, source: SOURCE_720P })
    expectRectNear(resolved.rect, transform)
    // Style lengths migrate through design units (scale 1 at 1080 base).
    expect(frame.style.borderWidth).toBe(4)
    expect(frame.style.shadowBlur).toBe(32)
    const mirrored = legacyTransformFromFrame(frame, canvas, SOURCE_720P)
    expectRectNear(mirrored, transform)
  })

  it("maps a legacy crop to framing and back", () => {
    const transform: ClipTransform = {
      x: 100,
      y: 100,
      width: 400,
      height: 225,
      opacity: 1,
      shape: "rectangle",
      crop: { x: 320, y: 90, width: 640, height: 360 },
    }
    const frame = cameraFrameFromLegacyTransform(transform, canvas, SOURCE_720P)
    expect(frame.aspect).toBe("16:9")
    expect(frame.framing.zoom).toBeCloseTo(2)
    expect(frame.framing.focusX).toBeCloseTo(0.5)
    expect(frame.framing.focusY).toBeCloseTo(0.375)
    const resolved = resolveCameraFrame({ frame, canvas, source: SOURCE_720P })
    expectRectNear(resolved.crop!, transform.crop!)
  })

  it("prefers clip.frame and falls back to the transform", () => {
    const explicit = cameraFrameSchema.parse({ shape: "circle" })
    const clip: CameraClip = cameraClipSchema.parse({
      id: "cam-1",
      assetId: "asset-1",
      kind: "camera",
      startMs: 0,
      durationMs: 1_000,
      sourceInMs: 0,
      sourceOutMs: 1_000,
      transform: { x: 10, y: 10, width: 100, height: 100, shape: "rectangle" },
      frame: explicit,
    })
    expect(getCameraFrame(clip, canvas)).toEqual(explicit)
    const legacyOnly: CameraClip = { ...clip, frame: undefined }
    const migrated = getCameraFrame(legacyOnly, canvas, SOURCE_720P)
    expect(migrated.placement.origin).toBe("pinned")
  })
})

describe("cameraCoverCrop", () => {
  it("matches the domain cover crop for default framing", () => {
    const crop = cameraCoverCrop(SOURCE_720P, 5 / 7, { focusX: 0.5, focusY: 0.5, zoom: 1 })
    expect(crop).toEqual({ x: 383, y: 0, width: 514, height: 720 })
    const square = cameraCoverCrop(SOURCE_720P, 1, { focusX: 0.5, focusY: 0.5, zoom: 1 })
    expect(square).toEqual({ x: 280, y: 0, width: 720, height: 720 })
  })

  it("shrinks the crop around the focus when zoomed", () => {
    const crop = cameraCoverCrop(SOURCE_720P, 1, { focusX: 0.25, focusY: 0.5, zoom: 2 })
    expect(crop).toEqual({ x: 140, y: 180, width: 360, height: 360 })
  })
})

describe("parity fixture", () => {
  it("matches the checked-in camera-frame-resolve.json", () => {
    const fixturePath = fileURLToPath(
      new URL(
        "../../../tooling/fixtures/camera-fixtures/camera-frame-resolve.json",
        import.meta.url,
      ),
    )
    const checkedIn = JSON.parse(readFileSync(fixturePath, "utf-8"))
    const regenerated = buildCameraFrameFixtureDocument()
    expect(regenerated.cases.length).toBeGreaterThanOrEqual(20)
    expect(regenerated).toEqual(checkedIn)
  })
})
