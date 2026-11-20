import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import type { TimelineCanvas, TimelineSelection, TimelineState } from "@recordforge/contracts"
import { defaultCursorSettings, defaultMotionBlurSettings } from "@recordforge/contracts"

const mockEnv = vi.hoisted(() => ({
  playheadMs: 0,
  zoomPreviewActive: false,
  seek: vi.fn<(ms: number) => void>(),
  setZoomPreviewActive: vi.fn<(active: boolean) => void>(),
  selection: null as TimelineSelection | null,
  timeline: undefined as TimelineState | undefined,
  cursorEngine: null,
  hooks: {
    slots: [] as unknown[],
    cursor: 0,
  },
}))

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>()
  return {
    ...actual,
    useId: () => "mb-test-id",
    useState: <T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] => {
      const idx = mockEnv.hooks.cursor++
      if (!(idx in mockEnv.hooks.slots)) {
        mockEnv.hooks.slots[idx] = typeof initial === "function" ? (initial as () => T)() : initial
      }
      const setState = (next: T | ((prev: T) => T)) => {
        const prev = mockEnv.hooks.slots[idx] as T
        mockEnv.hooks.slots[idx] = typeof next === "function" ? (next as (p: T) => T)(prev) : next
      }
      return [mockEnv.hooks.slots[idx] as T, setState]
    },
    useMemo: <T>(factory: () => T): T => factory(),
  }
})

vi.mock("../../../../stores/license-store", () => ({
  useLicenseStore: (selector: (s: { status: { tier: "pro" } }) => unknown) =>
    selector({ status: { tier: "pro" } }),
}))

vi.mock("../../../../stores/timeline-store", () => ({
  useTimelineStore: (
    selector: (s: {
      engine?: { history: { present: TimelineState } }
      cursorEngine: null
      seek: (ms: number) => void
      view: { selection: TimelineSelection | null }
      zoomPreviewActive: boolean
      setZoomPreviewActive: (active: boolean) => void
    }) => unknown,
  ) =>
    selector({
      engine: mockEnv.timeline ? { history: { present: mockEnv.timeline } } : undefined,
      cursorEngine: mockEnv.cursorEngine,
      seek: mockEnv.seek,
      view: { selection: mockEnv.selection },
      zoomPreviewActive: mockEnv.zoomPreviewActive,
      setZoomPreviewActive: mockEnv.setZoomPreviewActive,
    }),
}))

vi.mock("../../timeline/use-playback-state", () => ({
  usePlayheadMs: () => mockEnv.playheadMs,
}))

import { MotionBlurControls } from "./motion-blur-controls"

function collectText(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") {
    out.push(node)
    return out
  }
  if (typeof node === "number") {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (node && typeof node === "object" && "props" in node) {
    const props = (node as { props?: { children?: ReactNode } }).props
    if (props?.children !== undefined) collectText(props.children, out)
  }
  return out
}

interface ClickableElement {
  props: {
    children?: ReactNode
    onClick?: () => void
  }
}

function findButtonByLabel(node: unknown, label: string): ClickableElement | null {
  if (!node || typeof node !== "object") return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findButtonByLabel(child, label)
      if (hit) return hit
    }
    return null
  }
  if ("props" in node) {
    const el = node as ClickableElement
    const text = collectText(el.props.children).join("")
    if (typeof el.props.onClick === "function" && text.includes(label)) {
      return el
    }
    return findButtonByLabel(el.props.children, label)
  }
  return null
}

function makeCanvas(motionBlur = defaultMotionBlurSettings): TimelineCanvas {
  return {
    width: 1920,
    height: 1080,
    fps: 60,
    aspectRatio: "16:9",
    padding: 0,
    borderRadius: 0,
    shadow: false,
    background: "#000000",
    cursorSettings: defaultCursorSettings,
    motionBlur,
  }
}

function makeTimeline(canvas: TimelineCanvas): TimelineState {
  return {
    id: "tl-1",
    projectId: "proj-1",
    name: "Demo",
    canvas,
    tracks: [],
    zoomSegments: [
      {
        id: "zoom-1",
        startMs: 1_000,
        endMs: 3_000,
        durationMs: 2_000,
        target: { x: 240, y: 135, width: 960, height: 540 },
        scale: 2,
        easing: "smooth",
        transitionInMs: 500,
        transitionOutMs: 500,
        mode: "fixed",
        followPadding: 0.1,
        style: "frame",
        enabled: true,
      },
    ],
  } as unknown as TimelineState
}

describe("MotionBlurControls", () => {
  beforeEach(() => {
    mockEnv.hooks.slots = []
    mockEnv.hooks.cursor = 0
    mockEnv.playheadMs = 0
    mockEnv.zoomPreviewActive = false
    mockEnv.seek.mockClear()
    mockEnv.setZoomPreviewActive.mockClear()
    mockEnv.setZoomPreviewActive.mockImplementation((active) => {
      mockEnv.zoomPreviewActive = active
    })
    const canvas = makeCanvas()
    mockEnv.timeline = makeTimeline(canvas)
    mockEnv.selection = { kind: "zoom", segmentId: "zoom-1" }
  })

  it("warns and surfaces a Preview button when zoom framing hides zoom blur in full and compact modes", () => {
    const canvas = mockEnv.timeline!.canvas

    for (const variant of ["full", "compact"] as const) {
      mockEnv.hooks.cursor = 0
      const tree = MotionBlurControls({ canvas, onChange: vi.fn(), variant })
      const text = collectText(tree).join(" ")
      expect(text).toContain("Zoom framing hides zoom blur")
      const previewBtn = findButtonByLabel(tree, "Preview")
      expect(previewBtn).not.toBeNull()
    }
  })

  it("unlocks zoom framing and seeks only when not already sitting on a blurred frame", () => {
    const canvas = mockEnv.timeline!.canvas

    // Playhead at still frame 0ms -> unlocks framing AND seeks to the blurred transition target.
    mockEnv.hooks.cursor = 0
    const treeStill = MotionBlurControls({ canvas, onChange: vi.fn(), variant: "full" })
    const btnStill = findButtonByLabel(treeStill, "Preview")
    expect(btnStill).not.toBeNull()
    btnStill?.props.onClick?.()

    expect(mockEnv.setZoomPreviewActive).toHaveBeenCalledWith(true)
    expect(mockEnv.zoomPreviewActive).toBe(true)
    expect(mockEnv.seek).toHaveBeenCalledTimes(1)
    expect(mockEnv.seek.mock.calls[0][0]).toBeGreaterThanOrEqual(1_000)

    // Reset: playhead already inside the blurred ramp (1225ms) -> unlocks framing WITHOUT seeking away.
    mockEnv.zoomPreviewActive = false
    mockEnv.playheadMs = 1_225
    mockEnv.seek.mockClear()
    mockEnv.setZoomPreviewActive.mockClear()
    mockEnv.hooks.cursor = 0

    const treeTransition = MotionBlurControls({ canvas, onChange: vi.fn(), variant: "compact" })
    const btnTransition = findButtonByLabel(treeTransition, "Preview")
    expect(btnTransition).not.toBeNull()
    btnTransition?.props.onClick?.()

    expect(mockEnv.setZoomPreviewActive).toHaveBeenCalledWith(true)
    expect(mockEnv.zoomPreviewActive).toBe(true)
    expect(mockEnv.seek).not.toHaveBeenCalled()
  })
})
