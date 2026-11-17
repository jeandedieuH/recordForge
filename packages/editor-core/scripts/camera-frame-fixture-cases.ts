/**
 * Shared case table for the camera-frame resolve parity fixture
 * (ADR 023). `buildCameraFrameFixtureDocument` runs `resolveCameraFrame`
 * over a fixed matrix of frames/canvases/lane segments and returns the
 * integer-rounded output that both the checked-in JSON and the Rust parity
 * test compare against — the fixture can never drift from the resolver.
 */
import {
  cameraFrameSchema,
  type CameraFrame,
  type CameraLayoutSegment,
} from "@recordforge/contracts"
import {
  autoCameraFrame,
  resolveCameraFrame,
  type CameraFrameCanvas,
  type CameraSourceSize,
} from "../src/camera-frame"
import type { CanvasRect } from "../src/composition"

export interface CameraFrameFixtureCase {
  name: string
  input: {
    frame: CameraFrame
    canvas: CameraFrameCanvas
    source?: CameraSourceSize
    segments?: CameraLayoutSegment[]
    timeMs?: number
  }
  expected: {
    rect: CanvasRect
    screen: CanvasRect
    radius: number
    opacity: number
    shape: "rectangle" | "rounded" | "circle"
    mode: "overlay" | "split" | "full"
    layout: string
    segmentId: string | null
    crop: CanvasRect | null
  }
}

export interface CameraFrameFixtureDocument {
  version: 1
  cases: CameraFrameFixtureCase[]
}

const CANVAS_1080: CameraFrameCanvas = { width: 1920, height: 1080 }
const CANVAS_2160: CameraFrameCanvas = { width: 3840, height: 2160 }
const PADDED_1080: CameraFrameCanvas = { width: 1920, height: 1080, padding: 24 }
const VERTICAL_9x16: CameraFrameCanvas = { width: 1080, height: 1920, aspectRatio: "9:16" }

const SOURCE_720P: CameraSourceSize = { width: 1280, height: 720 }
const SOURCE_1080P: CameraSourceSize = { width: 1920, height: 1080 }

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

function roundRect(rect: CanvasRect): CanvasRect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

interface FixtureSpec {
  name: string
  frame: CameraFrame
  canvas: CameraFrameCanvas
  source?: CameraSourceSize
  segments?: CameraLayoutSegment[]
  timeMs?: number
}

function evaluate(spec: FixtureSpec): CameraFrameFixtureCase {
  const resolved = resolveCameraFrame({
    frame: spec.frame,
    canvas: spec.canvas,
    source: spec.source,
    segments: spec.segments,
    timeMs: spec.timeMs,
  })
  return {
    name: spec.name,
    input: {
      frame: spec.frame,
      canvas: spec.canvas,
      source: spec.source,
      segments: spec.segments,
      timeMs: spec.timeMs,
    },
    expected: {
      rect: roundRect(resolved.rect),
      screen: roundRect(resolved.screen),
      radius: Math.round(resolved.radius),
      opacity: Math.round(resolved.opacity * 10_000) / 10_000,
      shape: resolved.shape,
      mode: resolved.mode,
      layout: resolved.layout,
      segmentId: resolved.segmentId,
      crop: resolved.crop ? roundRect(resolved.crop) : null,
    },
  }
}

const BASE_TRANSFORM_FRAME = cameraFrameSchema.parse({
  placement: { origin: "pinned", align: { x: 0.9722, y: 0.7901 }, size: 0.25, margin: 0 },
  shape: "rounded",
  aspect: "16:9",
})

const CASES: FixtureSpec[] = [
  {
    name: "default-frame-1080p",
    frame: cameraFrameSchema.parse({}),
    canvas: CANVAS_1080,
    source: SOURCE_720P,
  },
  {
    name: "default-frame-2160p",
    frame: cameraFrameSchema.parse({}),
    canvas: CANVAS_2160,
    source: SOURCE_720P,
  },
  {
    name: "default-frame-vertical-canvas",
    frame: cameraFrameSchema.parse({}),
    canvas: VERTICAL_9x16,
    source: SOURCE_720P,
  },
  {
    name: "overlay-top-left-no-margin",
    frame: cameraFrameSchema.parse({
      placement: { origin: "pinned", align: { x: 0, y: 0 }, margin: 0 },
    }),
    canvas: CANVAS_1080,
    source: SOURCE_720P,
  },
  {
    name: "overlay-centred-16x9",
    frame: cameraFrameSchema.parse({
      placement: { origin: "pinned", align: { x: 0.5, y: 0.5 }, size: 0.4 },
      aspect: "16:9",
    }),
    canvas: CANVAS_1080,
    source: SOURCE_720P,
  },
  {
    name: "overlay-content-anchored-padded-canvas",
    frame: cameraFrameSchema.parse({
      placement: { origin: "pinned", anchorTo: "content", margin: 0.01 },
    }),
    canvas: PADDED_1080,
    source: SOURCE_720P,
  },
  {
    name: "circle-overlay",
    frame: cameraFrameSchema.parse({
      placement: { origin: "pinned", size: 0.28 },
      shape: "circle",
    }),
    canvas: CANVAS_1080,
    source: SOURCE_720P,
  },
  {
    name: "source-aspect-overlay",
    frame: cameraFrameSchema.parse({
      placement: { origin: "pinned" },
      aspect: "source",
    }),
    canvas: CANVAS_1080,
    source: SOURCE_1080P,
  },
  {
    name: "numeric-aspect-overlay",
    frame: cameraFrameSchema.parse({
      placement: { origin: "pinned", size: 0.3 },
      aspect: 1.5,
    }),
    canvas: CANVAS_1080,
    source: SOURCE_720P,
  },
  {
    name: "full-mode-covers-canvas",
    frame: cameraFrameSchema.parse({
      placement: { mode: "full", origin: "pinned" },
      shape: "rectangle",
    }),
    canvas: CANVAS_1080,
    source: SOURCE_720P,
  },
  {
    name: "split-right-frame-fit-content",
    frame: cameraFrameSchema.parse({
      placement: { mode: "split", origin: "pinned", anchorTo: "content" },
      shape: "rectangle",
      aspect: "5:7",
    }),
    canvas: PADDED_1080,
    source: SOURCE_720P,
  },
  {
    name: "split-right-canvas-anchor",
    frame: cameraFrameSchema.parse({
      placement: { mode: "split", origin: "pinned", anchorTo: "canvas" },
      shape: "rectangle",
      aspect: "5:7",
    }),
    canvas: CANVAS_1080,
    source: SOURCE_720P,
  },
  {
    name: "split-left",
    frame: cameraFrameSchema.parse({
      placement: {
        mode: "split",
        origin: "pinned",
        split: { side: "left", ratio: 0.76, gap: 0.02, fit: "frame" },
      },
      shape: "rectangle",
      aspect: "5:7",
    }),
    canvas: CANVAS_1080,
    source: SOURCE_720P,
  },
  {
    name: "split-top",
    frame: cameraFrameSchema.parse({
      placement: {
        mode: "split",
        origin: "pinned",
        split: { side: "top", ratio: 0.7, gap: 0.02, fit: "frame" },
      },
      shape: "rectangle",
      aspect: "16:9",
    }),
    canvas: CANVAS_1080,
    source: SOURCE_720P,
  },
  {
    name: "split-bottom-column-fit",
    frame: cameraFrameSchema.parse({
      placement: {
        mode: "split",
        origin: "pinned",
        split: { side: "bottom", ratio: 0.6, gap: 0.03, fit: "column" },
      },
      shape: "rectangle",
    }),
    canvas: CANVAS_1080,
    source: SOURCE_720P,
  },
  {
    name: "invisible-frame",
    frame: cameraFrameSchema.parse({ visible: false }),
    canvas: CANVAS_1080,
    source: SOURCE_720P,
  },
  {
    name: "custom-style-and-framing",
    frame: cameraFrameSchema.parse({
      placement: { origin: "pinned", size: 0.2 },
      style: {
        opacity: 0.8,
        borderWidth: 4,
        borderColor: "#ff0000",
        shadowEnabled: false,
      },
      framing: { focusX: 0.25, focusY: 0.75, zoom: 2 },
    }),
    canvas: CANVAS_1080,
    source: SOURCE_720P,
  },
  {
    name: "no-source-crop-omitted",
    frame: cameraFrameSchema.parse({}),
    canvas: CANVAS_1080,
  },
  {
    name: "auto-camera-only",
    frame: autoCameraFrame({ preset: "camera-only", aspectRatio: "16:9" }),
    canvas: { ...CANVAS_1080, aspectRatio: "16:9" },
    source: SOURCE_720P,
  },
  {
    name: "auto-vertical-pip-16x9",
    frame: autoCameraFrame({ preset: "vertical-pip", aspectRatio: "16:9" }),
    canvas: { ...CANVAS_1080, aspectRatio: "16:9" },
    source: SOURCE_720P,
  },
  {
    name: "auto-circle-pip-9x16",
    frame: autoCameraFrame({ preset: "circle-pip", aspectRatio: "9:16" }),
    canvas: VERTICAL_9x16,
    source: SOURCE_720P,
  },
  {
    name: "auto-circle-pip-1x1",
    frame: autoCameraFrame({ preset: "circle-pip", aspectRatio: "1:1" }),
    canvas: { width: 1080, height: 1080, aspectRatio: "1:1" },
    source: SOURCE_720P,
  },
  {
    name: "auto-circle-pip-16x9-fallback",
    frame: autoCameraFrame({ preset: "circle-pip", aspectRatio: "16:9" }),
    canvas: { ...CANVAS_1080, aspectRatio: "16:9" },
    source: SOURCE_720P,
  },
  {
    name: "auto-side-by-side-16x9",
    frame: autoCameraFrame({ preset: "side-by-side", aspectRatio: "16:9" }),
    canvas: { ...CANVAS_1080, aspectRatio: "16:9" },
    source: SOURCE_720P,
  },
  {
    name: "lane-pip-br",
    frame: BASE_TRANSFORM_FRAME,
    canvas: CANVAS_1080,
    source: SOURCE_720P,
    segments: [
      laneSegment("seg-1", 1_000, 2_000, "pip", {
        pip: { corner: "br", sizeFraction: 0.3, shape: "rounded" },
      }),
    ],
    timeMs: 2_000,
  },
  {
    name: "lane-pip-custom-pin",
    frame: BASE_TRANSFORM_FRAME,
    canvas: CANVAS_1080,
    source: SOURCE_720P,
    segments: [
      laneSegment("seg-1", 0, 2_000, "pip", {
        pip: { corner: "custom", sizeFraction: 0.24, shape: "circle", x: 0.6, y: 0.1 },
      }),
    ],
    timeMs: 500,
  },
  {
    name: "lane-fullscreen",
    frame: BASE_TRANSFORM_FRAME,
    canvas: CANVAS_1080,
    source: SOURCE_720P,
    segments: [laneSegment("seg-1", 0, 2_000, "fullscreen")],
    timeMs: 500,
  },
  {
    name: "lane-hidden",
    frame: BASE_TRANSFORM_FRAME,
    canvas: CANVAS_1080,
    source: SOURCE_720P,
    segments: [laneSegment("seg-1", 0, 2_000, "hidden")],
    timeMs: 500,
  },
  {
    name: "lane-side-by-side",
    frame: BASE_TRANSFORM_FRAME,
    canvas: CANVAS_1080,
    source: SOURCE_720P,
    segments: [laneSegment("seg-1", 0, 2_000, "side-by-side")],
    timeMs: 500,
  },
  {
    name: "lane-pip-mid-transition",
    frame: BASE_TRANSFORM_FRAME,
    canvas: CANVAS_1080,
    source: SOURCE_720P,
    segments: [
      laneSegment("seg-1", 0, 2_000, "pip", {
        pip: { corner: "tl", sizeFraction: 0.3, shape: "rounded" },
        transitionInMs: 400,
      }),
    ],
    timeMs: 200,
  },
]

export function buildCameraFrameFixtureDocument(): CameraFrameFixtureDocument {
  return { version: 1, cases: CASES.map(evaluate) }
}
