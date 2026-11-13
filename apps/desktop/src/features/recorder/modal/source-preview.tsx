import { useEffect, useState, type ReactNode } from "react"
import { RotateCw } from "lucide-react"
import { IconButton, Skeleton } from "@recordforge/ui"
import type { CaptureSource } from "@recordforge/contracts"
import { captureSourcePreview } from "../../../lib/recorder"
import { toAssetUrl } from "../../../lib/assets"
import { isTauri } from "../../../lib/settings"
import {
  peekSourcePreview,
  rememberSourcePreview,
  settleSourcePreviews,
} from "./source-preview-cache"

type PreviewState = "loading" | "ready" | "unavailable"

interface SourcePreviewProps {
  source: CaptureSource | null
  aspectRatio: number
  /** Rendered when no still is available: the schematic fallback. */
  fallback: ReactNode
  alt: string
}

// Real still of the capture target, grabbed once per selection on the native
// side. A preview must never block the dialog or fail a start, so every
// non-ready state falls back to the schematic card.
export function SourcePreview({ source, aspectRatio, fallback, alt }: SourcePreviewProps) {
  // Start in `loading` when a source already exists so the schematic never
  // flashes before the still arrives (the effect runs one paint later).
  const [state, setState] = useState<PreviewState>(source ? "loading" : "unavailable")
  const [url, setUrl] = useState<string | null>(null)
  // Bumped by the refresh button to bypass the native cache.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!source || !isTauri()) {
      setState("unavailable")
      setUrl(null)
      return
    }
    let cancelled = false

    const adopt = (path: string) => {
      const asset = toAssetUrl(path)
      if (!asset) {
        setState("unavailable")
        return
      }
      // Same path can be regenerated for the same source, so bust the
      // webview's image cache per mount.
      setUrl(`${asset}${asset.includes("?") ? "&" : "?"}t=${Date.now()}`)
      setState("ready")
    }

    // Prefetched when the dialog opened: adopt it without an IPC round-trip.
    if (attempt === 0) {
      const cached = peekSourcePreview(source)
      if (cached) {
        adopt(cached)
        return
      }
    }

    setState("loading")
    setUrl(null)

    void (async () => {
      // A prefetch may still be in flight for this source; wait for it rather
      // than spawning a second grab for the same file.
      if (attempt === 0) {
        await settleSourcePreviews()
        if (cancelled) return
        const settled = peekSourcePreview(source)
        if (settled) {
          adopt(settled)
          return
        }
      }

      try {
        const path = await captureSourcePreview(source, attempt > 0)
        if (cancelled) return
        rememberSourcePreview(source, path)
        if (!path) {
          setState("unavailable")
          return
        }
        adopt(path)
      } catch {
        if (!cancelled) setState("unavailable")
      }
    })()

    return () => {
      cancelled = true
    }
  }, [source, attempt])

  return (
    <div
      className="group relative flex max-h-56 w-full items-center justify-center overflow-hidden rounded-lg border border-border bg-surface-dim"
      style={{ aspectRatio }}
    >
      {state === "ready" && url ? (
        <img
          src={url}
          alt={alt}
          className="h-full w-full object-contain"
          onError={() => setState("unavailable")}
        />
      ) : state === "loading" ? (
        <Skeleton className="absolute inset-0 rounded-none" />
      ) : (
        <>
          <div
            className="pointer-events-none absolute inset-3 rounded-md border border-border-strong/50"
            aria-hidden
          />
          {fallback}
        </>
      )}

      {state === "ready" ? (
        <div className="absolute top-1.5 right-1.5 opacity-0 transition-opacity duration-fast group-focus-within:opacity-100 group-hover:opacity-100">
          <IconButton
            label="Refresh preview"
            onClick={() => setAttempt((value) => value + 1)}
            className="size-7 bg-surface/90 text-muted-foreground backdrop-blur hover:text-foreground"
          >
            <RotateCw className="size-3.5" />
          </IconButton>
        </div>
      ) : null}
    </div>
  )
}
