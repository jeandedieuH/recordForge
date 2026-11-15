import { useEffect, useRef, useState, type RefObject } from "react"

/**
 * Native OS file drop for one element.
 *
 * Tauri intercepts drops at the webview level and reports filesystem *paths*
 * (not `File` handles), so an HTML5 `onDrop` never sees files dragged from
 * Explorer/Finder. This hook registers the webview drag-drop listener, scopes it
 * to `targetRef`'s rect, and reports the dropped paths plus the drop position in
 * physical pixels (Tauri's coordinate space).
 *
 * Returns whether a drag is currently hovering the element so callers can render
 * a drop highlight. Outside Tauri (browser dev) it is a no-op.
 */
export function useTauriFileDrop(
  targetRef: RefObject<HTMLElement | null>,
  onDropPaths: (paths: string[], position: { x: number; y: number }) => void,
): boolean {
  const [isDragging, setIsDragging] = useState(false)
  // Latest callback without re-registering the native listener on every render.
  const onDropPathsRef = useRef(onDropPaths)
  onDropPathsRef.current = onDropPaths

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false

    function isOverTarget(position: { x: number; y: number }): boolean {
      const rect = targetRef.current?.getBoundingClientRect()
      if (!rect) return false
      const ratio = window.devicePixelRatio || 1
      return (
        position.x >= rect.left * ratio &&
        position.x <= rect.right * ratio &&
        position.y >= rect.top * ratio &&
        position.y <= rect.bottom * ratio
      )
    }

    try {
      import("@tauri-apps/api/webview")
        .then(({ getCurrentWebview }) =>
          getCurrentWebview().onDragDropEvent((event) => {
            const payload = event.payload
            if (payload.type === "enter" || payload.type === "over") {
              setIsDragging(isOverTarget(payload.position))
              return
            }
            if (payload.type === "drop") {
              setIsDragging(false)
              if (!isOverTarget(payload.position)) return
              if (payload.paths.length > 0) {
                onDropPathsRef.current(payload.paths, payload.position)
              }
              return
            }
            setIsDragging(false)
          }),
        )
        .then((fn) => {
          if (cancelled) fn()
          else unlisten = fn
        })
        .catch(() => {})
    } catch {
      // Browser dev mode: no native drop bridge.
    }

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [targetRef])

  return isDragging
}
