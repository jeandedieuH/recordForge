import { memo, useEffect, useLayoutEffect, useMemo, useRef } from "react"
import type { TimelineClip } from "@recordforge/contracts"
import type { ThumbnailManifest } from "../media/derivative-resources"
import { useSpriteImage } from "../media/sprite-cache"
import { fitCanvas, resolveThemeColor, rgba } from "./clip-canvas"
import {
  clipSourceTimeMs,
  filmstripFrameIndex,
  filmstripTileWidth,
  visibleClipWindow,
} from "./derivative-render"

interface ThumbnailFilmstripProps {
  clip: TimelineClip
  manifest: ThumbnailManifest
  spriteUrl: string
  pixelsPerMs: number
  visibleStartMs: number
  visibleEndMs: number
  height: number
  onSpriteError?: () => void
}

/**
 * Canvas filmstrip renderer. Tiles keep a constant on-screen pitch derived
 * from the clip height; each tile samples the sprite frame owning its center
 * time. Zooming out decimates frames, zooming in repeats them — the strip
 * stays coherent at every zoom level and never stretches a frame.
 */
export const ThumbnailFilmstrip = memo(function ThumbnailFilmstrip({
  clip,
  manifest,
  spriteUrl,
  pixelsPerMs,
  visibleStartMs,
  visibleEndMs,
  height,
  onSpriteError,
}: ThumbnailFilmstripProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { image, failed } = useSpriteImage(spriteUrl)
  const onSpriteErrorRef = useRef(onSpriteError)
  onSpriteErrorRef.current = onSpriteError

  useEffect(() => {
    if (failed) onSpriteErrorRef.current?.()
  }, [failed])

  // Memoized so the draw effect can depend on the window object itself;
  // visibleClipWindow returns a fresh { startMs, endMs } each render.
  const clipWindow = useMemo(
    () => visibleClipWindow(clip, visibleStartMs, visibleEndMs),
    [clip, visibleStartMs, visibleEndMs],
  )

  // Draw before paint: resizing the canvas clears it, so a post-paint effect
  // would flash blank during zoom gestures.
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !image || !clipWindow) return

    const cssW = (clipWindow.endMs - clipWindow.startMs) * pixelsPerMs
    const ctx = fitCanvas(canvas, cssW, height)
    if (!ctx) return

    const columns = Math.max(1, manifest.columns)
    const rows = Math.max(1, manifest.rows)
    const cellW = image.naturalWidth / columns
    const cellH = image.naturalHeight / rows
    if (cellW <= 0 || cellH <= 0) return

    const tileW = filmstripTileWidth(height, cellW / cellH)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = "high"
    // Slightly dimmed so clip labels and handles stay readable on top.
    ctx.globalAlpha = 0.88

    const divider = resolveThemeColor(canvas, "--color-background")
    const dividerColor = divider ? rgba(divider, 0.45) : null

    let prevIndex = -1
    for (let x = 0; x < cssW - 0.5; x += tileW) {
      const w = Math.min(tileW, cssW - x)
      const centerMs = clipWindow.startMs + (x + w / 2) / pixelsPerMs
      const index = filmstripFrameIndex(
        clipSourceTimeMs(clip, centerMs),
        manifest.intervalMs,
        manifest.count,
      )
      if (index < 0) break

      // Cover-crop the sprite cell to the tile aspect so frames fill the
      // strip without distortion.
      const srcAspect = cellW / cellH
      const dstAspect = w / height
      let sw = cellW
      let sh = cellH
      if (srcAspect > dstAspect) {
        sw = cellH * dstAspect
      } else {
        sh = cellW / dstAspect
      }
      const sx = (index % columns) * cellW + (cellW - sw) / 2
      const sy = Math.floor(index / columns) * cellH + (cellH - sh) / 2
      ctx.drawImage(image, sx, sy, sw, sh, x, 0, w, height)

      // Hairline only where the sampled frame actually changes — the divider
      // density then honestly communicates the available frame resolution.
      if (dividerColor && prevIndex !== -1 && index !== prevIndex) {
        ctx.fillStyle = dividerColor
        ctx.fillRect(x - 0.5, 0, 1, height)
      }
      prevIndex = index
    }
  }, [clip, clipWindow, height, image, manifest, pixelsPerMs])

  if (!clipWindow) return null

  const widthPx = (clipWindow.endMs - clipWindow.startMs) * pixelsPerMs
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute top-0"
      style={{
        left: (clipWindow.startMs - clip.startMs) * pixelsPerMs,
        width: widthPx,
        height,
      }}
    />
  )
})
