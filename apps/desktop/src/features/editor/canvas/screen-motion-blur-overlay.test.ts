import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ScreenMotionBlurStrip } from "@recordforge/editor-core"

interface HookRuntime {
  slots: unknown[]
  cursor: number
  dirty: boolean
  layoutEffects: Array<{ idx: number; deps?: readonly unknown[]; fn: () => void | (() => void) }>
  passiveEffects: Array<{ idx: number; deps?: readonly unknown[]; fn: () => void | (() => void) }>
  prevDeps: Map<number, readonly unknown[] | undefined>
  cleanups: Map<number, () => void>
}

const hooks = vi.hoisted((): { state: HookRuntime; rerenderQueue: number } => ({
  state: {
    slots: [],
    cursor: 0,
    dirty: false,
    layoutEffects: [],
    passiveEffects: [],
    prevDeps: new Map(),
    cleanups: new Map(),
  },
  rerenderQueue: 0,
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
    useCallback: <T extends (...args: never[]) => unknown>(fn: T, deps: readonly unknown[]): T => {
      const idx = hooks.state.cursor++
      const existing = hooks.state.slots[idx] as { fn: T; deps: readonly unknown[] } | undefined
      if (!existing || depsChanged(existing.deps, deps)) {
        hooks.state.slots[idx] = { fn, deps }
      }
      return (hooks.state.slots[idx] as { fn: T }).fn
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
  ScreenMotionBlurOverlay,
  type ScreenMotionBlurOverlayProps,
} from "./screen-motion-blur-overlay"

interface MockContext2d {
  drawImageCalls: number
  clearRectCalls: number
  globalAlpha: number
  globalCompositeOperation: string
  imageSmoothingEnabled: boolean
  imageSmoothingQuality: string
  save: () => void
  restore: () => void
  clearRect: () => void
  drawImage: () => void
}

interface MockWebGlContext {
  VERTEX_SHADER: number
  FRAGMENT_SHADER: number
  COMPILE_STATUS: number
  LINK_STATUS: number
  ARRAY_BUFFER: number
  STATIC_DRAW: number
  TEXTURE_2D: number
  TEXTURE_WRAP_S: number
  TEXTURE_WRAP_T: number
  CLAMP_TO_EDGE: number
  TEXTURE_MIN_FILTER: number
  TEXTURE_MAG_FILTER: number
  LINEAR: number
  FLOAT: number
  TEXTURE0: number
  UNPACK_FLIP_Y_WEBGL: number
  RGBA: number
  UNSIGNED_BYTE: number
  COLOR_BUFFER_BIT: number
  TRIANGLE_STRIP: number
  NO_ERROR: number
  drawArraysCalls: number
  isContextLost: () => boolean
  createShader: () => object
  shaderSource: () => void
  compileShader: () => void
  getShaderParameter: () => boolean
  deleteShader: () => void
  createProgram: () => object
  attachShader: () => void
  linkProgram: () => void
  getProgramParameter: () => boolean
  deleteProgram: () => void
  createBuffer: () => object
  deleteBuffer: () => void
  createTexture: () => object
  deleteTexture: () => void
  bindBuffer: () => void
  bufferData: () => void
  bindTexture: () => void
  texParameteri: () => void
  useProgram: () => void
  getAttribLocation: () => number
  enableVertexAttribArray: () => void
  vertexAttribPointer: () => void
  getUniformLocation: () => object
  viewport: () => void
  clearColor: () => void
  clear: () => void
  activeTexture: () => void
  pixelStorei: () => void
  texImage2D: () => void
  uniform1i: () => void
  uniform4f: () => void
  drawArrays: () => void
  getError: () => number
}

interface MockCanvas {
  width: number
  height: number
  style: { opacity: string }
  contextRequests: Array<{ type: string; options: unknown }>
  listeners: Map<string, Set<EventListener>>
  getContext: (type: string, options?: unknown) => unknown
  addEventListener: (event: string, listener: EventListener) => void
  removeEventListener: (event: string, listener: EventListener) => void
  dispatch: (event: string) => void
}

function createMockGl(options: { throwOnUpload?: boolean } = {}): MockWebGlContext {
  const gl: MockWebGlContext = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    TEXTURE_2D: 7,
    TEXTURE_WRAP_S: 8,
    TEXTURE_WRAP_T: 9,
    CLAMP_TO_EDGE: 10,
    TEXTURE_MIN_FILTER: 11,
    TEXTURE_MAG_FILTER: 12,
    LINEAR: 13,
    FLOAT: 14,
    TEXTURE0: 15,
    UNPACK_FLIP_Y_WEBGL: 16,
    RGBA: 17,
    UNSIGNED_BYTE: 18,
    COLOR_BUFFER_BIT: 19,
    TRIANGLE_STRIP: 20,
    NO_ERROR: 0,
    drawArraysCalls: 0,
    isContextLost: () => false,
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    deleteShader: () => {},
    createProgram: () => ({}),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    deleteProgram: () => {},
    createBuffer: () => ({}),
    deleteBuffer: () => {},
    createTexture: () => ({}),
    deleteTexture: () => {},
    bindBuffer: () => {},
    bufferData: () => {},
    bindTexture: () => {},
    texParameteri: () => {},
    useProgram: () => {},
    getAttribLocation: () => 0,
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    getUniformLocation: () => ({}),
    viewport: () => {},
    clearColor: () => {},
    clear: () => {},
    activeTexture: () => {},
    pixelStorei: () => {},
    texImage2D: () => {
      if (options.throwOnUpload) {
        throw new Error("Simulated WebGL upload failure")
      }
    },
    uniform1i: () => {},
    uniform4f: () => {},
    drawArrays: () => {
      gl.drawArraysCalls += 1
    },
    getError: () => 0,
  }
  return gl
}

function createMockCtx2d(): MockContext2d {
  const ctx: MockContext2d = {
    drawImageCalls: 0,
    clearRectCalls: 0,
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    imageSmoothingEnabled: true,
    imageSmoothingQuality: "low",
    save: () => {},
    restore: () => {},
    clearRect: () => {
      ctx.clearRectCalls += 1
    },
    drawImage: () => {
      ctx.drawImageCalls += 1
    },
  }
  return ctx
}

function createMockCanvas(gl: MockWebGlContext | null, ctx2d: MockContext2d): MockCanvas {
  const listeners = new Map<string, Set<EventListener>>()
  const canvas: MockCanvas = {
    width: 0,
    height: 0,
    style: { opacity: "" },
    contextRequests: [],
    listeners,
    getContext: (type: string, options?: unknown) => {
      canvas.contextRequests.push({ type, options })
      if (type === "webgl2") return null
      if (type === "webgl" || type === "experimental-webgl") return gl
      if (type === "2d") return ctx2d
      return null
    },
    addEventListener: (event: string, listener: EventListener) => {
      const set = listeners.get(event) ?? new Set<EventListener>()
      set.add(listener)
      listeners.set(event, set)
    },
    removeEventListener: (event: string, listener: EventListener) => {
      listeners.get(event)?.delete(listener)
    },
    dispatch: (event: string) => {
      const evt = { preventDefault: vi.fn() } as unknown as Event
      for (const listener of listeners.get(event) ?? []) {
        listener(evt)
      }
    },
  }
  return canvas
}

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

function mountWithHarness(
  props: ScreenMotionBlurOverlayProps,
  canvasForKey: (key: string | null) => MockCanvas,
) {
  let activeKey: string | null = null
  let currentElement: ReturnType<typeof ScreenMotionBlurOverlay> = null
  const mountedCanvases: Array<{ key: string | null; canvas: MockCanvas }> = []

  function flushEffects() {
    const all = [...hooks.state.layoutEffects, ...hooks.state.passiveEffects]
    for (const eff of all) {
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

  function renderOnce() {
    hooks.state.cursor = 0
    hooks.state.dirty = false
    hooks.state.layoutEffects = []
    hooks.state.passiveEffects = []
    currentElement = ScreenMotionBlurOverlay(props)
    if (currentElement && typeof currentElement === "object") {
      const elProps = currentElement.props as {
        ref?: { current: HTMLCanvasElement | null }
      }
      const nextKey = currentElement.key ?? null
      if (nextKey !== activeKey) {
        activeKey = nextKey
        const mockCanvas = canvasForKey(nextKey)
        mountedCanvases.push({ key: nextKey, canvas: mockCanvas })
        if (elProps.ref) {
          elProps.ref.current = mockCanvas as unknown as HTMLCanvasElement
        }
      }
    }
    flushEffects()
  }

  function flush(): ReturnType<typeof ScreenMotionBlurOverlay> {
    let passes = 0
    do {
      renderOnce()
      passes += 1
    } while (hooks.state.dirty && passes < 6)
    return currentElement
  }

  return {
    flush,
    getMountedCanvases: () => mountedCanvases,
  }
}

const sampleStrip: ScreenMotionBlurStrip = {
  start: [0.1, 0.1, 0.8, 0.8],
  end: [0.2, 0.2, 0.6, 0.6],
  taps: 8,
  sweepPx: 48,
  vectorPx: { x: 24, y: 12 },
}

function createSurfaceRef() {
  const fakeVideo = {
    style: { visibility: "visible" },
    readyState: 4,
    videoWidth: 1920,
    videoHeight: 1080,
    paused: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
  const fakeSurface = {
    querySelectorAll: () => [fakeVideo],
  } as unknown as HTMLDivElement
  return { current: fakeSurface }
}

const origWindow = globalThis.window
const origRaf = globalThis.requestAnimationFrame
const origCancelRaf = globalThis.cancelAnimationFrame

describe("ScreenMotionBlurOverlay", () => {
  beforeEach(() => {
    resetHooks()
    vi.stubGlobal("window", {
      devicePixelRatio: 1,
      requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn(),
    })
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    )
    vi.stubGlobal("cancelAnimationFrame", vi.fn())
  })

  afterEach(() => {
    resetHooks()
    vi.unstubAllGlobals()
    if (origWindow !== undefined) globalThis.window = origWindow
    if (origRaf !== undefined) globalThis.requestAnimationFrame = origRaf
    if (origCancelRaf !== undefined) globalThis.cancelAnimationFrame = origCancelRaf
  })

  it("requests preserveDrawingBuffer: true on WebGL and draws through WebGL by default", () => {
    const gl = createMockGl()
    const ctx2d = createMockCtx2d()
    const webglCanvas = createMockCanvas(gl, ctx2d)
    const harness = mountWithHarness(
      {
        enabled: true,
        strip: sampleStrip,
        surfaceRef: createSurfaceRef(),
        videoBounds: { left: 0, top: 0, width: 960, height: 540, scale: 0.5, canvasScale: 0.5 },
      },
      () => webglCanvas,
    )

    const el = harness.flush()
    expect(el?.key).toBe("webgl")
    expect((el?.props as Record<string, unknown>)["data-blur-backend"]).toBe("webgl")

    const webglReq = webglCanvas.contextRequests.find((req) => req.type === "webgl")
    expect(webglReq?.options).toMatchObject({ preserveDrawingBuffer: true })
    expect(gl.drawArraysCalls).toBe(1)
    expect(ctx2d.drawImageCalls).toBe(0)
  })

  it("remounts a clean canvas2d element and draws when WebGL texImage2D throws", () => {
    const failingGl = createMockGl({ throwOnUpload: true })
    const glCanvas = createMockCanvas(failingGl, createMockCtx2d())
    const ctx2dFallback = createMockCtx2d()
    const canvas2dElement = createMockCanvas(null, ctx2dFallback)

    const harness = mountWithHarness(
      {
        enabled: true,
        strip: sampleStrip,
        surfaceRef: createSurfaceRef(),
        videoBounds: { left: 0, top: 0, width: 960, height: 540, scale: 0.5, canvasScale: 0.5 },
      },
      (key) => (key === "canvas2d" ? canvas2dElement : glCanvas),
    )

    const el = harness.flush()
    expect(el?.key).toBe("canvas2d")
    expect((el?.props as Record<string, unknown>)["data-blur-backend"]).toBe("canvas2d")
    expect(harness.getMountedCanvases().map((item) => item.key)).toEqual(["webgl", "canvas2d"])
    expect(ctx2dFallback.drawImageCalls).toBeGreaterThan(0)
  })

  it("switches to a remounted canvas2d element cleanly when webglcontextlost fires", () => {
    const gl = createMockGl()
    const glCanvas = createMockCanvas(gl, createMockCtx2d())
    const ctx2dFallback = createMockCtx2d()
    const canvas2dElement = createMockCanvas(null, ctx2dFallback)

    const harness = mountWithHarness(
      {
        enabled: true,
        strip: sampleStrip,
        surfaceRef: createSurfaceRef(),
        videoBounds: { left: 0, top: 0, width: 960, height: 540, scale: 0.5, canvasScale: 0.5 },
      },
      (key) => (key === "canvas2d" ? canvas2dElement : glCanvas),
    )

    const initialEl = harness.flush()
    expect(initialEl?.key).toBe("webgl")

    glCanvas.dispatch("webglcontextlost")
    const nextEl = harness.flush()
    expect(nextEl?.key).toBe("canvas2d")
    expect((nextEl?.props as Record<string, unknown>)["data-blur-backend"]).toBe("canvas2d")
    expect(ctx2dFallback.drawImageCalls).toBeGreaterThan(0)
  })
})
