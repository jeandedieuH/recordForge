import { useCallback, useEffect, useMemo, useState } from "react"
import { convertFileSrc } from "@tauri-apps/api/core"
import {
  thumbnailManifestSchema,
  waveformDataSchema,
  type MediaAudioTrackOutput,
  type ThumbnailManifest,
  type WaveformData,
} from "@recordforge/contracts"
import { z } from "zod"
import { isTauri } from "../../../lib/settings"

export type DerivativeResource<T> =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "content"; data: T }
  | { status: "error"; message: string }

export function toAssetUrl(path: string | null): string | null {
  if (!path) return null
  return isTauri() ? convertFileSrc(path) : path
}

function derivativeError(): string {
  return "This derivative could not be loaded. Retry to try again."
}

// Derivative JSON is fetched through Tauri's scoped asset protocol, so the
// editor never decodes the full recording just to render timeline metadata.
async function fetchDerivative<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const url = toAssetUrl(path)
  if (!url) throw new Error("Derivative path is unavailable")

  const response = await fetch(url)
  if (!response.ok) throw new Error(`Derivative request failed with status ${response.status}`)

  const parsed = schema.safeParse(await response.json())
  if (!parsed.success) throw new Error("Derivative data did not match its contract")
  return parsed.data
}

export function useDerivativeResource<T>(
  path: string | null,
  schema: z.ZodType<T>,
): DerivativeResource<T> & { retry: () => void } {
  const [retryToken, setRetryToken] = useState(0)
  const [resource, setResource] = useState<DerivativeResource<T>>(() =>
    path ? { status: "loading" } : { status: "missing" },
  )

  const retry = useCallback(() => setRetryToken((value) => value + 1), [])

  useEffect(() => {
    let isMounted = true
    if (!path) {
      setResource({ status: "missing" })
      return () => {
        isMounted = false
      }
    }

    setResource({ status: "loading" })
    void fetchDerivative(path, schema)
      .then((data) => {
        if (isMounted) setResource({ status: "content", data })
      })
      .catch(() => {
        if (isMounted) setResource({ status: "error", message: derivativeError() })
      })

    return () => {
      isMounted = false
    }
  }, [path, retryToken, schema])

  return { ...resource, retry }
}

export function useThumbnailManifest(path: string | null) {
  return useDerivativeResource(path, thumbnailManifestSchema)
}

export interface WaveformResources {
  byStream: Map<number, DerivativeResource<WaveformData>>
  status: DerivativeResource<null>["status"]
  retry: () => void
}

export function useWaveformResources(outputs: MediaAudioTrackOutput[]): WaveformResources {
  const requests = useMemo(
    () =>
      outputs.map((output) => ({
        streamIndex: output.streamIndex,
        path: output.waveformPath,
      })),
    [outputs],
  )
  const [retryToken, setRetryToken] = useState(0)
  const [byStream, setByStream] = useState<Map<number, DerivativeResource<WaveformData>>>(
    () => new Map(),
  )
  const retry = useCallback(() => setRetryToken((value) => value + 1), [])

  useEffect(() => {
    let isMounted = true
    if (requests.length === 0) {
      setByStream(new Map())
      return () => {
        isMounted = false
      }
    }

    setByStream(
      new Map(requests.map((request) => [request.streamIndex, { status: "loading" as const }])),
    )

    void Promise.all(
      requests.map(async (request): Promise<[number, DerivativeResource<WaveformData>]> => {
        try {
          const data = await fetchDerivative(request.path, waveformDataSchema)
          return [request.streamIndex, { status: "content", data }]
        } catch {
          return [request.streamIndex, { status: "error", message: derivativeError() }]
        }
      }),
    ).then((entries) => {
      if (isMounted) setByStream(new Map(entries))
    })

    return () => {
      isMounted = false
    }
  }, [requests, retryToken])

  const status = useMemo<WaveformResources["status"]>(() => {
    if (requests.length === 0) return "missing"
    const states = [...byStream.values()]
    if (states.length === 0 || states.some((state) => state.status === "loading")) return "loading"
    if (states.some((state) => state.status === "content")) return "content"
    if (states.some((state) => state.status === "error")) return "error"
    return "missing"
  }, [byStream, requests.length])

  return { byStream, status, retry }
}

export type { ThumbnailManifest, WaveformData }
