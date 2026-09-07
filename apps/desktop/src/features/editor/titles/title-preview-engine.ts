import type { OverlayRenderPlan } from "@recordforge/contracts"
import { createOverlayWasmEngine, type OverlayEngine } from "@recordforge/overlay-core"

interface EngineEntry {
  promise: Promise<OverlayEngine>
  users: number
}

// Shared only while mounted/visible. No title content or glyphs survive in persistent storage.
const engines = new Map<string, EngineEntry>()
let stopActivePreview: (() => void) | undefined

export function acquireTitlePreviewEngine(plan: OverlayRenderPlan) {
  const key = JSON.stringify(plan)
  let entry = engines.get(key)
  if (!entry) {
    entry = { promise: createOverlayWasmEngine(plan), users: 0 }
    engines.set(key, entry)
  }
  entry.users += 1
  const retained = entry
  let released = false
  return {
    engine: retained.promise,
    release() {
      if (released) return
      released = true
      retained.users -= 1
      if (retained.users > 0) return
      if (engines.get(key) === retained) engines.delete(key)
      void retained.promise.then(
        (engine) => engine.dispose(),
        () => undefined,
      )
    },
  }
}

/** Even two open browsers must never run competing hover/replay animation loops. */
export function claimTitlePreviewPlayback(stop: () => void): () => void {
  stopActivePreview?.()
  stopActivePreview = stop
  return () => {
    if (stopActivePreview === stop) stopActivePreview = undefined
    stop()
  }
}
