import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  thumbnailManifestSchema,
  waveformDataSchema,
  type MediaAudioTrackOutput,
  type MediaVideoTrackOutput,
  type ThumbnailManifest,
  type WaveformData,
} from "@recordforge/contracts"
import { z } from "zod"
import { toAssetUrl, resolveAssetPath, isAbsolutePath, isWebUrl } from "../../../lib/assets"

export { toAssetUrl, resolveAssetPath, isAbsolutePath, isWebUrl }

export type DerivativeResource<T> =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "content"; data: T }
  | { status: "error"; message: string }

function derivativeError(): string {
  return "Failed to load derivative resource from disk"
}

// Derivative JSON is fetched through Tauri's scoped asset protocol, so the
// editor never decodes the full recording just to render timeline metadata.
async function fetchDerivative<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const assetUrl = toAssetUrl(path)
  if (!assetUrl) throw new Error(derivativeError())

  const response = await fetch(assetUrl)
  if (!response.ok) throw new Error(derivativeError())

  const data = (await response.json()) as unknown
  const parsed = schema.safeParse(data)
  if (!parsed.success) throw new Error(derivativeError())

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

    fetchDerivative(path, schema)
      .then((data) => {
        if (isMounted) setResource({ status: "content", data })
      })
      .catch(() => {
        if (isMounted) {
          setResource({ status: "error", message: derivativeError() })
        }
      })

    return () => {
      isMounted = false
    }
  }, [path, schema, retryToken])

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
  const requestsKey = useMemo(
    () => requests.map((request) => `${request.streamIndex}:${request.path}`).join("|"),
    [requests],
  )
  const lastRequestsKeyRef = useRef("")
  const lastRetryTokenRef = useRef(0)

  const [retryToken, setRetryToken] = useState(0)
  const [byStream, setByStream] = useState<Map<number, DerivativeResource<WaveformData>>>(
    () => new Map(),
  )
  const retry = useCallback(() => setRetryToken((value) => value + 1), [])

  useEffect(() => {
    // Avoid refetching when only the array identity changes; content and retry
    // intent are the real triggers.
    if (requestsKey === lastRequestsKeyRef.current && retryToken === lastRetryTokenRef.current) {
      return
    }
    lastRequestsKeyRef.current = requestsKey
    lastRetryTokenRef.current = retryToken

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
  }, [requests, requestsKey, retryToken])

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

export interface VideoTrackThumbnailResources {
  byStream: Map<number, DerivativeResource<ThumbnailManifest>>
  status: DerivativeResource<null>["status"]
  retry: () => void
}

export function useVideoTrackThumbnailResources(
  outputs: MediaVideoTrackOutput[],
): VideoTrackThumbnailResources {
  const requests = useMemo(
    () =>
      outputs
        .filter((output) => Boolean(output.thumbnailManifestPath))
        .map((output) => ({
          streamIndex: output.streamIndex,
          path: output.thumbnailManifestPath as string,
        })),
    [outputs],
  )
  const requestsKey = useMemo(
    () => requests.map((request) => `${request.streamIndex}:${request.path}`).join("|"),
    [requests],
  )
  const lastRequestsKeyRef = useRef("")
  const lastRetryTokenRef = useRef(0)

  const [retryToken, setRetryToken] = useState(0)
  const [byStream, setByStream] = useState<Map<number, DerivativeResource<ThumbnailManifest>>>(
    () => new Map(),
  )
  const retry = useCallback(() => setRetryToken((value) => value + 1), [])

  useEffect(() => {
    if (requestsKey === lastRequestsKeyRef.current && retryToken === lastRetryTokenRef.current) {
      return
    }
    lastRequestsKeyRef.current = requestsKey
    lastRetryTokenRef.current = retryToken

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
      requests.map(async (request): Promise<[number, DerivativeResource<ThumbnailManifest>]> => {
        try {
          const data = await fetchDerivative(request.path, thumbnailManifestSchema)
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
  }, [requests, requestsKey, retryToken])

  const status = useMemo<VideoTrackThumbnailResources["status"]>(() => {
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
