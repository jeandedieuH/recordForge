import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { defaultCursorSettings } from "@recordforge/contracts"
import type { CursorAsset } from "@recordforge/cursor-core"

interface HookRuntime {
  slots: unknown[]
  cursor: number
  dirty: boolean
  layoutEffects: Array<{ idx: number; deps?: readonly unknown[]; fn: () => void | (() => void) }>
  passiveEffects: Array<{ idx: number; deps?: readonly unknown[]; fn: () => void | (() => void) }>
  prevDeps: Map<number, readonly unknown[] | undefined>
  cleanups: Map<number, () => void>
}

const hooks = vi.hoisted((): { state: HookRuntime } => ({
  state: {
    slots: [],
    cursor: 0,
    dirty: false,
    layoutEffects: [],
    passiveEffects: [],
    prevDeps: new Map(),
    cleanups: new Map(),
  },
}))

function depsChanged(
  prev: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined,
): boolean {
  if (!prev || !next || prev.length !== next.length) return true
  for (let i = 0; i < prev.length; i += 1) {
    if (!Object.is(prev[i], next[i])) return true
  }
  return false
}

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>()
  return {
    ...actual,
    useState: <T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] => {
      const idx = hooks.state.cursor++
      if (!(idx in hooks.state.slots)) {
        hooks.state.slots[idx] = typeof initial === "function" ? (initial as () => T)() : initial
      }
      const setState = (next: T | ((prev: T) => T)) => {
        const prev = hooks.state.slots[idx] as T
        const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next
        if (!Object.is(prev, resolved)) {
          hooks.state.slots[idx] = resolved
          hooks.state.dirty = true
        }
      }
      return [hooks.state.slots[idx] as T, setState]
    },
    useRef: <T>(initial: T): { current: T } => {
      const idx = hooks.state.cursor++
      if (!(idx in hooks.state.slots)) {
        hooks.state.slots[idx] = { current: initial }
      }
      return hooks.state.slots[idx] as { current: T }
    },
    useMemo: <T>(factory: () => T, deps: readonly unknown[]): T => {
      const idx = hooks.state.cursor++
      const existing = hooks.state.slots[idx] as { value: T; deps: readonly unknown[] } | undefined
      if (!existing || depsChanged(existing.deps, deps)) {
        hooks.state.slots[idx] = { value: factory(), deps }
      }
      return (hooks.state.slots[idx] as { value: T }).value
    },
    useLayoutEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => {
      const idx = hooks.state.cursor++
      hooks.state.layoutEffects.push({ idx, deps, fn })
    },
    useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => {
      const idx = hooks.state.cursor++
      hooks.state.passiveEffects.push({ idx, deps, fn })
    },
  }
})

import {
  buildCursorBitmapCacheKey,
  cursorBitmapReferenceScale,
  CursorMotionBlurCanvas,
  preloadCursorMotionBitmap,
} from "./cursor-motion-blur-canvas"

function resetHooks() {
  for (const cleanup of hooks.state.cleanups.values()) cleanup()
  hooks.state.slots = []
  hooks.state.cursor = 0
  hooks.state.dirty = false
  hooks.state.layoutEffects = []
  hooks.state.passiveEffects = []
  hooks.state.prevDeps.clear()
  hooks.state.cleanups.clear()
}

function flushHookEffects() {
  for (const eff of [...hooks.state.layoutEffects, ...hooks.state.passiveEffects]) {
    const prev = hooks.state.prevDeps.get(eff.idx)
    if (!hooks.state.prevDeps.has(eff.idx) || depsChanged(prev, eff.deps)) {
      hooks.state.cleanups.get(eff.idx)?.()
      const cleanup = eff.fn()
      if (typeof cleanup === "function") {
        hooks.state.cleanups.set(eff.idx, cleanup)
      } else {
        hooks.state.cleanups.delete(eff.idx)
      }
      hooks.state.prevDeps.set(eff.idx, eff.deps)
    }
  }
}

const sampleAsset: CursorAsset = {
  id: "shape-arrow",
  label: "Arrow",
  viewBox: "0 0 24 24",
  width: 24,
  height: 24,
  hotspotX: 4,
  hotspotY: 4,
  isCenterHotspot: false,
  svg: "<path d='M4 4 L12 20 L14 13 L20 11 Z' />",
}

describe("cursor motion blur bitmap cache & canvas", () => {
  let imageLoads = 0
  const putImageDataCalls: Array<{ data: Uint8ClampedArray; width: number; height: number }> = []

  beforeEach(() => {
    resetHooks()
    imageLoads = 0
    putImageDataCalls.length = 0

    vi.stubGlobal("window", { devicePixelRatio: 1 })

    class MockImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      naturalWidth = 64
      naturalHeight = 64
      set src(_value: string) {
        imageLoads += 1
        queueMicrotask(() => {
          this.onload?.()
        })
      }
    }
    vi.stubGlobal("Image", MockImage)

    vi.stubGlobal("document", {
      createElement: (tag: string) => {
        if (tag !== "canvas") return {}
        return {
          width: 0,
          height: 0,
          getContext: () => ({
            clearRect: vi.fn(),
            drawImage: vi.fn(),
            getImageData: (_x: number, _y: number, w: number, h: number) => {
              const data = new Uint8ClampedArray(w * h * 4)
              for (let i = 0; i < data.length; i += 4) {
                data[i] = 240
                data[i + 1] = 245
                data[i + 2] = 255
                data[i + 3] = 255
              }
              return { data, width: w, height: h }
            },
          }),
        }
      },
    })
  })

  afterEach(() => {
    resetHooks()
    vi.unstubAllGlobals()
  })

  it("keeps bitmap cache keys stable across live zoom scale changes when unzoomedScale is fixed", () => {
    const asset = sampleAsset
    const markup = "<path d='M0 0 L10 10 Z' />"
    const settingsAt1 = { ...defaultCursorSettings, style: "default" }
    const unzoomedScale = 1.2

    const refAtZoom1 = cursorBitmapReferenceScale(unzoomedScale)
    const refAtZoom25 = cursorBitmapReferenceScale(unzoomedScale)
    expect(refAtZoom1).toBe(refAtZoom25)

    const key1 = buildCursorBitmapCacheKey(asset.id, markup, settingsAt1, refAtZoom1, 1)
    const key2 = buildCursorBitmapCacheKey(asset.id, markup, settingsAt1, refAtZoom25, 1)
    expect(key1).toBe(key2)

    const keyDifferentScale = buildCursorBitmapCacheKey(
      asset.id,
      markup,
      settingsAt1,
      cursorBitmapReferenceScale(2.4),
      1,
    )
    expect(keyDifferentScale).not.toBe(key1)
  })

  it("deduplicates concurrent preloads and hits the bitmap cache synchronously on first render", async () => {
    const asset = sampleAsset
    const markup = "<path d='M0 0 L12 16 Z' />"
    const testSettings = { ...defaultCursorSettings, fillColor: "#fe2c55" }

    // Trigger two concurrent preloads before either settles to exercise `pendingLoads`.
    await Promise.all([
      preloadCursorMotionBitmap(asset, markup, testSettings, 1.0, 1),
      preloadCursorMotionBitmap(asset, markup, testSettings, 1.0, 1),
    ])
    expect(imageLoads).toBe(1)

    const fakeOutputCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        createImageData: (w: number, h: number) => ({
          data: new Uint8ClampedArray(w * h * 4),
          width: w,
          height: h,
        }),
        putImageData: (imageData: { data: Uint8ClampedArray; width: number; height: number }) => {
          putImageDataCalls.push(imageData)
        },
      }),
    }

    hooks.state.cursor = 0
    hooks.state.layoutEffects = []
    hooks.state.passiveEffects = []

    const element = CursorMotionBlurCanvas({
      asset,
      cursorMarkup: markup,
      cursorSettings: testSettings,
      baseScale: 1.5,
      unzoomedScale: 1.0,
      opacity: 1,
      samples: [
        { x: 100, y: 100, zoomScale: 1.5, weight: 0.5 },
        { x: 136, y: 112, zoomScale: 1.5, weight: 0.5 },
      ],
      containerWidth: 960,
      containerHeight: 540,
      fallback: createElement("div", { "data-testid": "svg-fallback" }),
    })

    // First synchronous render returns the <canvas>, never the fallback SVG.
    expect(element).not.toBeNull()
    expect(element?.type).toBe("canvas")

    const canvasProps = element?.props as { ref?: { current: HTMLCanvasElement | null } }
    if (canvasProps.ref) {
      canvasProps.ref.current = fakeOutputCanvas as unknown as HTMLCanvasElement
    }
    flushHookEffects()

    expect(putImageDataCalls).toHaveLength(1)
    const painted = putImageDataCalls[0]
    let maxAlpha = 0
    for (let i = 3; i < painted.data.length; i += 4) {
      if (painted.data[i] > maxAlpha) maxAlpha = painted.data[i]
    }
    expect(maxAlpha).toBeGreaterThan(200)
  })
})
