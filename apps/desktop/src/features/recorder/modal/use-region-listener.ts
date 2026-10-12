import { useEffect } from "react"
import { listen } from "@tauri-apps/api/event"
import type { Bounds } from "@recordforge/contracts"
import { boundsSchema } from "@recordforge/contracts"
import { useRecorderStore } from "../../../hooks/use-recorder"

// The region picker is a separate fullscreen Tauri window; its selection
// arrives as a `region-selected` event in absolute physical coordinates.
export function useRegionListener(active: boolean) {
  const setSelectedSource = useRecorderStore((state) => state.setSelectedSource)

  useEffect(() => {
    if (!active) return
    let unlisten: (() => void) | undefined
    let running = true

    listen<{ bounds: unknown }>("region-selected", (event) => {
      const parsed = boundsSchema.safeParse(event.payload?.bounds)
      if (!parsed.success) return
      const bounds: Bounds = parsed.data
      setSelectedSource({
        kind: "region",
        id: `region-${bounds.x}-${bounds.y}-${bounds.width}-${bounds.height}`,
        name: `Region ${bounds.width}×${bounds.height}`,
        bounds,
      })
    }).then((fn) => {
      if (running) unlisten = fn
      else fn()
    })

    return () => {
      running = false
      unlisten?.()
    }
  }, [active, setSelectedSource])
}
