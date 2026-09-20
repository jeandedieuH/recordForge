import { useEffect, useState } from "react"

// Thumbnail sprites are shared by every clip on a track, so loads are
// deduplicated through a module-level cache keyed by asset URL.
const spriteCache = new Map<string, Promise<HTMLImageElement>>()

export function loadSpriteImage(url: string): Promise<HTMLImageElement> {
  const cached = spriteCache.get(url)
  if (cached) return cached

  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.decoding = "async"
    image.onload = () => resolve(image)
    image.onerror = () => {
      // Drop failed entries so a retry after a transient asset-protocol
      // failure can reload instead of replaying the rejection.
      spriteCache.delete(url)
      reject(new Error("sprite image failed to load"))
    }
    image.src = url
  })
  spriteCache.set(url, promise)
  return promise
}

export interface SpriteImageState {
  image: HTMLImageElement | null
  failed: boolean
}

export function useSpriteImage(url: string | null): SpriteImageState {
  const [state, setState] = useState<SpriteImageState>({ image: null, failed: false })

  useEffect(() => {
    if (!url) {
      setState({ image: null, failed: false })
      return
    }
    let alive = true
    loadSpriteImage(url).then(
      (image) => {
        if (alive) setState({ image, failed: false })
      },
      () => {
        if (alive) setState({ image: null, failed: true })
      },
    )
    return () => {
      alive = false
    }
  }, [url])

  return state
}
