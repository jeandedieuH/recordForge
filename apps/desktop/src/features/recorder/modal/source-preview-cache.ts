import type { CaptureSource } from "@recordforge/contracts"
import { captureSourcePreviews } from "../../../lib/recorder"

// Session-level cache of preview still paths, keyed by the exact capture
// rectangle. Populated by prefetching every display when the setup dialog
// opens, so switching monitors is instant instead of paying an FFmpeg spawn
// per selection.
const previewPaths = new Map<string, string>()
// The in-flight prefetch, so a card that mounts during it waits instead of
// asking for the same still a second time.
let inflightPrefetch: Promise<void> | null = null

/** Stable identity of a capture target, matching the native cache key. */
export function sourcePreviewKey(source: CaptureSource): string {
  const { kind, id, bounds } = source
  return `${kind}:${id}:${bounds.x},${bounds.y},${bounds.width}x${bounds.height}`
}

/** Path of a known preview, `null` when known-unavailable, `undefined` when unknown. */
export function peekSourcePreview(source: CaptureSource): string | null | undefined {
  return previewPaths.get(sourcePreviewKey(source))
}

export function rememberSourcePreview(source: CaptureSource, path: string | null): void {
  const key = sourcePreviewKey(source)
  if (path) previewPaths.set(key, path)
  else previewPaths.delete(key)
}

/** Resolves once the current prefetch (if any) has settled. */
export function settleSourcePreviews(): Promise<void> {
  return inflightPrefetch ?? Promise.resolve()
}

/**
 * Warm the stills for sources the dialog can switch to, in one native call.
 *
 * Failures are silent — each card still requests its own still on demand — and
 * unavailable sources are left uncached so a later dialog open can retry.
 */
export function prefetchSourcePreviews(sources: CaptureSource[]): Promise<void> {
  const unique = new Map<string, CaptureSource>()
  for (const source of sources) unique.set(sourcePreviewKey(source), source)
  if (unique.size === 0) return Promise.resolve()

  const list = [...unique.values()]
  inflightPrefetch = captureSourcePreviews(list)
    .then((paths) => {
      list.forEach((source, index) => rememberSourcePreview(source, paths[index] ?? null))
    })
    .catch(() => {
      // Ignore: the individual cards handle their own failures.
    })
    .finally(() => {
      inflightPrefetch = null
    })
  return inflightPrefetch
}
