import { describe, expect, it } from "vitest"
import {
  defaultCursorSettings,
  type ManualZoomSegment,
  type TimelineState,
} from "@recordforge/contracts"
import { resolveCameraShots } from "./camera-shots"
import { findManualZoomAtTime } from "./composition"
import {
  findLoupeAtTime,
  isLoupeSegment,
  loupeCornerRadius,
  loupeOffsetAfterDrag,
  loupeSampleSquare,
  loupeSizeAfterResize,
  loupeSurfaceScale,
  resolveLoupeAt,
  resolveLoupeSettings,
  resolveLoupes,
} from "./zoom-loupe"

function makeState(zoomSegments: ManualZoomSegment[]): TimelineState {
  return {
    version: 1,
    id: "loupe-project",
    name: "Glass Loupe",
    recordingId: "recording",
    canvas: {
      width: 1920,
      height: 1080,
      fps: 60,
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
            id: "screen-clip",
            kind: "screen",
            assetId: "recording",
            startMs: 0,
            durationMs: 20_000,
            sourceInMs: 0,
            sourceOutMs: 20_000,
            speed: 1,
          },
        ],
      },
    ],
    markers: [],
    zoomSegments,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }
}

function loupeSegment(overrides: Partial<ManualZoomSegment> = {}): ManualZoomSegment {
  return {
    id: "loupe-1",
    startMs: 1_000,
    durationMs: 3_000,
    target: { x: 400, y: 200, width: 480, height: 270 },
    scale: 2,
    easing: "smooth",
    transitionInMs: 300,
    transitionOutMs: 300,
    enabled: true,
    locked: false,
    mode: "manual",
    source: "manual",
    preset: "product-demo",
    style: "loupe",
    ...overrides,
  }
}

describe("loupe segments are not camera shots", () => {
  it("resolveCameraShots skips them while resolveLoupes returns them", () => {
    const frame = loupeSegment({ id: "frame-1", style: "frame", startMs: 6_000, durationMs: 2_000 })
    const state = makeState([loupeSegment(), frame])
    expect(resolveCameraShots(state).map((shot) => shot.id)).toEqual(["frame-1"])
    expect(resolveLoupes(state).map((segment) => segment.id)).toEqual(["loupe-1"])
  })

  it("the frame zoom lookup ignores a loupe under the playhead", () => {
    const state = makeState([loupeSegment()])
    expect(findManualZoomAtTime(state, 2_000)).toBeNull()
    expect(findLoupeAtTime(state, 2_000)?.id).toBe("loupe-1")
    expect(findLoupeAtTime(state, 4_500)).toBeNull()
  })

  it("returns segment references so follow-plan caches can key on identity", () => {
    const state = makeState([loupeSegment()])
    expect(findLoupeAtTime(state, 2_000)).toBe(state.zoomSegments?.[0])
    expect(resolveLoupes(state)[0]).toBe(state.zoomSegments?.[0])
  })

  it("isLoupeSegment only matches the explicit style", () => {
    expect(isLoupeSegment(loupeSegment())).toBe(true)
    expect(isLoupeSegment(loupeSegment({ style: "frame" }))).toBe(false)
    expect(isLoupeSegment(loupeSegment({ style: undefined }))).toBe(false)
  })
})

describe("resolveLoupeAt", () => {
  it("sizes the lens from the canvas short edge and centres it on the target", () => {
    const state = makeState([loupeSegment()])
    const pose = resolveLoupeAt(loupeSegment(), state, 2_500)
    const expectedDiameter = 0.34 * 1_080
    expect(pose.visible).toBe(true)
    expect(pose.presence).toBeCloseTo(1, 6)
    expect(pose.rect.width).toBeCloseTo(expectedDiameter, 6)
    expect(pose.center.x).toBeCloseTo(400 + 480 / 2, 6)
    expect(pose.center.y).toBeCloseTo(200 + 270 / 2, 6)
    expect(pose.settings.shape).toBe("circle")
    expect(pose.scale).toBe(2)
  })

  it("keeps the lens fully on the canvas when the target hugs an edge", () => {
    const segment = loupeSegment({ target: { x: 0, y: 0, width: 480, height: 270 } })
    const state = makeState([segment])
    const pose = resolveLoupeAt(segment, state, 2_500)
    expect(pose.rect.x).toBeGreaterThanOrEqual(0)
    expect(pose.rect.y).toBeGreaterThanOrEqual(0)
    expect(pose.rect.x + pose.rect.width).toBeLessThanOrEqual(1_920 + 1e-6)
    expect(pose.rect.y + pose.rect.height).toBeLessThanOrEqual(1_080 + 1e-6)
  })

  it("applies the offset and the segment's own easing for the growth", () => {
    const segment = loupeSegment({ loupe: resolveLoupeSettings({ offset: { x: 40, y: -30 } }) })
    const state = makeState([segment])
    const pose = resolveLoupeAt(segment, state, 2_500)
    expect(pose.center.x).toBeCloseTo(640 + 40, 6)
    expect(pose.center.y).toBeCloseTo(335 - 30, 6)

    const early = resolveLoupeAt(segment, state, 1_000 + 1)
    expect(early.presence).toBeGreaterThan(0)
    expect(early.presence).toBeLessThan(1)
    expect(early.rect.width).toBeLessThan(pose.rect.width)
  })

  it("reports no lens outside the segment", () => {
    const state = makeState([loupeSegment()])
    expect(resolveLoupeAt(loupeSegment(), state, 500).visible).toBe(false)
  })

  it("rides the cursor point when one resolves", () => {
    const segment = loupeSegment()
    const state = makeState([segment])
    const pose = resolveLoupeAt(segment, state, 2_500, null, { x: 1_000, y: 600 })
    expect(pose.following).toBe(true)
    // The magnified target centres on the point and the lens centre sits on it.
    expect(pose.target.x + pose.target.width / 2).toBeCloseTo(1_000, 6)
    expect(pose.target.y + pose.target.height / 2).toBeCloseTo(600, 6)
    expect(pose.center.x).toBeCloseTo(1_000, 6)
    expect(pose.center.y).toBeCloseTo(600, 6)
  })

  it("nudges the lens off the cursor point with the drag offset", () => {
    const segment = loupeSegment({ loupe: resolveLoupeSettings({ offset: { x: 40, y: -30 } }) })
    const state = makeState([segment])
    const pose = resolveLoupeAt(segment, state, 2_500, null, { x: 1_000, y: 600 })
    expect(pose.center.x).toBeCloseTo(1_040, 6)
    expect(pose.center.y).toBeCloseTo(570, 6)
  })

  it("parks on the centre/target centre when no cursor point resolves", () => {
    const parked = loupeSegment({
      loupe: resolveLoupeSettings({ center: { x: 400, y: 420 } }),
    })
    const pose = resolveLoupeAt(parked, makeState([parked]), 2_500, null, null)
    expect(pose.following).toBe(false)
    expect(pose.center.x).toBeCloseTo(400, 6)
    expect(pose.center.y).toBeCloseTo(420, 6)

    const fallback = resolveLoupeAt(loupeSegment(), makeState([loupeSegment()]), 2_500)
    expect(fallback.following).toBe(false)
    expect(fallback.center.x).toBeCloseTo(640, 6)
    expect(fallback.center.y).toBeCloseTo(335, 6)
  })

  it("gives circles half-width corners and scales the rounded-rect radius", () => {
    const circle = resolveLoupeAt(loupeSegment(), makeState([loupeSegment()]), 2_500)
    expect(loupeCornerRadius(circle)).toBeCloseTo(circle.rect.width / 2, 6)

    const rounded = loupeSegment({
      loupe: resolveLoupeSettings({ shape: "rounded-rect", cornerRadius: 0.2 }),
    })
    const pose = resolveLoupeAt(rounded, makeState([rounded]), 2_500)
    expect(loupeCornerRadius(pose)).toBeCloseTo((pose.rect.width * 0.2) / 2, 6)
  })

  it("maps parked zoom-space targets into screenRect on a 9:16 portrait canvas", () => {
    // 9:16 portrait canvas with a centered 16:9 screen slot (letterboxed top/bottom).
    const segment = loupeSegment({
      target: { x: 270, y: 480, width: 540, height: 960 },
      scale: 2,
    })
    const state = makeState([segment])
    state.canvas = { ...state.canvas, width: 1_080, height: 1_920, padding: 48 }
    const screenRect = { x: 48, y: 688, width: 984, height: 554 }

    const pose = resolveLoupeAt(segment, state, 2_500, null, null, { screenRect })
    // Target centre in zoom space is (540, 960) = (0.5, 0.5), which maps to the
    // exact centre of screenRect in canvas pixels.
    expect(pose.center.x).toBeCloseTo(48 + 984 / 2, 6)
    expect(pose.center.y).toBeCloseTo(688 + 554 / 2, 6)
    // Lens stays a true square sized from the canvas short edge (1080).
    expect(pose.rect.width).toBeCloseTo(0.34 * 1_080, 6)
    expect(pose.rect.width).toBeCloseTo(pose.rect.height, 6)

    const sample = loupeSampleSquare(pose, screenRect)
    expect(sample.x).toBeGreaterThanOrEqual(screenRect.x - 1e-6)
    expect(sample.y).toBeGreaterThanOrEqual(screenRect.y - 1e-6)
    expect(sample.x + sample.width).toBeLessThanOrEqual(screenRect.x + screenRect.width + 1e-6)
    expect(sample.y + sample.height).toBeLessThanOrEqual(screenRect.y + screenRect.height + 1e-6)
  })

  it("separates zoomed display position from unzoomed sample target during overlapping frame zoom", () => {
    const segment = loupeSegment({
      loupe: resolveLoupeSettings({ offset: { x: 20, y: -15 } }),
    })
    const state = makeState([segment])
    const screenRect = { x: 48, y: 27, width: 1_824, height: 1_026 }
    // Cursor is at (480, 270) in zoom space, i.e. 25% across screenRect, while
    // an active frame zoom places the visible cursor at (1200, 600) on canvas.
    const pose = resolveLoupeAt(
      segment,
      state,
      2_500,
      null,
      { x: 480, y: 270 },
      {
        screenRect,
        displayCursorPoint: { x: 1_200, y: 600 },
      },
    )

    expect(pose.following).toBe(true)
    // Lens rides the visible (zoomed) cursor position + offset.
    expect(pose.center.x).toBeCloseTo(1_220, 6)
    expect(pose.center.y).toBeCloseTo(585, 6)
    // Magnified sample stays centred on the unzoomed screen point underneath.
    expect(pose.target.x + pose.target.width / 2).toBeCloseTo(48 + 1_824 * 0.25, 6)
    expect(pose.target.y + pose.target.height / 2).toBeCloseTo(27 + 1_026 * 0.25, 6)
    // Following uses a 1x1 target (matching Rust loupe.rs) so edge points never double-clamp.
    expect(pose.target.width).toBe(1)
    expect(pose.target.height).toBe(1)
  })
})

describe("loupeSampleSquare", () => {
  const content = { x: 0, y: 0, width: 1_920, height: 1_080 }

  it("samples a diameter/scale square centred on the target", () => {
    const segment = loupeSegment()
    const pose = resolveLoupeAt(segment, makeState([segment]), 2_500)
    const square = loupeSampleSquare(pose, content)
    // A 2x lens samples half its own diameter and draws it across the lens.
    expect(square.width).toBeCloseTo(pose.rect.width / 2, 6)
    expect(square.width).toBeCloseTo(square.height, 6)
    expect(square.x + square.width / 2).toBeCloseTo(640, 6)
    expect(square.y + square.height / 2).toBeCloseTo(335, 6)
  })

  it("keeps the square inside the content when the target hugs an edge", () => {
    for (const target of [
      { x: 0, y: 0, width: 48, height: 27 },
      { x: 1_872, y: 1_053, width: 48, height: 27 },
      { x: 0, y: 1_053, width: 48, height: 27 },
      { x: 1_872, y: 0, width: 48, height: 27 },
    ]) {
      const segment = loupeSegment({ target })
      const pose = resolveLoupeAt(segment, makeState([segment]), 2_500)
      const square = loupeSampleSquare(pose, content)
      expect(square.x).toBeGreaterThanOrEqual(-1e-9)
      expect(square.y).toBeGreaterThanOrEqual(-1e-9)
      expect(square.x + square.width).toBeLessThanOrEqual(1_920 + 1e-9)
      expect(square.y + square.height).toBeLessThanOrEqual(1_080 + 1e-9)
    }
  })

  it("clamps the square inside a smaller content rect, not the canvas", () => {
    const segment = loupeSegment({ target: { x: 0, y: 0, width: 48, height: 27 } })
    const pose = resolveLoupeAt(segment, makeState([segment]), 2_500)
    const inset = { x: 48, y: 60, width: 1_824, height: 960 }
    const square = loupeSampleSquare(pose, inset)
    expect(square.x).toBeCloseTo(48, 6)
    expect(square.y).toBeCloseTo(60, 6)
  })

  it("samples the lens diameter at scale 1", () => {
    const segment = loupeSegment({ scale: 1 })
    const pose = resolveLoupeAt(segment, makeState([segment]), 2_500)
    const square = loupeSampleSquare(pose, content)
    expect(square.width).toBeCloseTo(pose.rect.width, 6)
  })

  it("never exceeds the content's short edge", () => {
    const segment = loupeSegment({ scale: 8 })
    const pose = resolveLoupeAt(segment, makeState([segment]), 2_500)
    const square = loupeSampleSquare(pose, { x: 0, y: 0, width: 100, height: 40 })
    expect(square.width).toBeLessThanOrEqual(40)
  })
})

describe("lens drag maths", () => {
  it("maps a CSS drag onto canvas coordinates", () => {
    const scale = loupeSurfaceScale(960, 540, 1920, 1080)
    expect(scale.x).toBeCloseTo(0.5, 6)
    expect(scale.y).toBeCloseTo(0.5, 6)
    expect(loupeOffsetAfterDrag({ x: 100, y: 100 }, { x: 50, y: -20 }, scale)).toEqual({
      x: 200,
      y: 60,
    })
  })

  it("resizes by the corner handle and clamps to the schema range", () => {
    const scale = { x: 0.5, y: 0.5 }
    expect(loupeSizeAfterResize(100, 50, scale.x, 1080)).toBeCloseTo(400 / 1080, 6)
    expect(loupeSizeAfterResize(10, -1000, scale.x, 1080)).toBe(0.08)
    expect(loupeSizeAfterResize(10, 1000, scale.x, 1080)).toBe(1)
  })
})
